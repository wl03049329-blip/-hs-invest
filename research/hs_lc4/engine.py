"""Isolated chronological research, never imported by the production app.

All decisions use completed bars; every order fills at a subsequent actual open.
No trading, financial storage, original research or network writes.
"""
from __future__ import annotations
import argparse,itertools,json,math,pathlib,statistics,random
from datetime import date
from capture import ROOT,dump,sha,seal
P=json.loads((ROOT/'research/hs_lc4/protocol.json').read_text(encoding='utf8'))
CAP=P['capital_twd'];RISK=P['tactical_cap'];FEE=P['friction']['commission_each_side'];TAX=P['friction']['sell_tax']

def quantile(xs,p):
    xs=sorted(xs)
    if not xs:return None
    z=(len(xs)-1)*p;i=int(z);j=math.ceil(z);return xs[i]+(xs[j]-xs[i])*(z-i)
def avg(xs):return sum(xs)/len(xs) if xs else None
def features(rows):
    c=[r['close'] for r in rows];result=[]
    for i,r in enumerate(rows):
        v=max(0,1-c[i]/c[i-5])*20 if i>=5 else None
        dd=(c[i]/max(c[max(0,i-19):i+1])-1)*100 if i>=19 else None
        ma=sum(c[i-199:i+1])/200 if i>=199 else None
        old=sum(c[i-204:i-4])/200 if i>=204 else None
        regime='UNCLASSIFIED' if old is None else 'BULL' if c[i]>ma and ma>old else 'BEAR' if c[i]<ma and ma<old else 'TRANSITION'
        result.append({**r,'i':i,'velocity':v,'dd20':dd,'ma10':avg(c[i-9:i+1]) if i>=9 else None,'prior_high5':max(x['high'] for x in rows[i-5:i]) if i>=5 else None,'regime':regime})
    return result
def thresholds(panel):
    return {year:{'A90':quantile([x['velocity'] for x in panel if int(x['date'][:4])<year and x['velocity'] and x['velocity']>0],.9),
                  'C95':quantile([x['velocity'] for x in panel if int(x['date'][:4])<year and x['velocity'] and x['velocity']>0],.95),
                  'deep':quantile([x['dd20'] for x in panel if int(x['date'][:4])<year and x['dd20'] is not None],.2)}
            for year in sorted({int(x['date'][:4]) for x in panel if x['date']>='2018'})}
def candidates():
    return [{'id':'|'.join(x),'opportunity':x[0],'entry':x[1],'add':x[2],'exit':x[3]} for x in itertools.product(P['opportunity'],P['first_entry'],P['addition'],P['exits'])]
def signals(panel,t,m):
    a=[];last=-999
    for x in panel:
        y=int(x['date'][:4]);th=t.get(y);ok=bool(th and x['velocity'] is not None and x['velocity']>=th['C95' if m['opportunity'].startswith('C95') else 'A90'])
        if m['opportunity']=='C95_AND_DEEP20':ok=ok and x['dd20'] is not None and x['dd20']<=th['deep']
        a.append(bool(ok and x['i']-last>3))
        if ok:last=x['i']
    return a
def horizon(m):return 60 if '60' in m['exit'] else 20 if m['exit']=='TIME20' else 40

def simulate(panel,model=None,choices=None,start='2018-01-01',end=None,signal_end=None,slip=.001,cash_yield=0,excluded_trigger_years=()):
    """Optional annual choices are fixed before their fold; active policy carries over."""
    ts=thresholds(panel);models=candidates();modelmap={m['id']:m for m in models};sigs={}
    chosen=[model] if model else [modelmap[v] for v in set(choices.values()) if v]
    for m in chosen:sigs[m['id']]=signals(panel,ts,m)
    ids=[i for i,r in enumerate(panel) if r['date']>=start and (end is None or r['date']<=end)];assert ids
    cash=float(CAP);q=0.;pos=None;pending=None;waiting=None;trades=[];orders=[];curve=[];lastday=panel[ids[0]]['date'];previous_nav=CAP;capbreaches=0;maxexp=0.;worstlow=CAP;peak=CAP;lowdd=0.
    for i in ids:
        r=panel[i];day=r['date'];elapsed=(date.fromisoformat(day)-date.fromisoformat(lastday)).days;cash*=(1+cash_yield)**(elapsed/365.25);lastday=day
        m=model if model else modelmap.get(choices.get(int(day[:4])))
        if pending and pending['at']==i:
            kind=pending['kind'];assert pending['decision_i']<i,'SAME_BAR_FILL'
            if kind=='EXIT':
                proceeds=q*r['open']*(1-slip)*(1-FEE-TAX);cash+=proceeds
                ret=(proceeds-pos['cost'])/pos['cost'];trades.append({**pos,'exit_date':day,'exit_i':i,'exit_reason':pending['reason'],'net_return':ret,'pnl':proceeds-pos['cost'],'held':i-pos['entry_i']});q=0.;pos=None
            else:
                if kind=='ENTRY':
                    pos={'model':pending['model']['id'],'policy':pending['model'],'trigger':panel[pending['trigger_i']]['date'],'trigger_i':pending['trigger_i'],'entry_date':day,'entry_i':i,'regime':r['regime'],'cost':0.,'budget_nav':cash,'first_open':r['open'],'tranches':0,'mae':0.,'mfe':0.,'peak_close':r['close']}
                nav=cash+q*r['open'];fraction=RISK if pos['policy']['add']=='NONE' else RISK/2
                room=max(0,RISK*nav-q*r['open']);budget=min(cash,pos['budget_nav']*fraction,room)
                units=budget/(r['open']*(1+slip)*(1+FEE));cost=units*r['open']*(1+slip)*(1+FEE)
                assert cost<=cash+.0001 and units>=0
                q+=units;cash-=cost;pos['cost']+=cost;pos['tranches']+=1
            orders.append({'kind':kind,'decision':panel[pending['decision_i']]['date'],'fill':day,'model':pending.get('model',{}).get('id',pos['model'] if pos else None),'cash_after':cash});pending=None
        nav=cash+q*r['close'];low=cash+q*r['low'];peak=max(peak,nav);lowdd=min(lowdd,low/peak-1);worstlow=min(worstlow,low)
        exp=q*r['close']/nav;maxexp=max(maxexp,exp)
        if exp>RISK+1e-8:capbreaches+=1
        curve.append({'date':day,'nav':nav,'low_nav':low,'exposure':exp,'invested':q*r['close']})
        if pos:
            pos['mae']=min(pos['mae'],(q*r['low']*(1-slip)*(1-FEE-TAX)-pos['cost'])/pos['cost']);pos['mfe']=max(pos['mfe'],(q*r['high']-pos['cost'])/pos['cost']);pos['peak_close']=max(pos['peak_close'],r['close']);pm=pos['policy'];h=horizon(pm)
            gain=r['close']/pos['first_open']-1;tr=pm['exit'];reason=None
            if i+1>=pos['entry_i']+h:reason='TIME'
            elif tr.startswith('STOP10') and (gain<=-.10 or gain>=.20):reason='STOP' if gain<0 else 'TAKE'
            elif tr.startswith('STOP15') and (gain<=-.15 or gain>=.30):reason='STOP' if gain<0 else 'TAKE'
            elif tr.startswith('TRAIL') and r['close']<=pos['peak_close']*.9:reason='TRAIL'
            elif tr.startswith('MA10') and r['ma10'] is not None and r['close']<r['ma10']:reason='MA10'
            if reason:pending={'kind':'EXIT','at':i+1,'decision_i':i,'reason':reason}
            elif pos['tranches']==1 and pm['add']!='NONE' and i>pos['entry_i']:
                add=pm['add']=='HALF_THEN_DOWN5' and r['close']<=pos['first_open']*.95 or pm['add']=='HALF_THEN_CONFIRM5' and r['prior_high5'] is not None and r['close']>r['prior_high5']
                if add:pending={'kind':'ADD','at':i+1,'decision_i':i}
        elif not pending:
            if waiting:
                wm=waiting['model'];age=i-waiting['trigger_i']
                enter=wm['entry']=='NEXT_OPEN' or wm['entry']=='DELAY_3' and age==3 or wm['entry']=='CONFIRM_HIGH_WITHIN_5' and age>=1 and r['prior_high5'] is not None and r['close']>r['prior_high5']
                if enter:pending={'kind':'ENTRY','at':i+1,'decision_i':i,**waiting};waiting=None
                elif age>=5:waiting=None
            if waiting is None and pending is None and m and int(day[:4]) not in excluded_trigger_years and (signal_end is None or i<=signal_end) and sigs[m['id']][i]:
                waiting={'model':m,'trigger_i':i}
                if m['entry']=='NEXT_OPEN':pending={'kind':'ENTRY','at':i+1,'decision_i':i,**waiting};waiting=None
        previous_nav=nav
    if pos:pos={**pos,'unrealized_pnl':q*panel[ids[-1]]['close']-pos['cost'],'censored':True}
    metrics=measure(curve,trades);years=max(1,(date.fromisoformat(curve[-1]['date'])-date.fromisoformat(curve[0]['date'])).days)/365.25
    metrics['capital_efficiency_note']='Includes cash carry; do not read yield scenarios as pure tactical alpha.'
    metrics['excess_return_over_all_cash']=curve[-1]['nav']/CAP-(1+cash_yield)**years
    metrics.update({'cap_breach_sessions':capbreaches,'max_close_exposure':maxexp,'intraday_portfolio_drawdown':lowdd,'open_position':pos is not None})
    return {'metrics':metrics,'trades':trades,'open_position':pos,'orders':orders,'curve':curve}

def measure(curve,trades):
    years=max(1,(date.fromisoformat(curve[-1]['date'])-date.fromisoformat(curve[0]['date'])).days)/365.25;peak=CAP;mdd=0
    for r in curve:peak=max(peak,r['nav']);mdd=min(mdd,r['nav']/peak-1)
    final=curve[-1]['nav'];rets=[t['net_return'] for t in trades];deploy_years=0
    for i in range(1,len(curve)):
        days=(date.fromisoformat(curve[i]['date'])-date.fromisoformat(curve[i-1]['date'])).days;deploy_years+=curve[i-1]['invested']*days/365.25
    return {'total_return':final/CAP-1,'CAGR':(final/CAP)**(1/years)-1,'max_drawdown':mdd,'closed_trades':len(trades),'win_rate':avg([int(x>0) for x in rets]),'mean_trade_return':avg(rets),'median_trade_return':statistics.median(rets) if rets else None,'worst_MAE':min([t['mae'] for t in trades],default=None),'mean_holding_sessions':avg([t['held'] for t in trades]),'average_exposure':avg([x['exposure'] for x in curve]),'capital_year_efficiency':(final-CAP)/deploy_years if deploy_years else None,'worst_trade':min(rets,default=None),'final_nav':final}

def baseline(rows,start,allocation,cash_yield=0,slip=.001):
    r=[x for x in rows if x['date']>=start];q=CAP*allocation/(r[0]['open']*(1+slip)*(1+FEE));cash=CAP*(1-allocation);curve=[];prev=r[0]['date']
    for i,x in enumerate(r):
        d=(date.fromisoformat(x['date'])-date.fromisoformat(prev)).days;cash*=(1+cash_yield)**(d/365.25);prev=x['date'];nav=cash+q*x['close'];curve.append({'date':x['date'],'nav':nav,'invested':q*x['close'],'exposure':q*x['close']/nav})
        if i>0 and x.get('cash_dividend'):
            cash+=q*x['cash_dividend'];curve[-1]['nav']=cash+q*x['close'];curve[-1]['exposure']=q*x['close']/curve[-1]['nav']
    # Liquidation haircut on the final mark is explicit; no simulated final trade label.
    curve[-1]['nav']=cash+q*r[-1]['close']*(1-slip)*(1-FEE-TAX)
    return measure(curve,[])

def bootstrap(trades):
    xs=[t['net_return'] for t in trades]
    if not xs:return None
    rng=random.Random(631);means=[avg([rng.choice(xs) for _ in xs]) for _ in range(2000)]
    return {'n':len(xs),'mean_CI95':[quantile(means,.025),quantile(means,.975)],'warning':'Episode resampling, not independent market-regime evidence; selected history and serial dependence remain.'}

def run(out):
    seal(out);manifest=json.loads((out/'dataset-manifest.json').read_text(encoding='utf8'));assert '00631L' in manifest,'QUALIFIED_00631L_REQUIRED'
    datasets={}
    for s,receipt in manifest.items():
        f=out/('adjusted-'+s+'.json');assert sha(f.read_bytes())==receipt['sha256'];datasets[s]=json.loads(f.read_text(encoding='utf8'))['rows']
    panel=features(datasets['00631L']);ms=candidates();assert len(ms)==162
    grid={};allruns={}
    for m in ms:
        r=simulate(panel,m);allruns[m['id']]=r;grid[m['id']]=r['metrics']
    dump(out/'all-models.json',grid);choices={};selection=[]
    for year in sorted({int(r['date'][:4]) for r in panel if r['date']>='2018'}):
        prior=[i for i,r in enumerate(panel) if int(r['date'][:4])<year];cut=prior[-1]-70;end=panel[prior[-1]]['date'];scores=[]
        if end>='2018':
            for m in ms:
                r=simulate(panel,m,end=end,signal_end=cut);metric=r['metrics']
                if metric['closed_trades']>=5 and not r['open_position']:
                    score=metric['CAGR']/max(abs(metric['max_drawdown']),.02);scores.append((score,0 if m['add']=='NONE' else -1,-horizon(m),m['id']))
        ranked=sorted(scores,key=lambda x:(-x[0],-x[1],-x[2],x[3]));choices[year]=ranked[0][3] if ranked else None
        selection.append({'year':year,'train_end':end,'last_signal_date':panel[cut]['date'],'candidates_eligible':len(ranked),'selected':choices[year],'score':ranked[0][0] if ranked else None})
    wf=simulate(panel,choices=choices);dump(out/'walk-forward.json',{'choices':selection,**wf})
    # Full-period descriptions are not used for selection. Never label the best hindsight model OOS.
    bestid=max(grid,key=lambda k:grid[k]['CAGR']);best=allruns[bestid];fixed=allruns['C95|NEXT_OPEN|NONE|TIME20']
    details={'nested_walk_forward':wf,'predeclared_C95_next_open_time20':fixed,'hindsight_best_NOT_A_RECOMMENDATION':best}
    dump(out/'selected-diagnostics.json',{k:{'metrics':v['metrics'],'trades':v['trades'],'open_position':v['open_position'],'bootstrap':bootstrap(v['trades']),'regimes':{reg:{'n':len(t:=[t for t in v['trades'] if t['regime']==reg]),'mean':avg([x['net_return'] for x in t]),'worst_MAE':min([x['mae'] for x in t],default=None)} for reg in ['BULL','BEAR','TRANSITION']},'leave_best_3_trade_pnl_out':sum(t['pnl'] for t in sorted(v['trades'],key=lambda x:x['pnl'],reverse=True)[3:])/CAP} for k,v in details.items()})
    stress=[]
    for slip,yield_ in itertools.product([.001,.0025,.005],[0,.01,.02]):
        stress.append({'slippage':slip,'cash_yield':yield_,'metrics':simulate(panel,choices=choices,slip=slip,cash_yield=yield_)['metrics'],'selection':'Choices frozen from base-cost prior-only selection; sensitivity is not re-selection.'})
    benchmarks={s:{str(a):baseline(rows,'2018-01-01',a) for a in [0,.1,1]} for s,rows in datasets.items()}
    full_period={'walk_forward':simulate(panel,choices=choices,start='2014-10-31')['metrics'],'benchmarks':{s:{str(a):baseline(rows,'2014-10-31',a) for a in [0,.1,1]} for s,rows in datasets.items()},'warning':'Training-only2014-2017 stays cash for tactics; B&H starts2014-10-31. Allocation.1 is entry notional cap, not a guarantee against later mark-to-market drift.'}
    summary={'schema':'HS_LC4_RESEARCH_RESULTS_V1','data':manifest,'protocol_sha256':sha((ROOT/'research/hs_lc4/protocol.json').read_bytes()),'models':162,'historical_selection_bias':'NOT_FRESH_OOS','walk_forward':wf['metrics'],'choices':selection,'hindsight_best':{'id':bestid,'metrics':best['metrics']},'fixed_reference':fixed['metrics'],'benchmarks':benchmarks,'stress':stress,'score_status':'WITHHELD_NO_VALIDATED_0_100_SCORE','complete_benchmark':len(datasets)==2,'production_signal':False,'production_writer':False}
    summary['full_period']=full_period;summary['benchmark_dividends']='Gross official cash distributions retained as cash on ex-date for valuation, no reinvestment, no investor-specific income tax/payment-date cash drag; initial acquisition and final liquidation frictions included.'
    summary['leave_crisis_year_out']={str(y):simulate(panel,choices=choices,excluded_trigger_years=(y,))['metrics'] for y in [2018,2020,2022,2024,2025,2026]}
    summary['exclusion_note']='Skip new episodes triggered in that year, fixed original fold choices; sensitivity only, not new independent validation or re-trained counterfactual.'
    summary['cash_only']={str(y):CAP*((1+y)**((date.fromisoformat(panel[-1]['date'])-date(2018,1,2)).days/365.25))/CAP-1 for y in [0,.01,.02]}
    dump(out/'summary.json',summary);seal(out);print(json.dumps({'status':'COMPUTED_RESEARCH_ONLY','models':162,'benchmark_complete':len(datasets)==2,'wf_closed_trades':wf['metrics']['closed_trades']}))
if __name__=='__main__':
    a=argparse.ArgumentParser();a.add_argument('--out',required=True);run(pathlib.Path(a.parse_args().out).resolve())
