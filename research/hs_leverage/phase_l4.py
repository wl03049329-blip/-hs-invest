"""Post-selection robustness and feasibility stress for frozen Candidate C.

This is not fresh OOS validation. It reproduces L3 Candidate C exactly before
testing execution, friction, overlap, era, regime, concentration and uncertainty.
"""
from __future__ import annotations
import csv, hashlib, json, math, random
from collections import Counter
from pathlib import Path

import phase_l3 as l3

ROOT=Path(__file__).resolve().parents[2]
DATA=ROOT/"research/hs_leverage/data/00631L-historical-adjusted.json"
L3_EVENTS=ROOT/"research/hs_leverage/output/phase_l3_events.csv"
L3_SUMMARY=ROOT/"research/hs_leverage/output/phase_l3_summary.json"
FREEZE=ROOT/"research/hs_leverage/phase_l2_freeze.json"
OUT=ROOT/"research/hs_leverage/output"
H=(5,10,20,40,60)
VARIANTS=("E0","E1","E2")

def finite(x): return isinstance(x,(int,float)) and math.isfinite(x)
def rnd(x,d=6): return round(x,d) if finite(x) else None
def mean(xs): return sum(xs)/len(xs) if xs else None
def median(xs):
    if not xs:return None
    xs=sorted(xs);m=len(xs)//2
    return xs[m] if len(xs)%2 else (xs[m-1]+xs[m])/2
def quantile(xs,p):
    if not xs:return None
    xs=sorted(xs);z=(len(xs)-1)*p;lo=int(z);hi=math.ceil(z)
    return xs[lo] if lo==hi else xs[lo]+(xs[hi]-xs[lo])*(z-lo)
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def close_enough(a,b):
    if a in (None,"") and b in (None,""): return True
    try:return abs(float(a)-float(b))<=0.0000011
    except (TypeError,ValueError):return False

def reproduce_l3(panel):
    expected=sorted([x for x in csv.DictReader(L3_EVENTS.open(encoding="utf-8")) if x["candidate"]=="C"],key=lambda x:(int(x["oos_year"]),x["entry_date"]))
    recreated=[]
    for year in l3.YEARS:
        th=l3.training_thresholds(panel,year)["C"]
        qualified=[x for x in panel if x["year"]==year and l3.qualifies("C",x,th)]
        for serial,group in enumerate(l3.cluster_entries(qualified),1):
            row=group[0]; item={"event_id":f"C-{year}-{serial:02d}","oos_year":year,"entry_date":row["date"],"event_end":group[-1]["date"],"entry_index":row["index"],"velocity_threshold":th["velocity_5d"],"regime":row["regime"]}
            for h in H:item[f"return_{h}d"],item[f"mae_{h}d"],item[f"mfe_{h}d"]=row[f"return_{h}d"],row[f"mae_{h}d"],row[f"mfe_{h}d"]
            recreated.append(item)
    recreated=sorted(recreated,key=lambda x:(x["oos_year"],x["entry_date"])); discrepancies=[]
    if len(expected)!=len(recreated): discrepancies.append({"type":"event_count","expected":len(expected),"actual":len(recreated)})
    for i,(a,b) in enumerate(zip(expected,recreated)):
        for key in ("entry_date","event_end"):
            if a[key]!=str(b[key]): discrepancies.append({"row":i,"field":key,"expected":a[key],"actual":b[key]})
        if not close_enough(a["velocity_threshold"],b["velocity_threshold"]): discrepancies.append({"row":i,"field":"velocity_threshold","expected":a["velocity_threshold"],"actual":b["velocity_threshold"]})
        for h in H:
            for prefix in ("return","mae","mfe"):
                key=f"{prefix}_{h}d"
                if not close_enough(a[key],b[key]): discrepancies.append({"row":i,"field":key,"expected":a[key],"actual":b[key]})
    return recreated,{"status":"PASS" if not discrepancies else "FAIL","expected_events":len(expected),"reproduced_events":len(recreated),"discrepancies":discrepancies}

def execution_rows(events,source):
    dates=[x["date"] for x in source]; opens=[float(x["open"]) for x in source]; closes=[float(x["close"]) for x in source]
    output=[]
    for event in events:
        signal=event["entry_index"]
        for variant in VARIANTS:
            idx=signal if variant=="E0" else signal+1
            if idx>=len(source):continue
            price=closes[idx] if variant in ("E0","E2") else opens[idx]
            row={"event_id":event["event_id"],"oos_year":event["oos_year"],"signal_date":event["entry_date"],"event_end":event["event_end"],"regime":event["regime"],"variant":variant,"entry_date":dates[idx],"entry_index":idx,"entry_price":rnd(price),"entry_delay_trading_days":0 if variant=="E0" else 1,"next_open_gap":rnd((opens[signal+1]/closes[signal]-1)*100) if signal+1<len(source) else None}
            for h in H:
                if idx+h>=len(source): row[f"return_{h}d"]=row[f"mae_{h}d"]=row[f"mfe_{h}d"]=None;continue
                endpoint=closes[idx+h]; path=[price]+closes[idx:idx+h+1]
                path_returns=[(p/price-1)*100 for p in path]
                row[f"return_{h}d"]=rnd((endpoint/price-1)*100);row[f"mae_{h}d"]=rnd(min(path_returns));row[f"mfe_{h}d"]=rnd(max(path_returns))
            output.append(row)
    return output

def stats(rows,h,return_key=None):
    key=return_key or f"return_{h}d"; valid=[x for x in rows if finite(x.get(key))]; vals=[x[key] for x in valid]
    return {"n":len(vals),"mean":rnd(mean(vals)),"median":rnd(median(vals)),"win_rate":rnd(100*sum(v>0 for v in vals)/len(vals)) if vals else None,"p25":rnd(quantile(vals,.25)),"p75":rnd(quantile(vals,.75)),"mae_median":rnd(median([x[f"mae_{h}d"] for x in valid])) if return_key is None else None,"mfe_median":rnd(median([x[f"mfe_{h}d"] for x in valid])) if return_key is None else None,"worst_mae":rnd(min([x[f"mae_{h}d"] for x in valid])) if valid and return_key is None else None}

def concentration(rows,h):
    valid=sorted([x for x in rows if finite(x[f"return_{h}d"])],key=lambda x:x[f"return_{h}d"])
    return {"full":stats(valid,h),"exclude_best":stats(valid[:-1],h),"exclude_top3":stats(valid[:-3],h),"best_event":valid[-1]["event_id"] if valid else None,"top3_events":[x["event_id"] for x in valid[-3:]]}

def bootstrap(rows,h,seed):
    vals=[x[f"return_{h}d"] for x in rows if finite(x[f"return_{h}d"])]
    rng=random.Random(seed); med=[]
    for _ in range(10000):med.append(median([vals[rng.randrange(len(vals))] for _ in vals]))
    return {"n":len(vals),"observed_median":rnd(median(vals)),"ci95":[rnd(quantile(med,.025)),rnd(quantile(med,.975))],"seed":seed,"resamples":10000}

def one_position(rows,h):
    selected=[];end=-1
    for row in sorted(rows,key=lambda x:x["entry_index"]):
        if row["entry_index"]<end:continue
        selected.append(row);end=row["entry_index"]+h
    return selected

def overlap(rows,h):
    rows=sorted(rows,key=lambda x:x["entry_index"]);active=[];overlaps=0;max_active=0
    for row in rows:
        active=[end for end in active if end>row["entry_index"]]
        if active:overlaps+=1
        active.append(row["entry_index"]+h);max_active=max(max_active,len(active))
    one=one_position(rows,h)
    return {"event_entries":len(rows),"overlapping_entries":overlaps,"overlap_pct":rnd(100*overlaps/len(rows)),"max_simultaneous":max_active,"every_event":stats(rows,h),"one_position_at_a_time":stats(one,h)}

def leave_one_year(rows,h):
    results=[]
    for year in sorted({x["oos_year"] for x in rows}):
        remaining=[x for x in rows if x["oos_year"]!=year];results.append({"removed_year":year,**stats(remaining,h)})
    return min(results,key=lambda x:(float("inf") if x["median"] is None else x["median"]))

def main():
    OUT.mkdir(parents=True,exist_ok=True)
    protected=[FREEZE,L3_EVENTS,L3_SUMMARY,OUT/"phase_l3_yearly.csv",OUT/"phase_l3_report.md"]
    hashes_before={str(p.relative_to(ROOT)):sha(p) for p in protected}
    payload=json.loads(DATA.read_text(encoding="utf-8"));source=sorted(payload["item"]["rows"],key=lambda x:x["date"])
    if payload["metadata"]["price_basis"]!="Adjusted OHLC":raise RuntimeError("Adjusted OHLC safety failed")
    panel,dates,closes=l3.build_panel();events,repro=reproduce_l3(panel)
    if repro["status"]!="PASS":
        (OUT/"phase_l4_summary.json").write_text(json.dumps({"phase":"L4","status":"L3_REPRODUCTION_FAIL","reproduction":repro},indent=2),encoding="utf-8")
        raise RuntimeError("L3_REPRODUCTION_FAIL")
    executions=execution_rows(events,source);byvar={v:[x for x in executions if x["variant"]==v] for v in VARIANTS}
    execution={v:{f"{h}d":stats(byvar[v],h) for h in H} for v in VARIANTS}
    decay={v:{f"{h}d":{"mean":rnd(execution[v][f'{h}d']['mean']-execution['E0'][f'{h}d']['mean']),"median":rnd(execution[v][f'{h}d']['median']-execution['E0'][f'{h}d']['median']),"win_rate":rnd(execution[v][f'{h}d']['win_rate']-execution['E0'][f'{h}d']['win_rate'])} for h in H} for v in ("E1","E2")}
    gaps=[x["next_open_gap"] for x in byvar["E1"] if finite(x["next_open_gap"])]
    gap={"n":len(gaps),"mean":rnd(mean(gaps)),"median":rnd(median(gaps)),"p25":rnd(quantile(gaps,.25)),"p75":rnd(quantile(gaps,.75)),"worst_adverse":rnd(min(gaps)),"best_favorable":rnd(max(gaps))}
    friction={}
    for bps in (0,20,50,100):
        cost=bps/100
        friction[str(bps)]={}
        for h in H:
            vals=[x[f"return_{h}d"]-cost for x in byvar["E1"] if finite(x[f"return_{h}d"])]
            friction[str(bps)][f"{h}d"]={"n":len(vals),"mean":rnd(mean(vals)),"median":rnd(median(vals)),"win_rate":rnd(100*sum(v>0 for v in vals)/len(vals)) if vals else None}
    counts=Counter(x["oos_year"] for x in events);sorted_events=sorted(events,key=lambda x:x["entry_index"]);intervals=[b["entry_index"]-a["entry_index"] for a,b in zip(sorted_events,sorted_events[1:])]
    frequency={"total":len(events),"by_year":{str(y):counts[y] for y in l3.YEARS},"median_per_year":rnd(median(list(counts.get(y,0) for y in l3.YEARS))),"max_per_year":max(counts.values()),"zero_event_years":[y for y in l3.YEARS if counts[y]==0],"interval_trading_days":{"median":rnd(median(intervals)),"min":min(intervals),"max":max(intervals)}}
    l3summary=json.loads(L3_SUMMARY.read_text(encoding="utf-8"));thresholds=[x for x in l3summary["threshold_audit"] if x["candidate"]=="C"]
    threshold_values=[x["thresholds"]["velocity_5d"] for x in thresholds];yearly_threshold=[]
    for i,x in enumerate(thresholds):yearly_threshold.append({"oos_year":x["oos_year"],"threshold":x["thresholds"]["velocity_5d"],"yoy_change":None if i==0 else rnd(x["thresholds"]["velocity_5d"]-threshold_values[i-1]),"yoy_change_pct":None if i==0 else rnd((x["thresholds"]["velocity_5d"]/threshold_values[i-1]-1)*100)})
    positive_changes=sum(x["yoy_change"] is not None and x["yoy_change"]>0 for x in yearly_threshold)
    drift_class="STABLE" if max(threshold_values)/min(threshold_values)<=1.10 else ("GRADUALLY_DRIFTING" if threshold_values[-1]>threshold_values[0] and positive_changes>=5 else "STRUCTURALLY_UNSTABLE")
    threshold_drift={"yearly":yearly_threshold,"min":min(threshold_values),"max":max(threshold_values),"median":rnd(median(threshold_values)),"classification":drift_class}
    eras={}
    for name,years in {"2018-2020":range(2018,2021),"2021-2023":range(2021,2024),"2024-2026_YTD":range(2024,2027)}.items():
        subset=[x for x in byvar["E0"] if x["oos_year"] in years];eras[name]={"events":len(subset),"20d":stats(subset,20),"40d":stats(subset,40),"60d":stats(subset,60)}
    regime={}
    for name in ("BULL","TRANSITION","BEAR"):
        subset=[x for x in byvar["E0"] if x["regime"]==name];regime[name]={"events":len(subset),"20d":stats(subset,20),"40d":stats(subset,40)}
    overlap_result={f"{h}d":overlap(byvar["E0"],h) for h in (20,40,60)}
    baseline=l3summary["baseline"]
    baseline_excess={v:{f"{h}d":{"mean":rnd(execution[v][f'{h}d']['mean']-baseline[f'{h}d']['mean']),"median":rnd(execution[v][f'{h}d']['median']-baseline[f'{h}d']['median']),"win_rate":rnd(execution[v][f'{h}d']['win_rate']-baseline[f'{h}d']['win_rate'])} for h in H} for v in ("E0","E1")}
    top={f"{h}d":concentration(byvar["E1"],h) for h in (20,40,60)}
    loo={f"{h}d":leave_one_year(byvar["E1"],h) for h in (20,40,60)}
    boot={v:{f"{h}d":bootstrap(byvar[v],h,20260822+(0 if v=="E0" else 1000)+h) for h in (20,40)} for v in ("E0","E1")}
    known_prefixes=("2024-08","2025-04","2026-03")
    dominance={f"{h}d":{"top3_events":top[f'{h}d']["top3_events"],"known_case_events_in_top3":[eid for eid in top[f'{h}d']["top3_events"] if any(next(x for x in byvar['E1'] if x['event_id']==eid)['signal_date'].startswith(p) for p in known_prefixes)]} for h in (20,40,60)}
    e1_positive_excess=sum(baseline_excess["E1"][f"{h}d"]["median"]>0 for h in H)
    survives=all(top[f"{h}d"]["exclude_top3"]["mean"]>0 for h in (20,40,60))
    eras_positive=all(eras[e]["20d"]["median"]>0 and eras[e]["40d"]["median"]>0 for e in eras)
    loo_positive=all(loo[f"{h}d"]["median"]>0 for h in (20,40,60))
    friction_ok=all(friction["100"][f"{h}d"]["median"]>0 for h in (20,40,60))
    if e1_positive_excess<3:verdict="EDGE_FAILS_FEASIBILITY"
    elif not (survives and eras_positive and loo_positive and friction_ok):verdict="EDGE_HIGHLY_FRAGILE"
    else:verdict="EDGE_ROBUST_ENOUGH_FOR_RISK_DESIGN"
    robustness_rows=[]
    for h in (20,40,60):
        for label,q in top[f"{h}d"].items():
            if isinstance(q,dict):robustness_rows.append({"analysis":"top_event","horizon":h,"group":label,**q})
        robustness_rows.append({"analysis":"leave_one_year_out","horizon":h,"group":loo[f"{h}d"]["removed_year"],**loo[f"{h}d"]})
        robustness_rows.append({"analysis":"overlap","horizon":h,"group":"all",**{k:v for k,v in overlap_result[f'{h}d'].items() if not isinstance(v,dict)}})
    hashes_after={str(p.relative_to(ROOT)):sha(p) for p in protected}
    summary={"phase":"L4","research_interpretation":{"post_selection_robustness":True,"fresh_independent_oos_validation":False},"l3_reproduction":repro,"data_safety":{"status":"PASS","basis":"ADJUSTED_RESTORED_OHLC_ONLY","source":"research/hs_leverage/data/00631L-historical-adjusted.json"},"protected_files":{"hashes_before":hashes_before,"hashes_after":hashes_after,"unchanged":hashes_before==hashes_after},"execution":execution,"execution_decay":decay,"overnight_gap":gap,"friction_stress_bps":friction,"event_frequency":frequency,"threshold_drift":threshold_drift,"era_robustness":eras,"regime_risk":regime,"event_overlap":overlap_result,"baseline_excess":baseline_excess,"top_event_robustness_e1":top,"known_case_dominance":dominance,"leave_one_year_out_e1":loo,"bootstrap_median":boot,"failure_tests":{"execution_e1_positive_median_excess_horizons":e1_positive_excess,"top3_survival_20_40_60":survives,"all_eras_positive_20_40":eras_positive,"leave_one_year_out_positive_20_40_60":loo_positive,"100bps_positive_median_20_40_60":friction_ok},"verdict":verdict}
    write_csv(OUT/"phase_l4_execution.csv",executions);write_csv(OUT/"phase_l4_robustness.csv",robustness_rows)
    (OUT/"phase_l4_summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding="utf-8");write_report(summary)
    print(json.dumps({"reproduction":repro["status"],"events":len(events),"e1_excess_positive_horizons":e1_positive_excess,"verdict":verdict,"protected_unchanged":hashes_before==hashes_after},ensure_ascii=False))

def write_csv(path,rows):
    fields=sorted({k for row in rows for k in row})
    with path.open("w",newline="",encoding="utf-8") as f:
        w=csv.DictWriter(f,fieldnames=fields);w.writeheader()
        for row in rows:w.writerow({k:"" if v is None else json.dumps(v,ensure_ascii=False) if isinstance(v,(dict,list)) else v for k,v in row.items()})

def write_report(s):
    lines=["# HS LEVERAGE Phase L4 — Post-Selection Robustness / Feasibility","",f"Verdict: **{s['verdict']}**",f"L3 reproduction: **{s['l3_reproduction']['status']}** ({s['l3_reproduction']['reproduced_events']} events)","","## Execution","","| Variant | Horizon | N | Mean | Median | Win | MAE median | MFE median |","|---|---:|---:|---:|---:|---:|---:|---:|"]
    for v in VARIANTS:
        for h in H:
            q=s['execution'][v][f'{h}d'];lines.append(f"| {v} | {h}D | {q['n']} | {q['mean']} | {q['median']} | {q['win_rate']} | {q['mae_median']} | {q['mfe_median']} |")
    lines += ["","## E1 friction stress (net median)","","| Bps | 5D | 10D | 20D | 40D | 60D |","|---:|---:|---:|---:|---:|---:|"]
    for b,q in s['friction_stress_bps'].items():lines.append(f"| {b} | {q['5d']['median']} | {q['10d']['median']} | {q['20d']['median']} | {q['40d']['median']} | {q['60d']['median']} |")
    lines += ["","## Eras","","| Era | N | 20D median | 40D median | 60D median |","|---|---:|---:|---:|---:|"]
    for era,q in s['era_robustness'].items():lines.append(f"| {era} | {q['events']} | {q['20d']['median']} | {q['40d']['median']} | {q['60d']['median']} |")
    lines += ["","## E1 concentration","","| Horizon | Full mean | Ex-best mean | Ex-top3 mean | Full median | Ex-top3 median |","|---|---:|---:|---:|---:|---:|"]
    for h in (20,40,60):
        q=s['top_event_robustness_e1'][f'{h}d'];lines.append(f"| {h}D | {q['full']['mean']} | {q['exclude_best']['mean']} | {q['exclude_top3']['mean']} | {q['full']['median']} | {q['exclude_top3']['median']} |")
    lines += ["","## Interpretation","","This is post-selection robustness, not a fresh independent OOS test. Candidate C and all L2/L3 rules remain unchanged. The decision reflects conservative next-open execution, generic friction, event/era/year removal, overlap, regime risk and bootstrap uncertainty."]
    (OUT/"phase_l4_report.md").write_text("\n".join(lines)+"\n",encoding="utf-8")

if __name__=="__main__":main()
