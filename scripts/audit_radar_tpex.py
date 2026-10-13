"""Bounded TPEx evidence audit. Does not publish or modify saved quote sources.

Monthly integer lots are not exact shares. Exact volume is read from dailyQuotes,
then independently checked against the monthly OHLC and rounded lot display.
All evidence stays outside the public checkout. No retry on quota/HTTP failure.
"""
import argparse
import datetime as dt
import json
from pathlib import Path
import time
from urllib.request import urlopen
from scripts.collect_radar_twse import ROOT, digest, number, roc, overlap

MONTH_FIELDS = ['日 期', '成交張數', '成交仟元', '開盤', '最高', '最低', '收盤', '漲跌', '筆數']

def monthly(payload, month):
    t = payload['tables'][0]
    if payload.get('stat') != 'ok' or t.get('date') != month + '01' or not t.get('subtitle', '').startswith('009815 ') or t.get('fields') != MONTH_FIELDS or t.get('totalCount') != len(t['data']):
        raise ValueError('TPEX_MONTH_SCHEMA')
    result = {}
    for raw in t['data']:
        date = roc(raw[0])
        if len(raw) != 9 or date.replace('-', '')[:6] != month or date in result:
            raise ValueError('TPEX_MONTH_DATE')
        result[date] = dict(date=date, stock_id='009815', open=number(raw[3]), max=number(raw[4]), min=number(raw[5]), close=number(raw[6]), displayed_lots=number(raw[1], True))
    if not result: raise ValueError('TPEX_EMPTY_MONTH')
    return result

def daily(payload, date, month_row):
    if payload.get('stat') != 'ok' or payload.get('date') != date.replace('-', ''):
        raise ValueError('TPEX_DAILY_DATE')
    t = payload['tables'][0]
    fields = t['fields']
    required = ['代號', '開盤', '最高', '最低', '收盤', '成交股數']
    if any(fields.count(f) != 1 for f in required): raise ValueError('TPEX_DAILY_FIELDS')
    rows = [r for r in t['data'] if r[fields.index('代號')] == '009815']
    if len(rows) != 1: raise ValueError('TPEX_DAILY_SYMBOL')
    raw = rows[0]
    row = dict(date=date, stock_id='009815')
    for key, field in zip(('open', 'max', 'min', 'close', 'Trading_Volume'), required[1:]):
        row[key] = number(raw[fields.index(field)], key == 'Trading_Volume')
        if key != 'Trading_Volume' and abs(row[key] - month_row[key]) > 1e-8:
            raise ValueError('TPEX_MONTH_DAILY_PRICE_CONFLICT:' + date + ':' + key)
    if not row['min'] <= min(row['open'], row['close']) <= max(row['open'], row['close']) <= row['max']:
        raise ValueError('TPEX_OHLC_BOUNDS')
    # Monthly presentation rounds to whole lots, not a lossless share count.
    if abs(row['Trading_Volume'] / 1000 - month_row['displayed_lots']) > 0.50000001:
        raise ValueError('TPEX_VOLUME_UNIT_CONFLICT:' + date)
    return row

def evidence(destination, key, url):
    path = destination / (key + '.json')
    if path.exists():
        e = json.loads(path.read_text(encoding='utf-8'))
        if e['url'] != url or digest(e['payload']) != e['sha256']: raise ValueError('EVIDENCE_HASH')
    else:
        time.sleep(3)
        with urlopen(url, timeout=30) as r: payload = json.loads(r.read())
        e = dict(url=url, fetched_at=dt.datetime.now(dt.timezone.utc).isoformat(), payload=payload, sha256=digest(payload))
        path.write_text(json.dumps(e, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return e

def run(destination, cutoff):
    destination = Path(destination).resolve()
    if destination == ROOT or ROOT in destination.parents: raise ValueError('PRIVATE_AUDIT_PATH_REQUIRED')
    destination.mkdir(parents=True, exist_ok=True)
    base = 'https://www.tpex.org.tw/www/zh-tw/'
    rows, refs = [], []
    for month in ('202609', '202610'):
        u = base + f'afterTrading/tradingStock?code=009815&date={month[:4]}%2F{month[4:]}%2F01&response=json'
        e = evidence(destination, 'month-' + month, u)
        refs.append({k:e[k] for k in ('url', 'sha256', 'fetched_at')})
        for date, m in monthly(e['payload'], month).items():
            if date > cutoff: continue
            e = evidence(destination, 'daily-' + date, base + 'afterTrading/dailyQuotes?date=' + date.replace('-', '%2F') + '&response=json')
            rows.append(daily(e['payload'], date, m))
            refs.append({k:e[k] for k in ('url', 'sha256', 'fetched_at')})
            print(date, rows[-1]['Trading_Volume'], flush=True)
    seed = json.loads((ROOT/'research/c4_historical/source/009815.json').read_text(encoding='utf-8'))
    meta = json.loads((ROOT/'research/c4_historical/009815.json').read_text(encoding='utf-8'))
    if digest(seed) != meta['metadata']['provenance']['source_ohlc_sha256']: raise ValueError('SEED_PROVENANCE')
    comparison = overlap(seed, rows)
    actions = []
    for action in ('exDailyQ', 'etfSplitRslt', 'etfRvsRslt', 'revivt', 'pvChgRslt'):
        e = evidence(destination, 'actions-' + action, base + f'bulletin/{action}?startDate=2026%2F01%2F26&endDate=' + cutoff.replace('-', '%2F') + '&response=json')
        p = e['payload']
        if p.get('stat') != 'ok' or p.get('date') != '20260126~' + cutoff.replace('-', ''): raise ValueError('ACTION_COVERAGE')
        t = p['tables'][0]
        field = next((f for f in ('代號', '證券代號', '股票代號') if f in t['fields']), None)
        if t['fields'].count(field) != 1 or t['totalCount'] != len(t['data']): raise ValueError('ACTION_SCHEMA')
        matches = [r for r in t['data'] if r[t['fields'].index(field)] == '009815']
        actions.append(dict(source=action, matches=matches, sha256=e['sha256']))
        refs.append({k:e[k] for k in ('url', 'sha256', 'fetched_at')})
    sessions = []
    for m in range(1, int(cutoff[5:7]) + 1):
        month = '2026' + str(m).zfill(2)
        e = evidence(destination, 'calendar-' + month, base + f'indexInfo/inx?date=2026%2F{m:02}%2F01&response=json')
        p=e['payload']; t=p['tables'][0]
        if p.get('stat')!='ok' or p.get('date')!=month+'01' or t['fields']!=['日期','開市','最高','最低','收市','漲/跌'] or t['totalCount']!=len(t['data']): raise ValueError('TPEX_CALENDAR_SCHEMA')
        for r in t['data']:
            date=dt.date.fromisoformat(r[0].replace('/','-')).isoformat()
            if date.replace('-','')[:6]!=month or date in sessions: raise ValueError('TPEX_CALENDAR_DATE')
            if '2026-01-26'<=date<=cutoff: sessions.append(date)
        refs.append({k:e[k] for k in ('url','sha256','fetched_at')})
    report = dict(symbol='009815', as_of=cutoff, price=rows, overlap=comparison, actions=actions, sessions=sessions, evidence=refs, promoted=False)
    (destination/'009815-audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(dict(overlap=comparison,actions=actions,count=len(rows)),ensure_ascii=False),flush=True)
    return report, seed

def verified_archive(report, seed):
    if report.get('symbol')!='009815' or report['overlap']['count']<1 or report['overlap']['volume_differences']:
        raise ValueError('TPEX_OVERLAP_NOT_VERIFIED')
    if {a['source'] for a in report['actions']} != {'exDailyQ','etfSplitRslt','etfRvsRslt','revivt','pvChgRslt'} or any(a['matches'] for a in report['actions']) or seed['dividend']:
        raise ValueError('TPEX_UNREVIEWED_ACTION')
    old={r['date'] for r in seed['price']}
    tail=[r for r in report['price'] if r['date']>seed['price'][-1]['date']]
    if not tail or old | {r['date'] for r in tail} != set(report['sessions']):
        raise ValueError('TPEX_SESSION_GAP')
    result=dict(schema_version=1,symbol='009815',provider='TPEx/dailyQuotes',price_type='RAW_UNADJUSTED',currency='TWD',price_unit='TWD_PER_UNIT',volume_unit='SHARES',verified=True,requested_start='2026-09-01',requested_end=report['as_of'],fetched_at=max(r['fetched_at'] for r in report['evidence']),base_source_sha256=digest(seed),base_last_date=seed['price'][-1]['date'],overlap={**report['overlap'],'policy':'Original FinMind rows retained; exact TPEx official shares for new dates'},price=tail,dividends=[],action_coverage=dict(start='2026-09-01',end=report['as_of']),action_checks=report['actions'],evidence=report['evidence'],calendar_completeness='TPEX_INDEX_SESSIONS_VERIFIED',expected_session_count=len(report['sessions']),volume_verification='Exact dailyQuotes shares; monthly rounded lots independently cross-checked, never multiplied to fabricate exact shares')
    result['content_sha256']=digest(result)
    return result

if __name__ == '__main__':
    p=argparse.ArgumentParser();p.add_argument('--evidence-dir',required=True);p.add_argument('--as-of',required=True)
    p.add_argument('--promote',action='store_true')
    a=p.parse_args(); report,seed=run(a.evidence_dir,a.as_of)
    if a.promote:
        result=verified_archive(report,seed)
        destination=ROOT/'data/radar-history/tpex/009815.json'
        destination.parent.mkdir(parents=True,exist_ok=True)
        destination.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        print('VERIFIED_TPEX_INCREMENT',len(result['price']),flush=True)
