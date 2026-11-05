"""Independent official reconstruction; no patch of frozen or formal ledgers."""
import argparse,pathlib,math,collections
from base import *
from audit import official,dividends_official,valid
from forensics import classify_frozen,incidents
def run(out):
    guard(out);raw=official(P1,'00631L','2026-11-04');divs=dividends_official(P1,'00631L');assert not divs
    fm={x['date']:x for x in load(P1/'raw/finmind-TaiwanStockPrice-00631L.json')['data']};ref={r['date']:r for r in load(P1/'adjusted-00631L.json')['rows']};frozen={r['date']:r for r in load(ROOT/'research/hs_leverage/data/00631L-historical-adjusted.json')['item']['rows']};cases=[];rows=[]
    for d,r in sorted(raw.items()):
        split=22 if d<'2026-03-31' else 1;v={'date':d,**{k:r[k]/split for k in FIELDS},'cash_dividend':0.};valid(v)
        for k,fk in [('open','open'),('high','max'),('low','min'),('close','close')]:
            assert abs(r[k]-fm[d][fk])<=.011
            assert math.isclose(v[k],ref[d][k],rel_tol=1e-12,abs_tol=1e-12),'PRIOR_REPAIR_NOT_EQUIVALENT'
        rows.append(v)
        if d in frozen and any(not math.isclose(frozen[d][k],v[k],rel_tol=2e-5,abs_tol=2e-6) for k in FIELDS):
            oldraw={k:frozen[d][k]*split for k in FIELDS};cases.append({'date':d,'class':classify_frozen(r,oldraw),'old_adjusted':frozen[d],'new_adjusted':v,'official_raw':r,'finmind_raw':fm[d],'split_applied_once':split,'raw_residual':{k:oldraw[k]-r[k] for k in FIELDS},'receipt':load(P1/'receipts'/('twse-00631L-'+d[:7].replace('-','')+'.json')),'upstream_vendor_internal_cause':'UNPROVEN'})
    oldcases=load(P2/'discrepancies-222.json');assert len(cases)==222 and {x['date']:x['class'] for x in cases}=={x['date']:x['class'] for x in oldcases}
    missing=[d for d in raw if d<=max(frozen) and d not in frozen];assert missing==load(P2/'forensic-summary.json')['missing_frozen_sessions'] and len(missing)==14
    assert not any('2026-03-25'<=d<='2026-03-30' for d in raw),'SUSPENSION_NOT_A_PRICE_GAP'
    for d in missing:assert d in ref and d in fm
    dump(out/'research-copy-00631L.json',{'schema':'HS_LC4_STAGE3_RESEARCH_COPY','basis':'Official raw /22 once before2026-03-31; zero official cash distributions. NOT a frozen rewrite.','rows':rows})
    dump(out/'conflicts-222.json',cases);dump(out/'missing-14.json',[{'date':d,'repaired':next(r for r in rows if r['date']==d),'official_raw':raw[d],'source_receipt':load(P1/'receipts'/('twse-00631L-'+d[:7].replace('-','')+'.json'))} for d in missing])
    inc=incidents();assert inc['added']==load(P2/'incident-set-audit.json')['added'];dump(out/'incident-timing-review.json',inc)
    s={'status':'RESEARCH_COPY_VERIFIED','asof':rows[-1]['date'],'rows':len(rows),'conflict_dates':len(cases),'classifications':dict(collections.Counter(r['class'] for r in cases)),'missing_dates':len(missing),'split_factor':22,'split_effective':'2026-03-31','same_values_as_prior_repaired_copy':True,'cached_incidents':inc['cached_status_count'],'canonical_incidents':inc['canonical_count'],'formal_shadow':'UNCHANGED_FAIL_CLOSED','vendor_internal_causes':'STILL_UNPROVEN','historical_as_published_vintages':'UNAVAILABLE_REVISION_BIAS_NOT_EXCLUDED','sha256':sha((out/'research-copy-00631L.json').read_bytes())};dump(out/'data-review.json',s);guard(out);print(json.dumps(s))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',required=True);run(pathlib.Path(p.parse_args().out).resolve())
