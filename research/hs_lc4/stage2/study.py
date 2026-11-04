"""Fixed stage2 research; every result and comparison, never automatic winner."""
import argparse,pathlib,json,random,statistics,itertools,math,subprocess
from common import *
from simulator import *
from engine import baseline,quantile,avg

def ci(items,key,seed=631):
    rows=[r for r in items if r.get(key) is not None];groups={}
    for r in rows:groups.setdefault(r['date'][:4],[]).append(r[key])
    if not rows:return {'n':0,'years':0,'mean':None,'median':None,'mean_CI95':None,'median_CI95':None}
    years=list(groups);rng=random.Random(seed);means=[];medians=[]
    for _ in range(2000):
        xs=[v for y in rng.choices(years,k=len(years)) for v in groups[y]];means.append(avg(xs));medians.append(statistics.median(xs))
    return {'n':len(rows),'years':len(years),'mean':avg([r[key] for r in rows]),'median':statistics.median(r[key] for r in rows),'mean_CI95':[quantile(means,.025),quantile(means,.975)],'median_CI95':[quantile(medians,.025),quantile(medians,.975)],'method':'Year-block resampling2000, selected history and few dependent blocks; descriptive not confirmatory.'}
def paired(a,b):
    x={r['id']:r for r in a['event_outcomes'] if r['mature']};y={r['id']:r for r in b['event_outcomes'] if r['mature']};assert set(x)==set(y)
    return [{'date':x[k]['date'],'event':k,'difference':x[k]['slot_return']-y[k]['slot_return']} for k in sorted(x)]
def signflip(rows):
    groups={}
    for r in rows:groups.setdefault(r['date'][:4],[]).append(r['difference'])
    xs=[sum(v) for v in groups.values()];n=len(rows)
    if not n:return 1.
    observed=abs(sum(xs)/n);dist=[abs(sum(v*s for v,s in zip(xs,signs))/n) for signs in itertools.product([-1,1],repeat=len(xs))]
    return sum(x>=observed-1e-14 for x in dist)/len(dist)
def holm(rows):
    order=sorted(range(len(rows)),key=lambda i:rows[i]['p_raw']);prev=0.
    for rank,i in enumerate(order):prev=max(prev,min(1.,(len(rows)-rank)*rows[i]['p_raw']));rows[i]['p_holm']=prev;rows[i]['family_size']=len(rows)
    return rows
def contrast(a,b,label):
    rows=paired(a,b);return {'model':a['model']['id'],'reference':b['model']['id'],'type':label,'paired':ci(rows,'difference'),'p_raw':signflip(rows),'assumption':'Exact yearly block sign symmetry, not guaranteed independent/symmetric regimes; already inspected history.'}
def rank(xs):
    return [avg([j+1 for j,v in enumerate(sorted(xs)) if v==x]) for x in xs]
def corr(xs,ys):
    a=rank(xs);b=rank(ys);ma=avg(a);mb=avg(b);den=math.sqrt(sum((x-ma)**2 for x in a)*sum((y-mb)**2 for y in b));return sum((x-ma)*(y-mb) for x,y in zip(a,b))/den if den else None
def opportunity(panel,run_):
    th=thresholds(panel);events_=run_['event_outcomes'];rows=[]
    for r in events_:
        if not r['mature']:continue
        training=[x['velocity'] for x in panel if x['date'][:4]<r['date'][:4] and x['velocity'] and x['velocity']>0];percentile=sum(v<=r['velocity'] for v in training)/len(training)
        rows.append({**r,'training_percentile':percentile,'extreme975':percentile>=.975,'deep':r['dd20']<=th[int(r['date'][:4])]['deep']})
    bins={}
    for key in ['extreme975','deep']:
        bins[key]={str(v):ci([r for r in rows if r[key]==v],'slot_return') for v in [False,True]}
    return {'n':len(rows),'bins':bins,'velocity_rank_association':corr([r['training_percentile'] for r in rows],[r['slot_return'] for r in rows]),'drawdown_rank_association':corr([-r['dd20'] for r in rows],[r['slot_return'] for r in rows]),'rows':rows,'formal_score':'WITHHELD','weights':'NOT_FITTED','warning':'Conditional C95 selected events only, not a population probability or0-100 calibration; few dependent events.'}

def run(out):
    check(out);data={s:load(P1/('adjusted-'+s+'.json'))['rows'] for s in ['00631L','0050']};panel=features(data['00631L']);ev=events(panel);dump(out/'events.json',ev);runs={};summary={};controls={}
    for m in models():
        r=simulate(panel,m,ev);runs[m['id']]=r
        summary[m['id']]={'metrics':r['metrics'],'trade_uncertainty':ci([{'date':t['trigger'],'return':t['net_return']} for t in r['trades']],'return'),'event_uncertainty':ci([x for x in r['event_outcomes'] if x['mature']],'slot_return'),'open_position':r['open_position'],'worst_events':sorted(r['trades'],key=lambda x:x['net_return'])[:3],'worst_MAE_events':sorted(r['trades'],key=lambda x:x['mae'])[:3],'cost_sensitivity':[],'cash_yield_sensitivity':[]}
        controls[m['id']]={s:control(rows,r['curve'])['metrics'] for s,rows in data.items()}
        for sl in P['cost']['stress_slippage']:
            summary[m['id']]['cost_sensitivity'].append({'slippage':sl,'metrics':simulate(panel,m,ev,slip=sl)['metrics']})
        for y in [.01,.02]:summary[m['id']]['cash_yield_sensitivity'].append({'yield':y,'metrics':simulate(panel,m,ev,yield_=y)['metrics']})
    dump(out/'all-runs.json',runs);dump(out/'all-models.json',summary);dump(out/'lagged-exposure-controls.json',controls)
    entries=[];exits=[];risk=[]
    for ex in P['exits']:
        ref=runs['NEXT_OPEN_FULL|'+ex]
        for entry in P['entries'][1:]:entries.append(contrast(runs[entry+'|'+ex],ref,'ENTRY_VS_IMMEDIATE_SAME_EXIT'))
    for entry in P['entries']:
        ref=runs[entry+'|TIME20']
        for ex in P['exits']:
            if ex!='TIME20':exits.append(contrast(runs[entry+'|'+ex],ref,'EXIT_VS_TIME20_SAME_ENTRY'))
        a=runs[entry+'|RISK_STOP10_BEAR_MA10_MAX40'];b=runs[entry+'|TIME40'];risk.append({'model':a['model']['id'],'reference':b['model']['id'],'paired':ci(paired(a,b),'difference'),'description':'Same max40 horizon, bundled risk effect only; descriptive no additional hypothesis-test claim.'})
    assert len(entries)==27 and len(exits)==32
    dump(out/'paired-comparisons.json',{'entry_family':holm(entries),'exit_family':holm(exits),'risk_same_horizon':risk})
    bench={s:{'buy_hold_full':baseline(rows,'2018',1),'buy_hold_initial10':baseline(rows,'2018',.1),'constant10_next_open':control(rows)['metrics']} for s,rows in data.items()};dump(out/'benchmarks.json',bench)
    op=opportunity(panel,runs['NEXT_OPEN_FULL|TIME20']);dump(out/'opportunity.json',op)
    a90=simulate(panel,{'id':'A90_ROBUSTNESS','entry':'NEXT_OPEN_FULL','exit':'TIME20'},events(panel,'A90'));dump(out/'a90-robustness.json',{'metrics':a90['metrics'],'events':a90['event_outcomes'],'uncertainty':ci([x for x in a90['event_outcomes'] if x['mature']],'slot_return'),'scope':'One prespecified descriptive robustness check, not another model search.'})
    receipt={'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'protocol_sha256':sha((HERE/'protocol.json').read_bytes()),'base':BASE,'stage1_source_manifest_sha':sha((P1/'source-manifest.json').read_bytes()),'stage1_dataset_sha':sha((P1/'dataset-manifest.json').read_bytes()),'models':36,'events':len(ev),'mature_events':sum(x['mature'] for x in ev),'fresh_OOS':False,'formal_score':False,'official_shadow_recovery':False,'writer':False,'capital':False};dump(out/'study-receipt.json',receipt);check(out);print(json.dumps(receipt))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',required=True);run(pathlib.Path(p.parse_args().out).resolve())
