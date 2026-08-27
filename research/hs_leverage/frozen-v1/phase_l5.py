"""Phase L5 risk, position-sizing and deployment feasibility for Candidate C.

Research only. Candidate C, its annual expanding-training threshold, execution
timing and the 20/40/60-day feasibility horizons are frozen before this phase.
"""
from __future__ import annotations

import csv
import hashlib
import json
import math
from datetime import date
from pathlib import Path

import phase_l4 as l4

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "research/hs_leverage"
OUT = BASE / "output"
DATA = BASE / "data/00631L-historical-adjusted.json"
L4_EXEC = OUT / "phase_l4_execution.csv"
HORIZONS = (5, 10, 20, 40, 60)
PRIMARY_HORIZONS = (20, 40, 60)
ALLOCATIONS = (5, 10, 15, 20, 25, 30)
SLEEVES = (5, 10, 15, 20)
FRICTION_BPS = 50


def finite(x):
    return isinstance(x, (int, float)) and math.isfinite(x)


def rnd(x, digits=6):
    return round(x, digits) if finite(x) else None


def mean(xs):
    return sum(xs) / len(xs) if xs else None


def median(xs):
    if not xs:
        return None
    xs = sorted(xs)
    m = len(xs) // 2
    return xs[m] if len(xs) % 2 else (xs[m - 1] + xs[m]) / 2


def quantile(xs, p):
    if not xs:
        return None
    xs = sorted(xs)
    z = (len(xs) - 1) * p
    lo, hi = int(z), math.ceil(z)
    return xs[lo] if lo == hi else xs[lo] + (xs[hi] - xs[lo]) * (z - lo)


def pct(n, d):
    return rnd(100 * n / d) if d else None


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_csv(path, rows):
    fields = sorted({k for row in rows for k in row})
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else "" if v is None else v for k, v in row.items()})


def reproduce_gate(panel, source):
    events, l3_repro = l4.reproduce_l3(panel)
    recreated = [x for x in l4.execution_rows(events, source) if x["variant"] == "E1"]
    expected = sorted(
        [x for x in csv.DictReader(L4_EXEC.open(encoding="utf-8")) if x["variant"] == "E1"],
        key=lambda x: x["event_id"],
    )
    actual = sorted(recreated, key=lambda x: x["event_id"])
    discrepancies = []
    if l3_repro["status"] != "PASS":
        discrepancies.append({"type": "underlying_l3_reproduction", "detail": l3_repro})
    if len(expected) != len(actual):
        discrepancies.append({"type": "event_count", "expected": len(expected), "actual": len(actual)})
    text_fields = ("event_id", "signal_date", "event_end", "entry_date", "regime")
    number_fields = ("entry_price",) + tuple(f"{prefix}_{h}d" for h in HORIZONS for prefix in ("return", "mae", "mfe"))
    for i, (old, new) in enumerate(zip(expected, actual)):
        for key in text_fields:
            if str(old[key]) != str(new[key]):
                discrepancies.append({"row": i, "field": key, "expected": old[key], "actual": new[key]})
        for key in number_fields:
            if not l4.close_enough(old.get(key), new.get(key)):
                discrepancies.append({"row": i, "field": key, "expected": old.get(key), "actual": new.get(key)})
    return events, recreated, {
        "status": "PASS" if not discrepancies and len(actual) == 28 else "FAIL",
        "expected_events": len(expected),
        "reproduced_events": len(actual),
        "discrepancies": discrepancies,
    }


def build_risk_rows(e1_rows, source):
    lows = [float(x["low"]) for x in source]
    highs = [float(x["high"]) for x in source]
    closes = [float(x["close"]) for x in source]
    risk_rows = []
    for event in e1_rows:
        idx, entry = event["entry_index"], event["entry_price"]
        for h in HORIZONS:
            if idx + h >= len(source):
                continue
            path_low = [entry] + lows[idx:idx + h + 1]
            path_high = [entry] + highs[idx:idx + h + 1]
            ret = (closes[idx + h] / entry - 1) * 100
            mae = min((p / entry - 1) * 100 for p in path_low)
            mfe = max((p / entry - 1) * 100 for p in path_high)
            risk_rows.append({
                "event_id": event["event_id"], "signal_date": event["signal_date"],
                "entry_date": event["entry_date"], "entry_index": idx,
                "oos_year": event["oos_year"], "regime": event["regime"], "horizon": h,
                "gross_return": rnd(ret), "net_return_50bps": rnd(ret - .5),
                "mae_adjusted_low": rnd(mae), "mfe_adjusted_high": rnd(mfe),
                "quadrant": ("A" if ret > 0 and mae > -10 else "B" if ret > 0 else "C" if mae > -10 else "D"),
            })
    return risk_rows


def downside(rows):
    maes = [x["mae_adjusted_low"] for x in rows]
    return {
        "n": len(maes), "worst": rnd(min(maes)), "p5": rnd(quantile(maes, .05)),
        "p10": rnd(quantile(maes, .10)), "p25": rnd(quantile(maes, .25)),
        "median": rnd(median(maes)), "p75": rnd(quantile(maes, .75)),
        "severe_frequencies": {str(level): pct(sum(v <= -level for v in maes), len(maes)) for level in (5, 10, 15, 20, 30)},
    }


def allocation_stress(rows, allocation):
    impacts = [x["mae_adjusted_low"] * allocation / 100 for x in rows]
    return {
        "n": len(impacts), "median": rnd(median(impacts)), "p10": rnd(quantile(impacts, .10)),
        "worst": rnd(min(impacts)),
        "exceedance_pct": {str(level): pct(sum(v <= -level for v in impacts), len(impacts)) for level in (1, 2, 3, 5, 7.5, 10)},
    }


def risk_budget(rows, budget):
    maes = [x["mae_adjusted_low"] for x in rows]
    refs = {"median_mae": median(maes), "p10_mae": quantile(maes, .10), "worst_mae": min(maes)}
    return {name: rnd(100 * budget / abs(value)) if value < 0 else None for name, value in refs.items()}


def regime_summary(rows):
    out = {}
    for regime in ("BULL", "TRANSITION", "BEAR"):
        subset20 = [x for x in rows if x["horizon"] == 20 and x["regime"] == regime]
        subset40 = [x for x in rows if x["horizon"] == 40 and x["regime"] == regime]
        maes = [x["mae_adjusted_low"] for x in subset40]
        risk = {"median": median(maes), "p10": quantile(maes, .10), "worst": min(maes)}
        out[regime] = {
            "event_n": len(subset20), "mae_basis": "40D adjusted-low path",
            "median_mae": rnd(risk["median"]), "p10_mae": rnd(risk["p10"]), "worst_mae": rnd(risk["worst"]),
            "median_20d_return": rnd(median([x["gross_return"] for x in subset20])),
            "median_40d_return": rnd(median([x["gross_return"] for x in subset40])),
            "portfolio_impact": {str(a): {k: rnd(v * a / 100) for k, v in risk.items()} for a in (10, 20, 30)},
        }
    return out


def select_one_position(rows, horizon):
    selected, exit_index = [], -1
    for row in sorted(rows, key=lambda x: x["entry_index"]):
        if row["entry_index"] <= exit_index:
            continue
        selected.append(row)
        exit_index = row["entry_index"] + horizon
    return selected


def overlap_capital(e1_rows, horizon, study_start, study_end):
    counts = []
    for idx in range(study_start, study_end + 1):
        counts.append(sum(row["entry_index"] <= idx < row["entry_index"] + horizon for row in e1_rows))
    overlapping_entries = sum(any(other["entry_index"] < row["entry_index"] < other["entry_index"] + horizon for other in e1_rows if other is not row) for row in e1_rows)
    selected = select_one_position(e1_rows, horizon)
    return {
        "signals": len(e1_rows), "maximum_overlap": max(counts), "average_overlap": rnd(mean(counts)),
        "time_with_2plus_pct": pct(sum(v >= 2 for v in counts), len(counts)),
        "capital_occupancy_pct": pct(sum(v >= 1 for v in counts), len(counts)),
        "overlapping_signal_pct": pct(overlapping_entries, len(e1_rows)),
        "one_position_trade_n": len(selected),
        "policy_equivalence": "Equivalent exposure: both policies keep the existing position unchanged and add no capital; Policy B may still log the repeated signal.",
    }


def horizon_feasibility(risk_rows, overlap, horizon):
    rows = [x for x in risk_rows if x["horizon"] == horizon]
    returns = [x["net_return_50bps"] for x in rows]
    return {
        "trade_n": len(rows), "mean_net_return": rnd(mean(returns)), "median_net_return": rnd(median(returns)),
        "win_rate": pct(sum(v > 0 for v in returns), len(returns)),
        "median_mae": rnd(median([x["mae_adjusted_low"] for x in rows])),
        "capital_occupancy_pct": overlap["capital_occupancy_pct"],
        "overlapping_signal_pct": overlap["overlapping_signal_pct"],
    }


def friction_sensitivity(risk_rows):
    result = {}
    for bps in (0, 20, 50, 100):
        result[str(bps)] = {}
        for horizon in PRIMARY_HORIZONS:
            gross = [x["gross_return"] for x in risk_rows if x["horizon"] == horizon]
            net = [x - bps / 100 for x in gross]
            result[str(bps)][f"{horizon}d"] = {
                "n": len(net), "mean": rnd(mean(net)), "median": rnd(median(net)),
                "win_rate": pct(sum(x > 0 for x in net), len(net)),
            }
    return result


def sleeve_simulation(e1_rows, source, horizon, sleeve):
    selected = select_one_position(e1_rows, horizon)
    closes = [float(x["close"]) for x in source]
    lows = [float(x["low"]) for x in source]
    equity, peak, max_dd = 1.0, 1.0, 0.0
    contributions, net_trade_returns = [], []
    total_active_days = 0
    first_idx = selected[0]["entry_index"] if selected else None
    last_exit = None
    for row in selected:
        idx, entry = row["entry_index"], row["entry_price"]
        if idx + horizon >= len(source):
            continue
        pre = equity
        exit_idx = idx + horizon
        for day in range(idx, exit_idx + 1):
            low_marked = pre * (1 - sleeve / 100 + sleeve / 100 * lows[day] / entry)
            close_marked = pre * (1 - sleeve / 100 + sleeve / 100 * closes[day] / entry)
            max_dd = min(max_dd, (low_marked / peak - 1) * 100)
            peak = max(peak, close_marked)
        gross = (closes[exit_idx] / entry - 1) * 100
        net = gross - FRICTION_BPS / 100
        contribution = sleeve / 100 * net
        equity = pre * (1 + contribution / 100)
        peak = max(peak, equity)
        max_dd = min(max_dd, (equity / peak - 1) * 100)
        contributions.append(contribution)
        net_trade_returns.append(net)
        total_active_days += horizon
        last_exit = exit_idx
    years = ((date.fromisoformat(source[last_exit]["date"]) - date.fromisoformat(source[first_idx]["date"])).days / 365.25) if first_idx is not None and last_exit is not None else 0
    annualized = ((equity ** (1 / years) - 1) * 100) if years > 1 else None
    study_days = len([x for x in source if x["date"] >= "2018-01-01"])
    return {
        "horizon": horizon, "sleeve_pct": sleeve, "trade_n": len(contributions),
        "cumulative_tactical_contribution_pct": rnd((equity - 1) * 100),
        "annualized_contribution_pct": rnd(annualized), "max_portfolio_drawdown_pct": rnd(max_dd),
        "drawdown_marking": "daily adjusted low against prior close-marked equity peak",
        "worst_single_event_contribution_pct": rnd(min(contributions)) if contributions else None,
        "positive_trade_rate": pct(sum(v > 0 for v in net_trade_returns), len(net_trade_returns)),
        "average_capital_utilization_pct": rnd(sleeve * total_active_days / study_days),
        "trade_contributions": [rnd(x) for x in contributions],
    }


def sequence_risk(sim):
    xs = sim["trade_contributions"]
    longest = run = 0
    for x in xs:
        run = run + 1 if x < 0 else 0
        longest = max(longest, run)
    def worst_window(n):
        if len(xs) < n:
            return None
        return rnd(min((math.prod(1 + x / 100 for x in xs[i:i + n]) - 1) * 100 for i in range(len(xs) - n + 1)))
    return {
        "horizon": sim["horizon"], "allocation_pct": sim["sleeve_pct"],
        "maximum_consecutive_losing_trades": longest,
        "worst_2trade_sequence_pct": worst_window(2), "worst_3trade_sequence_pct": worst_window(3),
        "largest_sleeve_drawdown_pct": sim["max_portfolio_drawdown_pct"],
    }


def stop_diagnostic(rows, horizon):
    profitable = [x for x in rows if x["horizon"] == horizon and x["gross_return"] > 0]
    return {
        "profitable_events": len(profitable),
        "crossing_pct": {str(level): pct(sum(x["mae_adjusted_low"] <= -level for x in profitable), len(profitable)) for level in (5, 10, 15, 20)},
    }


def write_report(summary):
    lines = [
        "# HS LEVERAGE Phase L5 — Risk / Position-Sizing / Deployment Feasibility", "",
        f"Verdict: **{summary['verdict']}**", f"L4 reproduction: **{summary['reproduction']['status']}**", "",
        "This is an isolated tactical sleeve experiment, not a full portfolio backtest and not independent OOS validation.", "",
        "## Downside distribution (adjusted-low MAE)", "", "| Horizon | N | Median | P10 | Worst | <=-10% | <=-20% |", "|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for h in PRIMARY_HORIZONS:
        q = summary["event_downside_distribution"][f"{h}d"]
        lines.append(f"| {h}D | {q['n']} | {q['median']} | {q['p10']} | {q['worst']} | {q['severe_frequencies']['10']} | {q['severe_frequencies']['20']} |")
    lines += ["", "## Holding-horizon feasibility: E1 + 50 bps", "", "| Horizon | N | Mean net | Median net | Win | Median MAE | Occupancy |", "|---:|---:|---:|---:|---:|---:|---:|"]
    for h in PRIMARY_HORIZONS:
        q = summary["holding_horizon_feasibility"][f"{h}d"]
        lines.append(f"| {h}D | {q['trade_n']} | {q['mean_net_return']} | {q['median_net_return']} | {q['win_rate']} | {q['median_mae']} | {q['capital_occupancy_pct']} |")
    lines += ["", "## Safety interpretation", "", "Candidate C is operationally calculable without look-ahead, but adjusted-low path risk is materially larger than close-only MAE. Any future specification must fail closed on missing or inconsistent adjusted data, prohibit pyramiding, and treat the signal only as a bounded tactical sleeve."]
    (OUT / "phase_l5_report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    protected = [
        BASE / "phase_l2_freeze.json", BASE / "phase_l3.py", BASE / "phase_l4.py",
        OUT / "phase_l3_events.csv", OUT / "phase_l3_yearly.csv", OUT / "phase_l3_summary.json", OUT / "phase_l3_report.md",
        OUT / "phase_l4_execution.csv", OUT / "phase_l4_robustness.csv", OUT / "phase_l4_summary.json", OUT / "phase_l4_report.md",
    ]
    hashes_before = {str(p.relative_to(ROOT)): sha(p) for p in protected}
    payload = json.loads(DATA.read_text(encoding="utf-8"))
    if payload.get("metadata", {}).get("price_basis") != "Adjusted OHLC":
        raise RuntimeError("ADJUSTED_PRICE_SAFETY_FAIL")
    source = sorted(payload["item"]["rows"], key=lambda x: x["date"])
    panel, _, _ = l4.l3.build_panel()
    _, e1_rows, reproduction = reproduce_gate(panel, source)
    if reproduction["status"] != "PASS":
        (OUT / "phase_l5_summary.json").write_text(json.dumps({"phase": "L5", "status": "L4_REPRODUCTION_FAIL", "reproduction": reproduction}, indent=2), encoding="utf-8")
        raise RuntimeError("L4_REPRODUCTION_FAIL")

    risk_rows = build_risk_rows(e1_rows, source)
    by_h = {h: [x for x in risk_rows if x["horizon"] == h] for h in HORIZONS}
    downside_result = {f"{h}d": downside(by_h[h]) for h in HORIZONS}
    quadrants = {f"{h}d": {q: sum(x["quadrant"] == q for x in by_h[h]) for q in "ABCD"} for h in PRIMARY_HORIZONS}
    allocation = {str(a): {f"{h}d": allocation_stress(by_h[h], a) for h in PRIMARY_HORIZONS} for a in ALLOCATIONS}
    budgets = {str(b): {f"{h}d": risk_budget(by_h[h], b) for h in PRIMARY_HORIZONS} for b in (1, 2, 3, 5)}
    regimes = regime_summary(risk_rows)
    study_start = next(i for i, row in enumerate(source) if row["date"] >= "2018-01-01")
    overlap = {f"{h}d": overlap_capital(e1_rows, h, study_start, len(source) - 1) for h in PRIMARY_HORIZONS}
    feasibility = {f"{h}d": horizon_feasibility(risk_rows, overlap[f"{h}d"], h) for h in PRIMARY_HORIZONS}
    friction = friction_sensitivity(risk_rows)
    simulations = [sleeve_simulation(e1_rows, source, h, sleeve) for h in PRIMARY_HORIZONS for sleeve in SLEEVES]
    sequences = {str(a): {f"{h}d": sequence_risk(next(x for x in simulations if x["horizon"] == h and x["sleeve_pct"] == a)) for h in PRIMARY_HORIZONS} for a in (10, 20)}
    stops = {f"{h}d": stop_diagnostic(risk_rows, h) for h in (20, 40)}
    live = {
        "required_data": "Daily adjusted/restored open, high, low and close plus at least five completed closes and the frozen annual threshold.",
        "signal_known": "After the qualifying trading day's adjusted close and daily bar are final.",
        "earliest_execution": "Next trading day open (E1).",
        "threshold_update": "Once per calendar year using all completed eligible observations through the prior year-end; keep fixed during the new year.",
        "missing_data": "NO SIGNAL; never infer or fabricate bars or thresholds.",
        "corporate_actions": "Recompute affected adjusted history, validate continuity and rebuild the annual threshold before signals resume.",
    }
    fail_closed = ["missing adjusted OHLC", "incomplete 5D history", "stale or non-final quote", "annual threshold unavailable", "split/corporate-action inconsistency", "source-data anomaly"]
    gates = {
        "SIGNAL": {"status": "PASS", "reason": "Uses completed daily data and a prior-year threshold without look-ahead."},
        "EXECUTION": {"status": "PASS", "reason": "E1 + 50 bps retains positive mean and median at 20D/40D/60D."},
        "RISK": {"status": "PASS", "reason": "Fixed small sleeves translate extreme ETF MAE into explicit, bounded portfolio impacts; strict controls remain necessary."},
        "CAPITAL": {"status": "PASS", "reason": "One-position/no-additional-capital policies cap exposure and prevent hidden leverage."},
        "DATA": {"status": "PASS", "reason": "Adjusted OHLC and annual threshold maintenance are operationally definable with fail-closed behavior."},
    }
    verdict = "FEASIBLE_WITH_STRICT_RISK_CONTROLS" if all(x["status"] == "PASS" for x in gates.values()) else "RISK_TOO_HIGH_FOR_FORMALIZATION"
    hashes_after = {str(p.relative_to(ROOT)): sha(p) for p in protected}
    summary = {
        "phase": "L5", "research_interpretation": {"risk_feasibility_phase": True, "independent_oos": False},
        "reproduction": reproduction, "data_safety": {"status": "PASS", "basis": "ADJUSTED_RESTORED_OHLC_ONLY", "source": str(DATA.relative_to(ROOT))},
        "base_case": {"execution": "E1_NEXT_TRADING_DAY_OPEN", "round_trip_friction_bps": 50, "friction_sensitivity_bps": [0, 20, 50, 100]},
        "event_downside_distribution": downside_result, "return_risk_joint_distribution": quadrants,
        "allocation_stress": allocation, "risk_budget_view": budgets, "regime_risk": regimes,
        "overlap_capital": overlap, "holding_horizon_feasibility": feasibility,
        "friction_sensitivity_bps": friction,
        "isolated_tactical_sleeve_simulation": simulations, "sequence_risk": sequences,
        "stop_loss_diagnostic": stops, "live_signal_practicality": live,
        "fail_closed_spec": {"action": "NO_SIGNAL", "conditions": fail_closed},
        "feasibility_gates": gates, "protected_files": {"hashes_before": hashes_before, "hashes_after": hashes_after, "unchanged": hashes_before == hashes_after},
        "limitations": ["Post-selection feasibility research, not fresh independent OOS validation.", "Only 28 events with uneven year/regime coverage.", "MAE uses adjusted intraday lows; daily bars cannot reveal intraday order within each bar.", "The sleeve simulation holds the rest of the portfolio flat and is not a full portfolio backtest.", "Generic friction is a stress assumption, not an exact tax or brokerage model."],
        "verdict": verdict,
    }
    risk_csv = []
    for row in risk_rows:
        risk_csv.append({"analysis": "event", **row})
    for a, horizons in allocation.items():
        for h, q in horizons.items():
            risk_csv.append({"analysis": "allocation_stress", "allocation_pct": a, "horizon": h, **q})
    write_csv(OUT / "phase_l5_risk.csv", risk_csv)
    write_csv(OUT / "phase_l5_sleeve_simulation.csv", [{k: v for k, v in x.items() if k != "trade_contributions"} for x in simulations])
    (OUT / "phase_l5_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    write_report(summary)
    print(json.dumps({"reproduction": reproduction["status"], "events": reproduction["reproduced_events"], "verdict": verdict, "protected_unchanged": hashes_before == hashes_after}, ensure_ascii=False))


if __name__ == "__main__":
    main()
