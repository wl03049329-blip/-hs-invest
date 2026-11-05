"""Descriptive event paths and dated radar fields, NOT a forecast or buy score."""
import argparse,pathlib,math,statistics,subprocess
from base import *
from engine import features,thresholds,quantile,avg
from simulator import events
from study import ci,corr

def empirical_rank(value,past):
    if value is None or not past:return None
    return 100*(sum(x<value for x in past)+.5*sum(x==value for x in past))/len(past)
def radar_features(rows):
    panel=features(rows)
    for i,x in enumerate(panel):
        x['return5']=(x['close']/rows[i-5]['close']-1) if i>=5 else None
        for h in [120,240]:x['dd'+str(h)]=x['close']/max(r['close'] for r in rows[i-h+1:i+1])-1 if i>=h-1 else None
    return panel
def market_panel(rows):
    result={};levels=[];previous=rows[0]['close'];level=previous
    for i,r in enumerate(rows):
        if i:level*=(r['close']+r.get('cash_dividend',0))/previous
        previous=r['close'];levels.append(level);ma=avg(levels[i-199:i+1]) if i>=199 else None;prior_ma=avg(levels[i-204:i-4]) if i>=204 else None
        state='UNKNOWN' if prior_ma is None else 'BULL' if level>ma and ma>prior_ma else 'BEAR' if level<ma and ma<prior_ma else 'RANGE'
        result[r['date']]={'date':r['date'],'regime':state,'index':level,'MA200':ma,'MA200_prior5':prior_ma,'basis':'Official split-adjusted0050 plus gross ex-date cash distribution in an indicator index, not a cash reinvestment trade.'}
    return result
def wilson(k,n):
    if not n:return None
    assert 0<=k<=n;z=1.959963984540054;p=k/n;den=1+z*z/n;center=(p+z*z/(2*n))/den;half=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den
    return [max(0,center-half),min(1,center+half)]
def path(panel,event,h):
    i=event['i'];r=panel[i];last=i+h
    if last>=len(panel):return {'event':event['id'],'date':r['date'],'horizon':h,'status':'PENDING_INCOMPLETE_PATH','available_future_sessions':len(panel)-1-i}
    window=panel[i+1:last+1];low=min(x['low'] for x in window);maxclose=max(x['close'] for x in window);open_=window[0]['open'];ex=panel[last+1]['open'] if last+1<len(panel) else None
    net=ex*(1-.001)*(1-.001425-.001)/(open_*(1+.001)*(1+.001425))-1 if ex is not None else None
    return {'event':event['id'],'date':r['date'],'horizon':h,'status':'COMPLETE_PATH' if ex is not None else 'PATH_COMPLETE_EXIT_OPEN_PENDING','path_end':panel[last]['date'],'entry_open_date':window[0]['date'],'exit_open_date':panel[last+1]['date'] if ex is not None else None,'close_return':panel[last]['close']/r['close']-1,'net_next_open_return':net,'min_low':low,'further_break':int(low<r['low']),'further_break_depth':min(0,low/r['low']-1),'low_vs_entry_open':low/open_-1,'max_close_rebound':maxclose/r['close']-1,'max_high_vs_entry':max(x['high'] for x in window)/open_-1,'end_below_trigger_close':int(panel[last]['close']<r['close']),'never_recovered_trigger_close':int(maxclose<r['close']),'first_close_recovery_session':next((j+1 for j,x in enumerate(window) if x['close']>=r['close']),None),'label_only_future_values_not_features':True}
def distribution(rows,key):
    good=[x for x in rows if x.get(key) is not None];xs=[x[key] for x in good]
    return {'n':len(xs),'q':{str(q):quantile(xs,q) for q in [.05,.25,.5,.75,.95]},'minimum':min(xs,default=None),'maximum':max(xs,default=None),'mean':avg(xs),'year_block_CI':ci(good,key),'evidence':'DESCRIPTIVE_SMALL_SAMPLE' if len(xs)<30 else 'DESCRIPTIVE_NOT_INDEPENDENT_OOS'}
def frequency(rows,key):
    good=[x for x in rows if x.get(key) is not None];n=len(good);k=sum(x[key] for x in good)
    return {'n':n,'count':k,'historical_fraction':k/n if n else None,'wilson_descriptive_CI95':wilson(k,n),'year_block_CI95':ci(good,key)['mean_CI95'],'not_a_forecast':True,'independence_assumption_unverified':True}
def group_summary(rows):
    return {**{k:distribution(rows,k) for k in ['close_return','net_next_open_return','further_break_depth','low_vs_entry_open','max_close_rebound','max_high_vs_entry']},**{k:frequency(rows,k) for k in ['further_break','end_below_trigger_close','never_recovered_trigger_close']}}
def make_snapshot(panel,market,review):
    x=panel[-1];past=[r for r in panel if r['date'][:4]<x['date'][:4]];vs=[r['velocity'] for r in past if r['velocity'] and r['velocity']>0];rank=empirical_rank(x['velocity'],vs);ranks={}
    for h in [120,240]:
        key='dd'+str(h);hist=[-r[key] for r in past if r[key] is not None];ranks[key]={'drawdown':x[key],'historical_depth_percentile':empirical_rank(-x[key],hist) if x[key] is not None else None,'training_n':len(hist)}
    current_market=market.get(x['date']);breakout=x['close']>x['prior_high5'] if x['prior_high5'] is not None else None
    return {'schema':'HS_LC4_RESEARCH_RADAR_SNAPSHOT_V1','asof':x['date'],'not_live':True,'training_end':past[-1]['date'] if past else None,'training_start':past[0]['date'] if past else None,'opportunity':{'return5':x['return5'],'crash_velocity_pct_per_session':x['velocity'],'positive_decline_percentile':rank,'training_positive_days':len(vs),'description':'急跌速度位於歷史高分位（不代表進場）' if rank is not None and rank>=95 else '五日未呈淨下跌' if x['return5'] is not None and x['return5']>=0 else '一般急跌觀察','drawdown':ranks,'not_a_buy_score':True},'market':current_market or {'date':None,'regime':'UNKNOWN','reason':'NO_MATCHING0050_SESSION_DO_NOT_FORWARD_FILL'},'stabilization':{'close':x['close'],'prior5_high':x['prior_high5'],'breakout_observed':breakout,'description':'已突破前五日高（僅觀察）' if breakout else '尚未突破前五日高' if breakout is False else '觀察資料不足'},'data':{'research_copy':'VERIFIED_OFFICIAL_RECONSTRUCTION','verified_date':review['asof'],'ohlc_rows':review['rows'],'conflicts_preserved':222,'omissions_preserved':14,'source_vintage':'2026 capture, historical as-published archives unavailable','formal_shadow':'FAIL_CLOSED_UNCHANGED','cached_incidents':7,'canonical_incidents':8,'live_data_verification':'NOT_PERFORMED'},'entry':{'authorized':False,'state':'NOT_APPROVED','reason':'研究狀態不等同進場資格；沒有正式L-C4買點或加碼級距'},'writer':False,'score':None,'tiers':None,'predictive_probability':None}
def run(out):
    guard(out);review=load(out/'data-review.json');panel=radar_features(load(out/'research-copy-00631L.json')['rows']);market=market_panel(load(P1/'adjusted-0050.json')['rows']);ev=events(panel);assert [r['id'] for r in ev]==[r['id'] for r in load(P2/'events.json')]
    allpaths=[]
    for event in ev:
        for h in P['horizons']:
            row=path(panel,event,h);row.update({'common_mature':event['mature'],'market0050':market.get(event['date'],{}).get('regime','UNKNOWN'),'trigger_velocity':event['velocity'],'trigger_dd20':event['dd20'],'trigger_dd120':panel[event['i']]['dd120'],'trigger_dd240':panel[event['i']]['dd240']});allpaths.append(row)
    primary=[r for r in allpaths if r['common_mature'] and r.get('close_return') is not None];summary={}
    for h in P['horizons']:
        rs=[r for r in primary if r['horizon']==h];available=[r for r in allpaths if r['horizon']==h and r.get('close_return') is not None]
        summary[str(h)]={'common_mature':group_summary(rs),'available_case':group_summary(available),'by0050_environment':{reg:group_summary([r for r in rs if r['market0050']==reg]) for reg in ['BULL','BEAR','RANGE','UNKNOWN']},'associations':{key:{'close_return':corr([r[key] for r in rs if r[key] is not None],[r['close_return'] for r in rs if r[key] is not None]),'max_close_rebound':corr([r[key] for r in rs if r[key] is not None],[r['max_close_rebound'] for r in rs if r[key] is not None])} for key in ['trigger_velocity','trigger_dd20','trigger_dd120','trigger_dd240']}}
    comparison={k:v for k,v in load(P2/'all-models.json').items() if k.endswith('|TIME20')};assert len(comparison)==4
    snapshot=make_snapshot(panel,market,review);dump(out/'event-paths.json',allpaths);dump(out/'distributions.json',summary);dump(out/'risk-comparison-reused.json',{'source_commit':BASE,'source_sha256':sha((P2/'all-models.json').read_bytes()),'no_new_strategies_or_selection':True,'models':comparison});dump(out/'radar-snapshot.json',snapshot)
    result={'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'events':len(ev),'common_mature':sum(r['mature'] for r in ev),'horizons':P['horizons'],'event_regimes':dict(__import__('collections').Counter(market.get(e['date'],{}).get('regime','UNKNOWN') for e in ev if e['mature'])),'snapshot_asof':snapshot['asof'],'opportunity_not_permission':True,'new_trading_strategies':0,'prediction_validated':False,'score':None,'writer':False};dump(out/'analysis-receipt.json',result);guard(out);print(json.dumps(result))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',required=True);run(pathlib.Path(p.parse_args().out).resolve())
