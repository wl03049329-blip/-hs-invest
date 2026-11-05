"""Read-only public source capture. Writes ONLY an explicitly supplied research evidence directory."""
from __future__ import annotations
import argparse,concurrent.futures,hashlib,json,math,pathlib,subprocess,sys,time,urllib.request,urllib.error
from datetime import datetime,timedelta,timezone,date
ROOT=pathlib.Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'research/hs_leverage'))
import phase_l7_shadow as shadow
import phase_l7_daily as daily
TZ=timezone(timedelta(hours=8));FIELDS=('open','high','low','close')
def sha(b):return hashlib.sha256(b).hexdigest()
def dump(p,x):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(x,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf8')
def request(out,name,url):
    rawfile=out/'raw'/f'{name}.json';receipt=out/'receipts'/f'{name}.json'
    if rawfile.exists() and receipt.exists():
        raw=rawfile.read_bytes();r=json.loads(receipt.read_text(encoding='utf8'));assert r['url']==url and r['sha256']==sha(raw);return json.loads(raw.decode('utf-8-sig'))
    for i in range(3):
        try:
            req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0 HS-Isolated-Research/1.0'})
            with urllib.request.urlopen(req,timeout=35) as r:raw=r.read();status=r.status
            payload=json.loads(raw.decode('utf-8-sig'));rawfile.parent.mkdir(parents=True,exist_ok=True);rawfile.write_bytes(raw);dump(receipt,{'name':name,'url':url,'status':status,'sha256':sha(raw),'bytes':len(raw),'retrieved_at':datetime.now(timezone.utc).isoformat()});return payload
        except urllib.error.HTTPError as e:
            dump(out/'errors'/f'{name}-{i}.json',{'name':name,'status':e.code,'at':datetime.now(timezone.utc).isoformat()})
            if e.code in (301,302,307,401,402,403,429) or i==2:raise
            # A redirect-loop transport failure is not an access denial. At most
            # three attempts at the identical URL, preserving every failure receipt;
            # never rotate identities, bypass authorization or ignore429.
            time.sleep((5,20)[i] if e.code==308 else 2**i)
        except (OSError,ValueError) as e:
            dump(out/'errors'/f'{name}-{i}.json',{'name':name,'error':type(e).__name__,'at':datetime.now(timezone.utc).isoformat()})
            if i==2:raise
            time.sleep(2**i)
def seal(out):
    p,_=shadow.load_context(ROOT);assert shadow.validate_provenance(p)
    files={str(f.relative_to(ROOT)):sha(f.read_bytes()) for f in (ROOT/'research/hs_leverage').rglob('*') if f.is_file() and '__pycache__' not in str(f)}
    for f in ['final-core-production.js','buy-point-core.js','portfolio-v3/personal-v3.js','00631l-leverage-status-v1.json','site.webmanifest','app-update.js','app-update-worker.js']:files[f]=sha((ROOT/f).read_bytes())
    chains={f.name:shadow.validate_hash_chain(f) for f in (ROOT/'research/hs_leverage/forward').glob('*.jsonl')};assert len(chains)==3 and all(r['status']=='PASS' for r in chains.values())
    before=out/'protected-before.json'
    result={'root_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'files':files,'protected':len(p['protected_hashes']),'provenance':len(shadow.PROVENANCE_SCOPE),'chains':chains}
    if before.exists():assert json.loads(before.read_text(encoding='utf8'))['files']==files,'LEGACY_FILES_CHANGED'
    else:dump(before,result)
    return result
def probe(out):
    seal(out);now=datetime.now(timezone.utc);f=out/'capture-context.json'
    if f.exists():context=json.loads(f.read_text(encoding='utf8'));now=datetime.fromisoformat(context['started_at'])
    else:
        cal=request(out,'calendar','https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule');holidays=daily.calendar_days(cal,now.astimezone(TZ).year);expected=daily.expected_day(now,holidays)
        context={'started_at':now.isoformat(),'expected_completed_day':expected,'scope':'RESEARCH_ONLY_NO_FORMAL_RECOVERY','protocol_sha256':sha((ROOT/'research/hs_lc4/protocol.json').read_bytes())};dump(f,context)
    expected=context['expected_completed_day'];print('ASOF',expected,flush=True)
    start=int(datetime(2014,10,23,tzinfo=TZ).timestamp());end=int(now.timestamp())
    for symbol in ['00631L','0050']:
        url=f'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}.TW?period1={start}&period2={end}&interval=1d&events=div%2Csplits'
        try:
            y=request(out,'yahoo-'+symbol,url);r=y['chart']['result'][0];meta=r['meta'];assert meta['symbol']==symbol+'.TW' and meta['dataGranularity']=='1d' and meta['exchangeTimezoneName']=='Asia/Taipei';print('YAHOO',symbol,'rows',len(r['timestamp']),'events',r.get('events',{}).keys(),flush=True)
        except Exception as e:print('YAHOO_FAILED',symbol,type(e).__name__,str(e)[:90],flush=True)
        for dataset in ['TaiwanStockPrice','TaiwanStockDividendResult','TaiwanStockSplitPrice']:
            url=f'https://api.finmindtrade.com/api/v4/data?dataset={dataset}&data_id={symbol}&start_date=2014-10-01&end_date={expected}'
            try:
                p=request(out,'finmind-'+dataset+'-'+symbol,url);print('FINMIND',symbol,dataset,p.get('status'),len(p.get('data',[])),flush=True)
            except Exception as e:print('FINMIND_FAILED',symbol,dataset,type(e).__name__,str(e)[:90],flush=True)
    for name,url in [('split00631','https://www.twse.com.tw/zh/ETFortune/announcement?company=A00005&date=20260330&fund=00631L&seq=1&type=all'),('split0050','https://www.twse.com.tw/zh/ETFortune/announcement?company=A00005&date=20250617&fund=0050&seq=1&type=other')]:
        # Primary announcement HTML is a documented browser-readable reference;
        # retain link, not scrape a site that prohibits bulk HTML harvesting.
        dump(out/'references'/f'{name}.json',{'url':url,'verification':'Primary source read via browser/search; quote/table in report, no automated HTML harvesting'})
    return expected
def monthly(out,canonical=False):
    expected=probe(out);jobs=[(symbol,month) for symbol in ['00631L','0050'] for month in daily.months_between('2014-10-01',expected)]
    def one(job):
        symbol,month=job;name='twse-'+symbol+'-'+month;url=f'https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date={month}01&stockNo={symbol}'
        if canonical and not (out/'raw'/f'{name}.json').exists():url=f'https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date={month}01&stockNo={symbol}&response=json'
        elif (out/'receipts'/f'{name}.json').exists():url=json.loads((out/'receipts'/f'{name}.json').read_text(encoding='utf8'))['url']
        cached=(out/'raw'/f'{name}.json').exists()
        p=request(out,name,url);assert p.get('stat')=='OK' and p.get('date','').startswith(month) and symbol in p.get('title',''),name
        if not cached:time.sleep(1)
        return name
    complete=[];fail=[]
    # Resume cached successes; stop the batch at the first unresolved source error.
    # A prior transport-level redirect loop is retained, never retried indefinitely.
    for job in jobs:
        try:complete.append(one(job))
        except Exception as e:
            fail.append({'job':job,'reason':str(e),'type':type(e).__name__});break
        if len(complete)%20==0:print('MONTHS',len(complete),'PASS',len(fail),'FAIL',flush=True);dump(out/'monthly-progress.json',{'pass':complete,'fail':fail,'total':len(jobs)})
    dump(out/'monthly-progress.json',{'pass':complete,'fail':fail,'total':len(jobs)});seal(out);print('MONTHLY_DONE',len(complete),len(fail),flush=True)
if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--out',required=True);ap.add_argument('--monthly',action='store_true');ap.add_argument('--canonical',action='store_true');a=ap.parse_args();out=pathlib.Path(a.out).resolve();assert out!=ROOT and ROOT not in out.parents,'EVIDENCE_MUST_BE_OUTSIDE_REPO';out.mkdir(parents=True,exist_ok=True);monthly(out,a.canonical) if a.monthly else probe(out)
