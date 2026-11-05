"""222 individually reproducible discrepancies, plus canonical incident set audit."""
import argparse,pathlib,math,csv,collections,json
from common import *
import audit,phase_l7_daily as daily,phase_l7_shadow as shadow

def near(a,b,tol=.011):return all(abs(a[k]-b[k])<=tol for k in FIELDS)
def classify(raw,vendor,divisor):
    if not vendor or any(vendor.get(k) is None for k in FIELDS):return 'MISSING_VENDOR_OHLC'
    if near(raw,vendor):return 'UNADJUSTED_VS_ADJUSTED_BASIS_ONLY'
    restored={k:vendor[k]*divisor for k in FIELDS}
    if near(raw,restored):return 'DOCUMENTED_SPLIT_NORMALIZATION_ONLY'
    if near(raw,{k:vendor[k]/divisor for k in FIELDS}):return 'DOUBLE_SPLIT_BASIS'
    changed=[k for k in FIELDS if abs(restored[k]-raw[k])>.011]
    if changed==['close']:return 'CLOSE_SOURCE_CONFLICT_AFTER_SPLIT_NORMALIZATION'
    if len({round(vendor[k],6) for k in FIELDS})==1 and len({raw[k] for k in FIELDS})>1:return 'FLAT_VENDOR_BAR_SOURCE_CONFLICT'
    return 'MULTIFIELD_SOURCE_CONFLICT_AFTER_SPLIT_NORMALIZATION'
def classify_frozen(raw,oldraw):
    # Five-decimal split-adjusted vendor rounding can create at most.00011 raw
    # noise under22:1. A one-cent close difference is NOT merely that rounding.
    if near(raw,oldraw,.0002):return 'NUMERIC_PRECISION_ONLY'
    if near(raw,{k:oldraw[k]*22 for k in FIELDS}) or near(raw,{k:oldraw[k]/22 for k in FIELDS}):return 'SPLIT_BASIS_ONLY'
    bad=[k for k in FIELDS if abs(oldraw[k]-raw[k])>.0002]
    if bad==['close']:return 'ONE_TICK_CLOSE_SOURCE_DIFFERENCE' if abs(oldraw['close']-raw['close'])<=.011 else 'MULTI_TICK_CLOSE_SOURCE_DIFFERENCE'
    if len({round(oldraw[k],3) for k in FIELDS})==1:return 'FLAT_VENDOR_BAR_SOURCE_CONFLICT'
    return 'MULTIFIELD_SOURCE_CONFLICT'
def incidents():
    policy,_=shadow.load_context(ROOT);records,_=daily.validate_ledgers(ROOT/policy['paths']['forward_ledger'],ROOT/policy['paths']['outcomes_ledger'],policy)
    canonical=daily.prepare_review(ROOT);history=shadow.read_jsonl(ROOT/daily.INCIDENTS);status=load(ROOT/daily.STATUS)
    import phase_l7_recovery_reader as reader
    reviewed={r.get('incident_id') for r in records if r.get('record_type')=='CORPORATE_ACTION_RECOVERY' and not r.get('test_only') and r.get('recovery_mode')!='EXACT_SCOPE_RECOVERY_V1' and r.get('integrity_review_status')=='PASS' and r.get('approved_by') and r.get('new_data_version') and len(r.get('recovery_steps_completed',[]))>=8}
    reviewed.update(reader.reviewed_ids(ROOT,records))
    pending=[r for r in history if r.get('requires_integrity_review') and r['record_id'] not in reviewed];want={r['record_id']:r for r in pending};got={r['incident_id']:r for r in canonical['incidents']};cached={r['incident_id']:r for r in status['blocking_incidents']}
    assert set(want)==set(got);assert not canonical['authorizes_recovery'] and canonical['read_only'];assert all(not r['authorized'] for r in got.values())
    added=sorted(set(got)-set(cached));removed=sorted(set(cached)-set(got));tail=history[-1]
    assert added==[tail['record_id']] and not removed and tail['record_hash'] not in [r['record_hash'] for r in history[:-1]]
    assert tail['incident_fingerprint'] not in {r.get('incident_fingerprint') for r in history[:-1]},'NEWEST_INCIDENT_NOT_A_NEW_SIGNATURE'
    assert set(cached)=={r['record_id'] for r in pending if r['record_id']!=tail['record_id']}
    return {'cached_status_count':len(cached),'canonical_count':len(got),'added':added,'removed':removed,'newest':{k:tail.get(k) for k in ['record_id','record_hash','previous_record_hash','checked_at','reason','current_failure_reason','expected_completed_bar','incident_fingerprint','requires_integrity_review','workflow_classification']},'rows':canonical['incidents'],'cause':'operational_failure builds unresolved/status BEFORE append_record, then writes status containing pre-append list; prepare_review replays post-append canonical chain. The test hardcodes the pre-append count. Latest distinct incident is missing only from cached diagnostic list, NOT approved, NOT a duplicate, NOT erased. FAIL_CLOSED remains. No test expectation modified.','future_fix_proposal':'Separate authorized maintenance: derive status blocking list from validated canonical history after append and test set/hash completeness, not a fixed7 or8. Explicit approval/receipt rules unchanged; do not perform this production modification in this study.'}
def run(out):
    check(out);official=audit.official(P1,'00631L','2026-11-04');vendor=audit.yahoo(P1,'00631L');fm={r['date']:r for r in load(P1/'raw/finmind-TaiwanStockPrice-00631L.json')['data']};frozen={r['date']:r for r in load(ROOT/'research/hs_leverage/data/00631L-historical-adjusted.json')['item']['rows']};adjusted={r['date']:r for r in load(P1/'adjusted-00631L.json')['rows']};wanted=load(P1/'data-audit.json')['symbols']['00631L']['frozen_differences']
    result=[];normalization=collections.Counter();missing=[]
    for day,raw in official.items():
        div=22 if day<'2026-03-31' else 1;z=vendor.get(day);cat=classify(raw,z,div);normalization[cat]+=1
        assert near(raw,{k:fm[day][fk] for k,fk in [('open','open'),('high','max'),('low','min'),('close','close')]})
        if not z or any(z.get(k) is None for k in (*FIELDS,'adjclose')):missing.append({'date':day,'missing':[k for k in (*FIELDS,'adjclose') if not z or z.get(k) is None],'in_frozen':day in frozen})
        if day not in wanted:continue
        old=frozen[day];oldraw={k:old[k]*div for k in FIELDS};changed=[k for k in FIELDS if not math.isclose(old[k],adjusted[day][k],rel_tol=2e-5,abs_tol=2e-6)]
        delta={k:oldraw[k]-raw[k] for k in FIELDS};ratios=[oldraw[k]/raw[k] for k in FIELDS]
        # Distinguish observed disagreement from an unknowable upstream internal cause.
        matches=[d for d,r in official.items() if d!=day and near(oldraw,r)]
        row={'date':day,'class':classify_frozen(raw,oldraw),'current_vendor_class_at_phase1_tolerance':cat,'fields':changed,'official_raw':raw,'finmind_raw':{k:fm[day][fk] for k,fk in [('open','open'),('high','max'),('low','min'),('close','close')]},'yahoo':z,'frozen_adjusted':old,'verified_adjusted':adjusted[day],'documented_split_divisor':div,'frozen_raw_equivalent_delta':delta,'uniform_ratio_range':max(ratios)-min(ratios),'other_date_full_ohlc_matches':matches,'official_split_event_explains_residual':near(oldraw,raw,.0002),'internal_vendor_root_cause':'UNPROVEN_DO_NOT_INVENT','resolution':'Use TWSE raw plus independently matching FinMind and one documented split; preserve old bytes','monthly_receipt_sha':load(P1/'receipts'/('twse-00631L-'+day[:7].replace('-','')+'.json'))['sha256']};result.append(row)
    assert len(result)==222 and {x['date'] for x in result}==set(wanted)
    counts=dict(collections.Counter(x['class'] for x in result));lastold=max(frozen);missing_legacy=[d for d in official if d<=lastold and d not in frozen]
    dump(out/'discrepancies-222.json',result)
    with (out/'discrepancies-222.csv').open('w',encoding='utf-8-sig',newline='') as f:
        w=csv.DictWriter(f,fieldnames=['date','class','fields','split_divisor','official_OHLC','frozen_adjusted_OHLC','yahoo_OHLC','raw_equivalent_delta','other_date_matches','upstream_cause']);w.writeheader()
        for x in result:w.writerow({'date':x['date'],'class':x['class'],'fields':','.join(x['fields']),'split_divisor':x['documented_split_divisor'],'official_OHLC':json.dumps([x['official_raw'][k] for k in FIELDS]),'frozen_adjusted_OHLC':json.dumps([x['frozen_adjusted'][k] for k in FIELDS]),'yahoo_OHLC':json.dumps([x['yahoo'].get(k) for k in FIELDS]) if x['yahoo'] else None,'raw_equivalent_delta':json.dumps(x['frozen_raw_equivalent_delta']),'other_date_matches':','.join(x['other_date_full_ohlc_matches']),'upstream_cause':x['internal_vendor_root_cause']})
    inc=incidents();dump(out/'incident-set-audit.json',inc)
    summary={'dates':len(result),'classifications':counts,'full_vendor_vs_official_classes':dict(normalization),'missing_vendor_fields':missing,'missing_frozen_sessions':missing_legacy,'missing_explanation':'Not all gaps belong to the222 mismatched-overlap dates; genuine omitted sessions are listed separately. Official suspension dates are not fabricated as missing bars.','official_suspension':'2026-03-25 through2026-03-30; split effective2026-03-31; no official action within most residual conflict dates.','incident_counts':[inc['cached_status_count'],inc['canonical_count']],'unresolved_upstream_cause_count':len(result)};dump(out/'forensic-summary.json',summary);check(out);print(json.dumps(summary,ensure_ascii=True))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',required=True);run(pathlib.Path(p.parse_args().out).resolve())
