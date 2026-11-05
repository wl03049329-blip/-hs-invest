"""Research-only daily publisher. No Forward backfill, financial storage or score.

Uses the existing official calendar/month/action validators and 18:00 policy.
One immutable bundle contains history + snapshot + receipts; latest is promoted
last. A failed run leaves the last verified bundle intact. No remote publication.
"""
import argparse, copy, datetime as dt, gzip, hashlib, json, math, os, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from scripts.update_radar_daily import Client, expected_day, official_sessions, twse_actions, atomic_json, TZ, ref
from backend.trading_calendar import TradingCalendar
from scripts.collect_radar_twse import parse_month, months, digest
from scripts.fetch_official_eod_market import HOLIDAY_URL, iso_date
sys.path.insert(0,str(ROOT/'research/hs_lc4/stage3'))
from analysis import radar_features, market_panel, make_snapshot, path as event_path

DIR='data/lc4-research'
def sha(raw):return hashlib.sha256(raw).hexdigest()
def read(p):return json.loads(Path(p).read_text(encoding='utf8'))
def encoded(x):return (json.dumps(x,ensure_ascii=False,sort_keys=True,allow_nan=False,indent=2)+'\n').encode()
def require(ok,reason):
    if not ok:raise ValueError(reason)

def compensatory_closure(calendar,day):
    # Existing calendar's keyword check omits the official "補假" wording.
    # Tighten only this research adapter; do not alter production calendars.
    return any(iso_date(r.get('Date'))==day and '補假' in str(r.get('Description',''))
               and not any(t in str(r.get('Name','')) for t in ('開始交易','最後交易')) for r in calendar)

def research_expected_day(client,now):
    target,limit,ref=expected_day(client,now)
    for _ in range(28):
        if not compensatory_closure(client.get(HOLIDAY_URL)['payload'],target):return target,limit,ref
        prior=(dt.date.fromisoformat(target)-dt.timedelta(days=1)).isoformat()
        target,_,ref=expected_day(client,now,prior)
    raise ValueError('RESEARCH_CALENDAR_UNRESOLVED')

def validate_rows(rows):
    previous=''
    for r in rows:
        dt.date.fromisoformat(r['date']);require(r['date']>previous,'HISTORY_ORDER')
        require(all(type(r[k]) in (int,float) and math.isfinite(r[k]) and r[k]>0 for k in ('open','high','low','close')),'HISTORY_OHLC')
        require(r['low']<=min(r['open'],r['close'])<=max(r['open'],r['close'])<=r['high'],'HISTORY_BOUNDS')
        previous=r['date']
    require(len(rows)>=240,'HISTORY_SHORT')

def load_history(root):
    directory=Path(root)/DIR;seed=read(directory/'seed.json')
    raw=(directory/'seed-history.json.gz').read_bytes()
    require(sha(raw)==seed['history_sha256'],'SEED_HASH')
    bundle=json.loads(gzip.decompress(raw));seed_history=copy.deepcopy(bundle)
    require(sha((directory/'seed-sources.json.gz').read_bytes())==seed['sources_sha256'],'SOURCE_ARCHIVE_HASH')
    pointer=directory/'latest.json'
    if pointer.exists():
        p=read(pointer);name=p['path']
        require(name.startswith('snapshots/') and '..' not in name and '\\' not in name,'BUNDLE_PATH')
        b=(directory/name).read_bytes();require(sha(b)==p['sha256'] and len(b)==p['bytes'],'BUNDLE_HASH')
        current=json.loads(b)
        require(current['revision']==p['revision'] and current['asof']==p['asof'],'BUNDLE_IDENTITY')
        bundle=current['history']
    require(bundle['fixed_events']==seed_history['fixed_events'] and bundle['model']==seed_history['model'],'FROZEN_COHORT_OR_MODEL_CHANGED')
    for s in ('00631L','0050'):
        rows=bundle['histories'][s];validate_rows(rows)
        seed_rows=seed_history['histories'][s]
        require(rows[:len(seed_rows)]==seed_rows,'AUDITED_HISTORY_CHANGED:'+s)
        require(rows[-1]['date']==bundle['asof'],'HISTORY_DATE')
    return bundle

def extend(history,client,target):
    """Both instruments must reach the observed official target, without gaps."""
    require(target>=history['asof'],'RESEARCH_ROLLBACK_REJECTED')
    result=copy.deepcopy(history);anchor=history['asof']
    month_list=list(months(anchor,target));require(len(month_list)<=24,'GAP_REQUIRES_REVIEW')
    sessions=[]
    for month in month_list:
        ds,_=official_sessions(client,'twse',month,target);sessions.extend(d for d in ds if anchor<d<=target)
    require(target==anchor or (sessions and sessions[-1]==target),'OFFICIAL_SESSION_NOT_PUBLISHED')
    for symbol in ('00631L','0050'):
        rows=result['histories'][symbol];by={r['date']:r for r in rows};fresh=[];seen_anchor=False
        for month in month_list:
            e=client.get(f'https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date={month}01&stockNo={symbol}')
            for r in parse_month(e['payload'],symbol,month,target):
                # Seed prices have one reviewed split adjustment. Incremental
                # dates after the audited seed use raw prices, never re-adjusted.
                if r['date'] in by:
                    divisor=(22 if symbol=='00631L' and r['date']<'2026-03-31' else
                             4 if symbol=='0050' and r['date']<'2025-06-18' else 1)
                    for oldkey,key in [('open','open'),('high','max'),('low','min'),('close','close')]:
                        require(abs(by[r['date']][oldkey]-r[key]/divisor)<1e-8,'OFFICIAL_OVERLAP_CONFLICT:'+symbol+':'+r['date'])
                    seen_anchor|=r['date']==anchor
                elif r['date']>anchor:
                    fresh.append({'date':r['date'],'open':r['open'],'high':r['max'],'low':r['min'],'close':r['close'],'cash_dividend':0})
        require(seen_anchor,'ANCHOR_MISSING:'+symbol)
        require([r['date'] for r in fresh]==sessions,'MISSING_OR_EXTRA_SESSION:'+symbol)
        actions,_,_=twse_actions(client,symbol,anchor,target)
        for a in actions:
            require(symbol!='00631L','NEW_LEVERAGE_ACTION_REQUIRES_REVIEW')
            if a['date']<=anchor:
                require(abs(by[a['date']].get('cash_dividend',0)-a['amount'])<1e-8,'DIVIDEND_OVERLAP')
            else:
                match=next((r for r in fresh if r['date']==a['date']),None)
                require(match is not None,'ACTION_WITHOUT_BAR');match['cash_dividend']=a['amount']
        rows.extend(fresh);validate_rows(rows)
    result['asof']=target
    return result

def describe(history):
    panel=radar_features(history['histories']['00631L']);market=market_panel(history['histories']['0050'])
    snap=make_snapshot(panel,market,{'asof':history['asof'],'rows':len(panel)})
    snap['data']['live_data_verification']='OFFICIAL_RESEARCH_BUNDLE_ONLY'
    # Canonical review is read-only, never an authorization. Legacy public
    # Shadow snapshots may be older; do not let them override the review latch.
    import phase_l7_daily as daily
    report=daily.prepare_review(ROOT)
    snap['data']['canonical_incidents']=len(report['incidents'])
    snap['data']['cached_incidents']=len(read(ROOT/daily.STATUS).get('blocking_incidents',[]))
    snap['data']['formal_shadow']='FAIL_CLOSED' if report['incidents'] else 'REQUIRES_FORMAL_STATUS_VERIFICATION'
    fixed=history['fixed_events'];paths=[];index={r['date']:i for i,r in enumerate(panel)}
    for ev in fixed:
        date=ev['id'].split(':',1)[1]
        require(date in index,'FIXED_EVENT_MISSING')
        for h in (5,10,20):paths.append(event_path(panel,{'id':ev['id'],'i':index[date]},h))
    risk={}
    for h in (5,10,20):
        complete=[r for r in paths if r['horizon']==h and r.get('low_vs_entry_open') is not None]
        values=sorted(r['low_vs_entry_open'] for r in complete);n=len(values)
        import statistics
        median=statistics.median(values) if n else None
        typical=min(complete,key=lambda r:abs(r['low_vs_entry_open']-median)) if n else None
        worst=min(complete,key=lambda r:r['low_vs_entry_open']) if n else None
        risk[str(h)]={'n':n,'pending':len(fixed)-n,'further_break_count':sum(r['further_break'] for r in complete),
            'mae_median':median,'mae_min':min(values,default=None),'mae_values':values,
            'typical':typical,'worst':worst,'not_a_forecast':True}
    return {'radar':snap,'risk':risk,'fixed_event_count':len(fixed),
            'event_cohort':'STAGE2_PREDECLARED_C95_70_SESSION_COOLDOWN_UNCHANGED',
            'not_independent_oos':True,'historical_selection_bias':True}

def publish(root,history,client,now,calendar_ref):
    directory=Path(root)/DIR;old=read(directory/'latest.json') if (directory/'latest.json').exists() else None
    input_hash=digest({'history':history,'envelope_version':1})
    if old and old['input_sha256']==input_hash:return {'status':'NOOP','asof':history['asof']}
    description=describe(history)
    seed_sources=json.loads(gzip.decompress((directory/'seed-sources.json.gz').read_bytes()))
    calendar=seed_sources['calendar.json']['payload']
    from scripts.fetch_official_eod_market import HOLIDAY_URL
    if HOLIDAY_URL in client.entries:calendar=client.entries[HOLIDAY_URL]['payload']
    trading=TradingCalendar(fetcher=lambda:calendar);next_check=None
    for offset in range(1,29):
        day=dt.date.fromisoformat(history['asof'])+dt.timedelta(days=offset)
        if not any(iso_date(r.get('Date')).startswith(str(day.year)) for r in calendar):break
        state=trading.check(day)
        if state.status=='UNKNOWN':break
        if state.status=='TRADING_DAY' and not compensatory_closure(calendar,day.isoformat()):
            next_check=dt.datetime.combine(day,dt.time(18),TZ).isoformat();break
    bundle={'schema':'HS_LC4_RESEARCH_BUNDLE_V1','model':'STAGE3_FIXED_DESCRIPTIVE_V1','asof':history['asof'],
      'produced_at':now.isoformat(),'revision':old['revision']+1 if old else 1,
      'previous_bundle_sha256':old['sha256'] if old else None,'history':history,
      'description':description,'receipts':list(client.entries.values()),'calendar_ref':calendar_ref,
      'next_source_check_due':next_check,
      'research_only':True,'writer':False,'entry_authorized':False,'score':None}
    raw=encoded(bundle);hash_=sha(raw);name=f"snapshots/{bundle['asof']}-r{bundle['revision']:06}-{hash_[:12]}.json"
    dest=directory/name;dest.parent.mkdir(parents=True,exist_ok=True)
    if dest.exists():require(dest.read_bytes()==raw,'IMMUTABLE_SNAPSHOT_CONFLICT')
    else:
        with dest.open('xb') as f:f.write(raw)
    # Compact reader envelope and history live in the SAME hashed immutable file.
    require(dest.read_bytes()==raw,'SNAPSHOT_READBACK_FAILED')
    pointer={'schema':'HS_LC4_RESEARCH_POINTER_V1','asof':bundle['asof'],'revision':bundle['revision'],
             'path':name,'sha256':hash_,'bytes':len(raw),'input_sha256':input_hash}
    atomic_json(directory/'latest.json',pointer)
    return {'status':'VERIFIED_RESEARCH_UPDATED','asof':bundle['asof'],'revision':bundle['revision'],'sha256':hash_}

def update(args):
    now=dt.datetime.now(dt.timezone.utc);client=Client(args.evidence,ROOT)
    history=load_history(ROOT)
    try:
        if args.seed_only:
            # Offline packaging is explicitly historical, not a live-source check.
            target=history['asof'];calendar_ref={'status':'HISTORICAL_SEED_NOT_LIVE_CHECKED'}
        else:
            target,_,calendar_ref=research_expected_day(client,now)
            history=extend(history,client,target)
        result=publish(ROOT,history,client,now,calendar_ref)
        atomic_json(ROOT/DIR/'status.json',{'checked_at':now.isoformat(),**result,
          'bundle_sha256':read(ROOT/DIR/'latest.json')['sha256'],
          'source_receipts':[ref(e) for e in client.entries.values()],
          'live_source_check':not args.seed_only,'writer':False})
        print(json.dumps(result));return 0
    except Exception as exc:
        atomic_json(ROOT/DIR/'status.json',{'status':'RESEARCH_UPDATE_BLOCKED','checked_at':now.isoformat(),
                     'reason':str(exc),'retained_asof':history['asof'],'writer':False})
        raise

def main():
    p=argparse.ArgumentParser();p.add_argument('--evidence',required=True);p.add_argument('--seed-only',action='store_true')
    args=p.parse_args();lock=ROOT/DIR/'.update.lock'
    # Exclusive local ownership complements the workflow concurrency group.
    # A stale lock is diagnosed, never automatically removed by another run.
    fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    try:
        os.close(fd)
        return update(args)
    finally:lock.unlink()

if __name__=='__main__':sys.exit(main())
