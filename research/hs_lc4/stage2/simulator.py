"""Stage2 fixed policies; close decisions -> next actual open, no production use."""
import math,itertools,statistics
from datetime import date
from common import P
from engine import features,thresholds,signals,measure
CAP=P['capital_twd'];W=P['entry_cap_nav'];F=P['cost']['commission_each_side'];T=P['cost']['sell_tax']
def models():return [{'id':a+'|'+b,'entry':a,'exit':b} for a,b in itertools.product(P['entries'],P['exits'])]
def events(panel,opportunity='C95'):
    trained={y:t for y,t in thresholds(panel).items() if t[opportunity] is not None}
    sg=signals(panel,trained,{'opportunity':opportunity});out=[];last=-1000
    for i,x in enumerate(panel):
        if sg[i] and i>last+70:
            out.append({'id':'EVENT:'+x['date'],'i':i,'date':x['date'],'mature':i+70<len(panel),'velocity':x['velocity'],'dd20':x['dd20'],'regime':x['regime']});last=i
    return out
def horizon(m):return int(m['exit'][4:]) if m['exit'].startswith('TIME') and m['exit'][4:].isdigit() else 40
def stats(curve,trades):
    s=measure(curve,trades);s['flat_fraction']=sum(r['invested']<=1e-8 for r in curve)/len(curve);s['nonzero_sessions']=sum(r['invested']>1e-8 for r in curve)
    deployed=days=0.
    for a,b in zip(curve,curve[1:]):
        d=(date.fromisoformat(b['date'])-date.fromisoformat(a['date'])).days;days+=d
        if a['invested']<=1e-8:deployed+=d
    s['flat_calendar_fraction']=deployed/days if days else None
    s['max_exposure']=max(r['exposure'] for r in curve);s['over_cap_sessions']=sum(r['exposure']>W+1e-8 for r in curve);s['calmar']=s['CAGR']/abs(s['max_drawdown']) if s['max_drawdown'] else None
    s['annual']={};s['annual_details']={}
    for y in sorted({x['date'][:4] for x in curve}):
        ids=[i for i,x in enumerate(curve) if x['date'].startswith(y)];previous=curve[ids[0]-1]['nav'] if ids[0] else CAP;s['annual'][y]=curve[ids[-1]]['nav']/previous-1
        peak=previous;dd=0
        for i in ids:peak=max(peak,curve[i]['nav']);dd=min(dd,curve[i]['nav']/peak-1)
        s['annual_details'][y]={'return':s['annual'][y],'max_drawdown':dd,'trades_entered':sum(t['entry_date'].startswith(y) for t in trades),'average_exposure':sum(curve[i]['exposure'] for i in ids)/len(ids)}
    s['blocks']={}
    for a,b in [(2018,2021),(2022,2024),(2025,2026)]:
        ids=[i for i,x in enumerate(curve) if a<=int(x['date'][:4])<=b]
        if not ids:continue
        initial=curve[ids[0]-1]['nav'] if ids[0] else CAP;peak=initial;mdd=0
        for i in ids:peak=max(peak,curve[i]['nav']);mdd=min(mdd,curve[i]['nav']/peak-1)
        years=(date.fromisoformat(curve[ids[-1]]['date'])-date.fromisoformat(curve[ids[0]]['date'])).days/365.25
        growth=curve[ids[-1]]['nav']/initial;cagr=growth**(1/years)-1 if years else None
        s['blocks'][f'{a}-{b}']={'return':growth-1,'CAGR':cagr,'max_drawdown':mdd,'calmar':cagr/abs(mdd) if mdd else None,'trades':sum(a<=int(t['entry_date'][:4])<=b for t in trades)}
    return s

def simulate(panel,m,ev=None,slip=.001,yield_=0,signal_cut=None,end=None):
    assert m['entry'] in P['entries'] and m['exit'] in P['exits'],'UNKNOWN_MODEL'
    assert all(math.isfinite(r[k]) and r[k]>0 for r in panel for k in ['open','high','low','close']),'INVALID_PRICE'
    assert all(a['date']<b['date'] for a,b in zip(panel,panel[1:])),'DATE_ORDER'
    ev=ev if ev is not None else events(panel);byi={x['i']:x for x in ev};cash=float(CAP);q=0.;pos=None;wait=None;pending=None;orders=[];trades=[];curve=[];first=next(x for x in panel if x['date']>='2018');lastday=first['date']
    for i,r in enumerate(panel):
        if r['date']<'2018' or end and r['date']>end:continue
        d=(date.fromisoformat(r['date'])-date.fromisoformat(lastday)).days;cash*=(1+yield_)**(d/365.25);lastday=r['date'];trimmed=False
        if pending:
            assert pending['decision_i']<i,'NO_SAME_BAR_FILL';kind=pending['kind'];amount=qty=0.;price=r['open']
            if kind in ['ENTRY','ADD']:
                if kind=='ENTRY':
                    pos={'event':pending['event']['id'],'trigger':pending['event']['date'],'event_i':pending['event']['i'],'entry_date':r['date'],'entry_i':i,'cost':0.,'proceeds':0.,'initial_nav':cash,'first_open':price,'tranches':0,'add_attempted':False,'mae':0.,'peak_close':r['close'],'regime':r['regime']}
                else:pos['add_attempted']=True
                fraction=pending['fraction'];nav=cash+q*price;budget=min(cash,pos['initial_nav']*W*fraction,max(0,W*nav-q*price));qty=budget/(price*(1+slip)*(1+F));amount=qty*price*(1+slip)*(1+F);cash-=amount;q+=qty;pos['cost']+=amount
                if qty>1e-12:pos['tranches']+=1
            else:
                if kind=='EXIT':qty=q
                else:
                    nav=cash+q*price;fric=1-(1-slip)*(1-F-T);qty=min(q,max(0,(q*price-W*nav)/(price*(1-W*fric))));trimmed=True
                amount=qty*price*(1-slip)*(1-F-T);cash+=amount;q-=qty;pos['proceeds']+=amount
            orders.append({'kind':kind,'decision':panel[pending['decision_i']]['date'],'fill':r['date'],'quantity':qty,'cash_flow':-amount if kind in ['ENTRY','ADD'] else amount,'cash_after':cash,'event':pos['event'],'reason':pending.get('reason')})
            if kind=='EXIT':
                assert abs(q)<1e-8;pos.update({'exit_date':r['date'],'exit_i':i,'held':i-pos['entry_i'],'pnl':pos['proceeds']-pos['cost'],'net_return':pos['proceeds']/pos['cost']-1,'reason':pending['reason']});trades.append(pos);pos=None;q=0.
            pending=None
        assert cash>=-.001 and q>=-1e-8,'CASH_OR_UNITS_NEGATIVE'
        nav=cash+q*r['close'];exp=q*r['close']/nav;curve.append({'date':r['date'],'nav':nav,'invested':q*r['close'],'exposure':exp})
        if pos:
            assert pos['cost']>0 and pos['tranches']<=2
            net=(pos['proceeds']+q*r['close']*(1-slip)*(1-F-T))/pos['cost']-1;pos['mae']=min(pos['mae'],(pos['proceeds']+q*r['low']*(1-slip)*(1-F-T))/pos['cost']-1);pos['peak_close']=max(pos['peak_close'],r['close']);held=i-pos['entry_i']+1;reason=None;x=m['exit']
            if i+1>=pos['entry_i']+horizon(m):reason='TIME'
            elif x=='TAKE20_STOP15_MAX40' and (net>=.20 or net<=-.15):reason='TAKE20' if net>=.20 else 'STOP15'
            elif x=='TRAIL10_MAX40' and r['close']<=pos['peak_close']*.9:reason='TRAIL10'
            elif x=='TIME_STOP10_MAX40' and held>=10 and net<=0:reason='TIME_STOP10'
            elif x=='RISK_STOP10_BEAR_MA10_MAX40' and (net<=-.10 or r['regime']=='BEAR' and r['ma10'] and r['close']<r['ma10']):reason='RISK_EXIT'
            if reason:pending={'kind':'EXIT','decision_i':i,'reason':reason}
            elif exp>W+1e-8:pending={'kind':'TRIM','decision_i':i,'reason':'COMMON_EXPOSURE_CAP'}
            elif pos['tranches']==1 and not pos['add_attempted'] and not trimmed and i>pos['entry_i'] and held<=10:
                down=m['entry']=='HALF_THEN_DOWN5' and r['close']<=pos['first_open']*.95
                confirm=m['entry']=='QUARTER_THEN_CONFIRM5' and r['prior_high5'] is not None and r['close']>r['prior_high5']
                if down or confirm:pending={'kind':'ADD','decision_i':i,'fraction':.5 if down else .75}
        elif not pending:
            if wait:
                age=i-wait['i']
                if 1<=age<=5 and r['prior_high5'] is not None and r['close']>r['prior_high5']:pending={'kind':'ENTRY','decision_i':i,'fraction':1.,'event':wait};wait=None
                elif age>=5:wait=None
            if i in byi and (signal_cut is None or i<=signal_cut):
                assert wait is None and pending is None,'EVENTS_MUST_NOT_OVERLAP'
                event=byi[i]
                if m['entry']=='CONFIRM_HIGH5_FULL':wait=event
                else:pending={'kind':'ENTRY','decision_i':i,'event':event,'fraction':.5 if m['entry']=='HALF_THEN_DOWN5' else .25 if m['entry']=='QUARTER_THEN_CONFIRM5' else 1.}
    realized={t['event']:t for t in trades};outcomes=[];last_i=max(i for i,r in enumerate(panel) if r['date']<=curve[-1]['date'])
    for event in ev:
        if event['i']>last_i or signal_cut is not None and event['i']>signal_cut:continue
        mature=event['i']+70<=last_i;t=realized.get(event['id']);before=next((a['nav'] for a in reversed(curve) if a['date']<event['date']),CAP)
        if mature:assert pos is None or pos['event']!=event['id'],'MATURE_EPISODE_NOT_CLOSED'
        outcomes.append({**event,'mature':mature,'entered':t is not None or bool(pos and pos['event']==event['id']),'pnl':t['pnl'] if t else 0 if mature else None,'slot_return':t['pnl']/(before*W) if t else 0 if mature else None})
    s=stats(curve,trades);s['unique_closed_events']=len({t['event'] for t in trades});s['mature_common_events']=sum(x['mature'] for x in outcomes);s['hypothetical_liquidation_nav']=cash+q*panel[last_i]['close']*(1-slip)*(1-F-T)
    return {'model':m,'metrics':s,'trades':trades,'orders':orders,'curve':curve,'event_outcomes':outcomes,'open_position':pos,'pending_order':pending}

def control(rows,source_curve=None,weight=.10,slip=.001,yield_=0):
    """Daily next-open rebalance to fixed weight or strictly PRIOR source close.

    Matched path is a diagnostic control, not a new independently selected alpha
    strategy. Dividends are locked receivables (not spendable before payment).
    """
    cash=float(CAP);receivable=0.;q=0.;oldq=0.;curve=[];orders=[];prior=None;cursor=0;known=0.;lastday=next(x['date'] for x in rows if x['date']>='2018')
    for r in rows:
        if r['date']<'2018':continue
        d=(date.fromisoformat(r['date'])-date.fromisoformat(lastday)).days;cash*=(1+yield_)**(d/365.25);lastday=r['date']
        if source_curve is not None:
            while cursor<len(source_curve) and source_curve[cursor]['date']<r['date']:known=source_curve[cursor]['exposure'];prior=source_curve[cursor]['date'];cursor+=1
            target=min(W,max(0,known))
        else:target=weight
        nav=cash+receivable+q*r['open'];gap=target*nav-q*r['open']
        if gap>0:
            fric=(1+slip)*(1+F)-1;qty=min(cash/(r['open']*(1+fric)),gap/(r['open']*(1+target*fric)));cash-=qty*r['open']*(1+fric);q+=qty
        else:
            fric=1-(1-slip)*(1-F-T);qty=min(q,-gap/(r['open']*(1-target*fric)));cash+=qty*r['open']*(1-fric);q-=qty
        orders.append({'decision':prior,'fill':r['date'],'target':target});assert prior is None or prior<r['date']
        # Acquired ex-date units do not earn that day's distribution; eligibility
        # uses yesterday's holdings, never today's rebalance quantity.
        if r.get('cash_dividend'):receivable+=oldq*r['cash_dividend']
        oldq=q;nav=cash+receivable+q*r['close'];curve.append({'date':r['date'],'nav':nav,'invested':q*r['close'],'exposure':q*r['close']/nav});prior=r['date'] if source_curve is None else prior
        assert cash>=-.001
    s=stats(curve,[]);s['locked_dividend_receivable']=receivable;return {'metrics':s,'orders':orders,'curve':curve}
