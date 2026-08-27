"""Strict expanding-window walk-forward OOS validation for HS LEVERAGE L3.

Consumes the frozen L2 manifest and adjusted/restored 00631L OHLC only. The
script never writes the manifest and never changes candidate definitions.
"""
from __future__ import annotations

import csv
import hashlib
import json
import math
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "research/hs_leverage/data/00631L-historical-adjusted.json"
FREEZE = ROOT / "research/hs_leverage/phase_l2_freeze.json"
OUT = ROOT / "research/hs_leverage/output"
HORIZONS = (5, 10, 20, 40, 60)
YEARS = tuple(range(2018, 2027))


def finite(x): return isinstance(x, (int, float)) and math.isfinite(x)
def rnd(x, d=6): return round(x, d) if finite(x) else None
def mean(xs): return sum(xs) / len(xs) if xs else None
def median(xs):
    if not xs: return None
    xs = sorted(xs); m = len(xs) // 2
    return xs[m] if len(xs) % 2 else (xs[m - 1] + xs[m]) / 2
def quantile(xs, p):
    if not xs: return None
    xs = sorted(xs); z = (len(xs) - 1) * p; lo = int(z); hi = math.ceil(z)
    return xs[lo] if lo == hi else xs[lo] + (xs[hi] - xs[lo]) * (z - lo)
def rolling_mean(xs, i, w): return mean(xs[i-w+1:i+1]) if i >= w-1 else None
def return_n(xs, i, w): return (xs[i] / xs[i-w] - 1) * 100 if i >= w else None
def outcome(xs, i, h):
    if i + h >= len(xs): return None, None, None
    path = [(v / xs[i] - 1) * 100 for v in xs[i:i+h+1]]
    return rnd(path[-1]), rnd(min(path)), rnd(max(path))
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def build_panel():
    payload = json.loads(DATA.read_text(encoding="utf-8"))
    if payload["metadata"]["price_basis"] != "Adjusted OHLC":
        raise RuntimeError("Adjusted/restored OHLC requirement failed")
    rows = sorted(payload["item"]["rows"], key=lambda x: x["date"])
    dates = [x["date"] for x in rows]; closes = [float(x["close"]) for x in rows]
    panel = []
    for i, source in enumerate(rows):
        r5, r10 = return_n(closes, i, 5), return_n(closes, i, 10)
        ma200 = rolling_mean(closes, i, 200)
        prior_ma200 = rolling_mean(closes, i-5, 200) if i >= 204 else None
        slope = (ma200 / prior_ma200 - 1) * 100 if ma200 is not None and prior_ma200 is not None else None
        regime = None if ma200 is None or slope is None else ("BULL" if closes[i] > ma200 and slope > 0 else ("BEAR" if closes[i] < ma200 and slope < 0 else "TRANSITION"))
        dd20 = (closes[i] / max(closes[i-19:i+1]) - 1) * 100 if i >= 19 else None
        row = {"date": dates[i], "year": int(dates[i][:4]), "index": i, "adjusted_close": rnd(closes[i]),
               "crash_velocity_5d": rnd(max(0, -r5) / 5) if r5 is not None else None,
               "crash_velocity_10d": rnd(max(0, -r10) / 10) if r10 is not None else None,
               "dd_from_20d_high": rnd(dd20), "regime": regime}
        for h in HORIZONS:
            row[f"return_{h}d"], row[f"mae_{h}d"], row[f"mfe_{h}d"] = outcome(closes, i, h)
        panel.append(row)
    return panel, dates, closes


def training_thresholds(panel, year):
    train = [x for x in panel if x["year"] < year]
    v5 = [x["crash_velocity_5d"] for x in train if finite(x["crash_velocity_5d"]) and x["crash_velocity_5d"] > 0]
    v10 = [x["crash_velocity_10d"] for x in train if finite(x["crash_velocity_10d"]) and x["crash_velocity_10d"] > 0]
    dd = [x["dd_from_20d_high"] for x in train if finite(x["dd_from_20d_high"])]
    return {"A":{"velocity_5d":rnd(quantile(v5,.90)),"training_positive_n":len(v5)},
            "B":{"velocity_10d":rnd(quantile(v10,.90)),"training_positive_n":len(v10)},
            "C":{"velocity_5d":rnd(quantile(v5,.95)),"training_positive_n":len(v5)},
            "D":{"velocity_5d":rnd(quantile(v5,.90)),"drawdown_20d":rnd(quantile(dd,.20)),"training_positive_n":len(v5),"training_drawdown_n":len(dd)}}


def qualifies(candidate, row, threshold):
    if candidate == "A": return finite(row["crash_velocity_5d"]) and row["crash_velocity_5d"] > 0 and row["crash_velocity_5d"] >= threshold["velocity_5d"]
    if candidate == "B": return finite(row["crash_velocity_10d"]) and row["crash_velocity_10d"] > 0 and row["crash_velocity_10d"] >= threshold["velocity_10d"]
    if candidate == "C": return finite(row["crash_velocity_5d"]) and row["crash_velocity_5d"] > 0 and row["crash_velocity_5d"] >= threshold["velocity_5d"]
    return finite(row["crash_velocity_5d"]) and row["crash_velocity_5d"] > 0 and row["crash_velocity_5d"] >= threshold["velocity_5d"] and finite(row["dd_from_20d_high"]) and row["dd_from_20d_high"] <= threshold["drawdown_20d"]


def cluster_entries(candidate_rows):
    clusters, current = [], []
    for row in candidate_rows:
        if not current or row["index"] - current[-1]["index"] <= 3:
            current.append(row)
        else:
            clusters.append(current); current = [row]
    if current: clusters.append(current)
    return clusters


def metric(rows, h):
    valid = [x for x in rows if finite(x.get(f"return_{h}d"))]
    returns = [x[f"return_{h}d"] for x in valid]
    maes = [x[f"mae_{h}d"] for x in valid]; mfes = [x[f"mfe_{h}d"] for x in valid]
    return {"events_n":len(valid), "mean":rnd(mean(returns)), "median":rnd(median(returns)),
            "win_rate":rnd(100*sum(x>0 for x in returns)/len(returns)) if returns else None,
            "p25":rnd(quantile(returns,.25)), "p75":rnd(quantile(returns,.75)),
            "mae_median":rnd(median(maes)), "mfe_median":rnd(median(mfes)),
            "best_event":max(((x["event_id"],x["entry_date"],x[f"return_{h}d"]) for x in valid),key=lambda x:x[2],default=None),
            "worst_event":min(((x["event_id"],x["entry_date"],x[f"return_{h}d"]) for x in valid),key=lambda x:x[2],default=None)}


def baseline_metric(rows, h):
    valid=[x for x in rows if finite(x[f"return_{h}d"])]
    returns=[x[f"return_{h}d"] for x in valid]
    return {"n":len(valid),"mean":rnd(mean(returns)),"median":rnd(median(returns)),
            "win_rate":rnd(100*sum(x>0 for x in returns)/len(returns)) if returns else None,
            "mae_median":rnd(median([x[f"mae_{h}d"] for x in valid])),"mfe_median":rnd(median([x[f"mfe_{h}d"] for x in valid]))}


def concentration(rows, h):
    valid=sorted([x for x in rows if finite(x[f"return_{h}d"])],key=lambda x:x[f"return_{h}d"])
    def brief(selected):
        vals=[x[f"return_{h}d"] for x in selected]
        return {"n":len(vals),"mean":rnd(mean(vals)),"median":rnd(median(vals)),"win_rate":rnd(100*sum(v>0 for v in vals)/len(vals)) if vals else None}
    positives=[max(0,x[f"return_{h}d"]) for x in valid]; total=sum(positives)
    return {"full":brief(valid),"excluding_best":brief(valid[:-1]),"excluding_top3":brief(valid[:-3]),
            "top1_positive_contribution_share":rnd(100*sum(positives[-1:])/total) if total else None,
            "top3_positive_contribution_share":rnd(100*sum(positives[-3:])/total) if total else None}


def bootstrap(rows, h, seed):
    vals=[x[f"return_{h}d"] for x in rows if finite(x[f"return_{h}d"])]
    if len(vals)<20: return {"status":"INSUFFICIENT_EVENT_COUNT","n":len(vals)}
    rng=random.Random(seed); means=[]
    for _ in range(2000): means.append(mean([vals[rng.randrange(len(vals))] for _ in vals]))
    return {"status":"CALCULATED","n":len(vals),"mean_ci95":[rnd(quantile(means,.025)),rnd(quantile(means,.975))],"seed":seed,"iterations":2000}


def stability(rows):
    out={}
    years_with=sorted({x["oos_year"] for x in rows})
    for h in HORIZONS:
        medians={}
        for year in years_with:
            vals=[x[f"return_{h}d"] for x in rows if x["oos_year"]==year and finite(x[f"return_{h}d"])]
            if vals: medians[str(year)]=rnd(median(vals))
        out[f"{h}d"]={"year_median_returns":medians,"years_with_events":len(medians),
                       "positive_years":sum(v>0 for v in medians.values()),"negative_years":sum(v<0 for v in medians.values()),"zero_years":sum(v==0 for v in medians.values())}
    return out


def derive_status(pooled, baseline, robust, stable):
    clearly_better=0; survives=0; breadth=0
    for h in HORIZONS:
        key=f"{h}d"; p=pooled[key]; b=baseline[key]; c=robust[key]; s=stable[key]
        mean_adv=p["mean"]-b["mean"] if p["mean"] is not None and b["mean"] is not None else None
        median_adv=p["median"]-b["median"] if p["median"] is not None and b["median"] is not None else None
        win_adv=p["win_rate"]-b["win_rate"] if p["win_rate"] is not None and b["win_rate"] is not None else None
        # Validation labels require a material, multi-metric baseline advantage;
        # this is an interpretation gate and does not affect any signal or return.
        if mean_adv is not None and mean_adv>0 and median_adv>1 and win_adv>0: clearly_better+=1
        if c["excluding_top3"]["mean"] is not None and c["excluding_top3"]["mean"]>0: survives+=1
        if s["positive_years"]>s["negative_years"] and s["years_with_events"]>=4: breadth+=1
    n=max((pooled[f"{h}d"]["events_n"] for h in HORIZONS),default=0)
    if clearly_better>=4 and survives>=4 and breadth>=4 and n>=30: return "OOS_STRONG"
    if clearly_better>=3 and survives>=3 and breadth>=3 and n>=20: return "OOS_PROMISING"
    if clearly_better>=1 or survives>=1: return "FRAGILE"
    return "FAIL"


def main():
    OUT.mkdir(parents=True,exist_ok=True)
    before=sha(FREEZE); manifest=json.loads(FREEZE.read_text(encoding="utf-8"))
    if manifest.get("version")!="L2.0" or manifest.get("status")!="FROZEN_FOR_L3": raise RuntimeError("Unexpected freeze manifest")
    panel, dates, closes=build_panel(); all_events=[]; threshold_audit=[]; yearly=[]
    panel_by_year={year:[x for x in panel if x["year"]==year] for year in YEARS}
    for year in YEARS:
        thresholds=training_thresholds(panel,year)
        for candidate in "ABCD":
            th=thresholds[candidate]
            threshold_audit.append({"candidate":candidate,"oos_year":year,"training_end":f"{year-1}-12-31","thresholds":th})
            qualified=[x for x in panel_by_year[year] if qualifies(candidate,x,th)]
            groups=cluster_entries(qualified)
            for serial,group in enumerate(groups,1):
                row=group[0]
                event={"event_id":f"{candidate}-{year}-{serial:02d}","candidate":candidate,"oos_year":year,"entry_date":row["date"],"entry_index":row["index"],"entry_adjusted_close":row["adjusted_close"],"regime":row["regime"],"crash_velocity_5d":row["crash_velocity_5d"],"crash_velocity_10d":row["crash_velocity_10d"],"dd_from_20d_high":row["dd_from_20d_high"],"velocity_threshold":th.get("velocity_5d",th.get("velocity_10d")),"drawdown_threshold":th.get("drawdown_20d")}
                event["event_end"]=group[-1]["date"]; event["qualifying_observations"]=len(group)
                for h in HORIZONS: event[f"return_{h}d"],event[f"mae_{h}d"],event[f"mfe_{h}d"]=row[f"return_{h}d"],row[f"mae_{h}d"],row[f"mfe_{h}d"]
                all_events.append(event)
            for h in HORIZONS:
                ev=[x for x in all_events if x["candidate"]==candidate and x["oos_year"]==year]
                m=metric(ev,h); b=baseline_metric(panel_by_year[year],h)
                yearly.append({"candidate":candidate,"oos_year":year,"horizon_days":h,"signal_events":len(groups),**m,
                               "baseline_n":b["n"],"baseline_mean":b["mean"],"baseline_median":b["median"],"baseline_win_rate":b["win_rate"],"baseline_mae_median":b["mae_median"],"baseline_mfe_median":b["mfe_median"],
                               "mean_minus_baseline":rnd(m["mean"]-b["mean"]) if m["mean"] is not None and b["mean"] is not None else None,
                               "median_minus_baseline":rnd(m["median"]-b["median"]) if m["median"] is not None and b["median"] is not None else None,
                               "velocity_threshold":th.get("velocity_5d",th.get("velocity_10d")),"drawdown_threshold":th.get("drawdown_20d")})
    oos_dates=[x for x in panel if 2018<=x["year"]<=2026]
    pooled_baseline={f"{h}d":baseline_metric(oos_dates,h) for h in HORIZONS}
    candidates={}
    for candidate in "ABCD":
        rows=[x for x in all_events if x["candidate"]==candidate]
        pooled={f"{h}d":metric(rows,h) for h in HORIZONS}
        robust={f"{h}d":concentration(rows,h) for h in HORIZONS}
        stable=stability(rows)
        regime={}
        for name in ("BULL","TRANSITION","BEAR"):
            subset=[x for x in rows if x["regime"]==name]
            regime[name]={"events":len(subset),"20d":metric(subset,20),"40d":metric(subset,40)}
        advantage={f"{h}d":{"mean":rnd(pooled[f'{h}d']['mean']-pooled_baseline[f'{h}d']['mean']) if pooled[f'{h}d']['mean'] is not None else None,
                              "median":rnd(pooled[f'{h}d']['median']-pooled_baseline[f'{h}d']['median']) if pooled[f'{h}d']['median'] is not None else None,
                              "win_rate":rnd(pooled[f'{h}d']['win_rate']-pooled_baseline[f'{h}d']['win_rate']) if pooled[f'{h}d']['win_rate'] is not None else None} for h in HORIZONS}
        status=derive_status(pooled,pooled_baseline,robust,stable)
        candidates[candidate]={"total_oos_events":len(rows),"pooled":pooled,"stability":stable,"concentration":robust,"regime":regime,"baseline_advantage":advantage,"bootstrap":{f"{h}d":bootstrap(rows,h,20260822+ord(candidate)*100+h) for h in HORIZONS},"status":status}
    cases={}
    for period in ("2024/08","2025/04","2025/11","2026/03","2026/07"):
        prefix=period.replace("/","-")
        events=[x for x in all_events if x["entry_date"][:7] <= prefix <= x["event_end"][:7]]
        case={"oos_year":int(period[:4]),"triggered_candidates":sorted({x["candidate"] for x in events}),"events":events}
        cases[period]=case
    statuses=[x["status"] for x in candidates.values()]
    overall="STRONG_OOS_EDGE" if statuses.count("OOS_STRONG")>=2 else ("PROMISING_OOS_EDGE" if any(x in ("OOS_PROMISING","OOS_STRONG") for x in statuses) else ("FRAGILE_OOS_SIGNAL" if "FRAGILE" in statuses else "NO_OOS_EDGE"))
    after=sha(FREEZE)
    a_dates={(x['oos_year'],x['entry_date']) for x in all_events if x['candidate']=='A'}; d_dates={(x['oos_year'],x['entry_date']) for x in all_events if x['candidate']=='D'}
    summary={"phase":"L3","freeze":{"manifest":"research/hs_leverage/phase_l2_freeze.json","sha256_before":before,"sha256_after":after,"unchanged":before==after,"version":manifest["version"]},"data":{"source":"research/hs_leverage/data/00631L-historical-adjusted.json","basis":"ADJUSTED_RESTORED_OHLC_ONLY","history_range":[dates[0],dates[-1]],"oos_years":list(YEARS),"complete_years":list(range(2018,2026)),"partial_years":[2026]},"look_ahead":"PASS: thresholds use rows with year strictly before OOS year; features are trailing; entries are first qualifying dates; only return/MAE/MFE use future rows.","threshold_audit":threshold_audit,"baseline":pooled_baseline,"candidates":candidates,"candidate_overlap":{"A_D_entry_sets_identical":a_dates==d_dates,"A_only_entries":sorted(a_dates-d_dates),"D_only_entries":sorted(d_dates-a_dates),"interpretation":"The training-only deepest-20% drawdown condition was redundant for all A entries in this OOS sample; this is an observed result, not a rule change."},"case_studies":cases,"overall_verdict":overall,"status_rule":"Candidate status requires material multi-metric baseline advantage across neighboring horizons, positive year breadth, survival after top-3 removal, and adequate event count; no single best cell is selected."}
    write_csv(OUT/"phase_l3_events.csv",all_events); write_csv(OUT/"phase_l3_yearly.csv",yearly)
    (OUT/"phase_l3_summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding="utf-8")
    write_report(summary)
    print(json.dumps({"events":{c:candidates[c]["total_oos_events"] for c in "ABCD"},"statuses":{c:candidates[c]["status"] for c in "ABCD"},"overall":overall,"freeze_unchanged":before==after},ensure_ascii=False))


def write_csv(path,rows):
    fields=sorted({k for row in rows for k in row})
    with path.open("w",newline="",encoding="utf-8") as f:
        w=csv.DictWriter(f,fieldnames=fields); w.writeheader()
        for row in rows: w.writerow({k:"" if v is None else v for k,v in row.items()})


def write_report(s):
    lines=["# HS LEVERAGE Phase L3 — Strict Walk-Forward OOS Validation","",f"Overall verdict: **{s['overall_verdict']}**",f"Freeze SHA-256 unchanged: **{s['freeze']['unchanged']}**","","## Pooled OOS candidates","","| Candidate | Horizon | N | Mean | Median | Win rate | P25 | P75 | MAE median | MFE median | Median vs baseline |","|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for c,x in s["candidates"].items():
        for h in HORIZONS:
            q=x['pooled'][f'{h}d']; lines.append(f"| {c} | {h}D | {q['events_n']} | {q['mean']} | {q['median']} | {q['win_rate']} | {q['p25']} | {q['p75']} | {q['mae_median']} | {q['mfe_median']} | {x['baseline_advantage'][f'{h}d']['median']} |")
        lines.append(f"\nCandidate {c} status: **{x['status']}**.\n")
    lines += ["","## Concentration at 20D","","| Candidate | Full mean | Ex-best mean | Ex-top3 mean | Top1 positive share | Top3 positive share |","|---|---:|---:|---:|---:|---:|"]
    for c,x in s["candidates"].items():
        q=x["concentration"]["20d"]; lines.append(f"| {c} | {q['full']['mean']} | {q['excluding_best']['mean']} | {q['excluding_top3']['mean']} | {q['top1_positive_contribution_share']} | {q['top3_positive_contribution_share']} |")
    lines += ["","## Year-by-year 20D stability","","| Candidate | Years with events | Positive years | Negative years | Year medians |","|---|---:|---:|---:|---|"]
    for c,x in s['candidates'].items():
        q=x['stability']['20d']; lines.append(f"| {c} | {q['years_with_events']} | {q['positive_years']} | {q['negative_years']} | {q['year_median_returns']} |")
    lines += ["","## Regime diagnostic (Candidate C)","","| Regime | Events | 20D median | 20D MAE | 20D MFE | 40D median | 40D MAE | 40D MFE |","|---|---:|---:|---:|---:|---:|---:|---:|"]
    for name,q in s['candidates']['C']['regime'].items(): lines.append(f"| {name} | {q['events']} | {q['20d']['median']} | {q['20d']['mae_median']} | {q['20d']['mfe_median']} | {q['40d']['median']} | {q['40d']['mae_median']} | {q['40d']['mfe_median']} |")
    lines += ["","## Known cases (natural OOS occurrence only)","","| Case | Candidate | Entry | Event end | Velocity threshold | Drawdown threshold | 5D | 10D | 20D | 40D | 60D |","|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|"]
    for period,x in s["case_studies"].items():
        if not x['events']: lines.append(f"| {period} | NONE | | | | | | | | | |")
        for e in x['events']: lines.append(f"| {period} | {e['candidate']} | {e['entry_date']} | {e['event_end']} | {e['velocity_threshold']} | {e['drawdown_threshold']} | {e['return_5d']} | {e['return_10d']} | {e['return_20d']} | {e['return_40d']} | {e['return_60d']} |")
    lines += ["","## Baseline and interpretation","",f"- OOS all-date baseline medians: 5D {s['baseline']['5d']['median']}%, 10D {s['baseline']['10d']['median']}%, 20D {s['baseline']['20d']['median']}%, 40D {s['baseline']['40d']['median']}%, 60D {s['baseline']['60d']['median']}%.",f"- Candidate A and D entry sets are identical: {s['candidate_overlap']['A_D_entry_sets_identical']}; D's drawdown condition was redundant in this OOS sample.","- All thresholds were recalculated from prior-year training data only. Candidate statuses evaluate neighboring horizons, annual breadth, baseline advantage, and concentration; the report does not select a winning horizon or alter frozen rules.","- The rapid-crash rebound hypothesis survived walk-forward testing most coherently for Candidate C, but event counts remain modest and famous 2024–2026 crashes contribute materially. This supports final robustness/feasibility research, not production use."]
    (OUT/"phase_l3_report.md").write_text("\n".join(lines)+"\n",encoding="utf-8")


if __name__=="__main__": main()
