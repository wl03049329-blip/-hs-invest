"""Fail-closed source reconciliation for the isolated research dataset."""
from __future__ import annotations
import argparse,json,math,pathlib,sys
from datetime import datetime
from capture import dump,sha,seal,TZ,FIELDS,ROOT

def number(x):
    v=float(str(x).replace(',',''));assert math.isfinite(v) and v>0;return v
def valid(r):
    assert all(math.isfinite(r[k]) and r[k]>0 for k in FIELDS)
    assert r['low']<=min(r['open'],r['close'])+.00001 and r['high']>=max(r['open'],r['close'])-.00001 and r['low']<=r['high']
def official(out,symbol,end):
    result={}
    for f in sorted((out/'raw').glob('twse-'+symbol+'-*.json')):
        b=f.read_bytes();receipt=json.loads((out/'receipts'/f.name).read_text(encoding='utf8'));assert sha(b)==receipt['sha256']
        p=json.loads(b);assert p['stat']=='OK' and symbol in p['title'];fields=p['fields']
        names={'open':'開盤價','high':'最高價','low':'最低價','close':'收盤價'}
        for row in p['data']:
            y,m,d=map(int,row[0].split('/'));day=f'{y+1911:04}-{m:02}-{d:02}'
            if day<'2014-10-31' or day>end:continue
            if row[fields.index('成交股數')].replace(',','')=='0':continue
            r={'date':day,**{k:number(row[fields.index(v)]) for k,v in names.items()}}
            valid(r);assert day not in result;result[day]=r
    assert result and max(result)==end,('OFFICIAL_TAIL_MISSING',symbol,max(result,default=None),end)
    return result
def yahoo(out,symbol):
    p=json.loads((out/'raw'/('yahoo-'+symbol+'.json')).read_text(encoding='utf8'));r=p['chart']['result'][0];q=r['indicators']['quote'][0];a=r['indicators']['adjclose'][0]['adjclose'];result={}
    for i,t in enumerate(r['timestamp']):
        day=datetime.fromtimestamp(t,TZ).date().isoformat();v={k:q[k][i] for k in FIELDS};v['adjclose']=a[i]
        result[day]=v
    return result
def assemble(out):
    seal(out);end=json.loads((out/'capture-context.json').read_text(encoding='utf8'))['expected_completed_day'];report={'end':end,'symbols':{},'status':'BLOCKED','errors':[]};datasets={}
    for symbol,splitday,ratio in [('00631L','2026-03-31',22),('0050','2025-06-18',4)]:
        try:rows=official(out,symbol,end)
        except AssertionError as e:
            report['symbols'][symbol]={'status':'BLOCKED','reason':str(e)};report['errors'].append([symbol,str(e)]);continue
        y=yahoo(out,symbol);fm=json.loads((out/'raw'/('finmind-TaiwanStockPrice-'+symbol+'.json')).read_text(encoding='utf8'));assert fm['status']==200
        fm={x['date']:x for x in fm['data']};actions=json.loads((out/'raw'/('finmind-TaiwanStockSplitPrice-'+symbol+'.json')).read_text(encoding='utf8'))
        assert actions['status']==200 and len(actions['data'])==1 and actions['data'][0]['date']==splitday
        dividends=json.loads((out/'raw'/('finmind-TaiwanStockDividendResult-'+symbol+'.json')).read_text(encoding='utf8'));assert dividends['status']==200
        if symbol=='00631L':assert dividends['data']==[],'UNRESOLVED_00631L_DIVIDEND'
        info={'official_rows':len(rows),'start':min(rows),'end':max(rows),'split_date':splitday,'split_ratio':ratio,'finmind_crosschecks':0,'yahoo_crosschecks':0,'research_repairs':[],'conflicts':[],'dividend_events':len(dividends['data'])};adjusted=[]
        for day,raw in sorted(rows.items()):
            split=ratio if day<splitday else 1
            # Official raw OHLC is authoritative; secondary feeds are evidence, not substitutes.
            f=fm.get(day)
            if f:
                for k,fk in [('open','open'),('high','max'),('low','min'),('close','close')]:
                    if abs(float(f[fk])-raw[k])>.011:info['conflicts'].append([day,'FINMIND',k,raw[k],f[fk]])
                info['finmind_crosschecks']+=1
            else:info['conflicts'].append([day,'FINMIND_MISSING'])
            z=y.get(day);complete=z and all(isinstance(z.get(k),(float,int)) and math.isfinite(z[k]) and z[k]>0 for k in (*FIELDS,'adjclose'))
            if complete:
                # Yahoo's first pre-2015 00631L records are unadjusted despite later split-restored history.
                restore=split
                if symbol=='00631L' and day<'2015-01-05' and abs(z['close']-raw['close'])<.011:restore=1
                mismatches=[k for k in FIELDS if abs(z[k]*restore-raw[k])>.011]
                if mismatches:
                    item=[day,'YAHOO_RAW_MISMATCH',mismatches]
                    if symbol=='00631L' and f and all(abs(float(f[fk])-raw[k])<=.011 for k,fk in [('open','open'),('high','max'),('low','min'),('close','close')]):
                        info['research_repairs'].append({'date':day,'fields':mismatches,'method':'TWSE_RAW_CONFIRMED_BY_FINMIND_SINGLE_SPLIT_NO_DIVIDENDS','rejected_yahoo':z,'official_raw':raw})
                    else:info['conflicts'].append(item)
                factor=z['adjclose']/z['close']
                if symbol=='00631L' and not math.isclose(factor,1,rel_tol=2e-5):info['conflicts'].append([day,'UNRESOLVED_ADJUSTMENT',factor])
                info['yahoo_crosschecks']+=1
            elif symbol=='00631L':
                # Research-only official reconstruction with independently documented single split,
                # zero dividend events and daily second-source confirmation. No Shadow authority.
                factor=1;info['research_repairs'].append({'date':day,'fields':[k for k in (*FIELDS,'adjclose') if not z or z.get(k) is None],'method':'OFFICIAL_RAW_SINGLE_DOCUMENTED_SPLIT_NO_DIVIDENDS_RESEARCH_ONLY'})
            else:
                info['conflicts'].append([day,'0050_TOTAL_RETURN_FACTOR_MISSING']);continue
            r={'date':day,**{k:raw[k]/split*factor for k in FIELDS},'raw_close':raw['close'],'split_divisor':split,'total_return_factor':factor};valid(r);adjusted.append(r)
        if symbol=='00631L':
            frozen=json.loads((ROOT/'research/hs_leverage/data/00631L-historical-adjusted.json').read_text(encoding='utf8'))
            old={r['date']:r for r in frozen['item']['rows']};new={r['date']:r for r in adjusted};diff=[]
            for d,r in old.items():
                if d not in new or any(not math.isclose(r[k],new[d][k],rel_tol=2e-5,abs_tol=2e-6) for k in FIELDS):diff.append(d)
            info['frozen_overlap_rows']=len(old);info['frozen_differences']=diff
            # Old studies stay byte-identical, but they are NOT evidence that a vendor
            # discrepancy should replace independently confirmed primary-source prices.
            info['legacy_study_comparability']='NON_EQUIVALENT_INPUTS_DO_NOT_RESTATE_FROZEN_RESULTS' if diff else 'SAME_OVERLAP'
        report['symbols'][symbol]=info
        if not info['conflicts']:datasets[symbol]=adjusted
        report['errors'] += [[symbol,c] for c in info['conflicts']]
    report['status']='PASS' if not report['errors'] else 'BLOCKED';dump(out/'data-audit.json',report)
    manifest={}
    for s,rows in datasets.items():
        p=out/('adjusted-'+s+'.json');dump(p,{'schema':'HS_LC4_AUDITED_RESEARCH_OHLC_V1','basis':'Official raw OHLC / documented split * verified Yahoo dividend adjustment; fractional total-return proxy','rows':rows});manifest[s]={'sha256':sha(p.read_bytes()),'rows':len(rows),'start':rows[0]['date'],'end':rows[-1]['date']}
    dump(out/'dataset-manifest.json',manifest);print(json.dumps({'status':report['status'],'conflicts':len(report['errors']),'first':report['errors'][:8],'manifest':manifest}));return report
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',required=True);a=p.parse_args();r=assemble(pathlib.Path(a.out).resolve());sys.exit(0 if r['status']=='PASS' else 2)
