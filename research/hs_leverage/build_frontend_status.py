"""Publish a read-only 00631L UI status from validated daily Shadow artifacts.

This module does not evaluate signals or mutate operational ledgers.
"""
from __future__ import annotations

import argparse
import json
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

import phase_l7_daily as daily
import phase_l7_shadow as shadow

OUTPUT = "00631l-leverage-status-v1.json"


def require(value, reason):
    if not value:
        raise ValueError(reason)


def build(root: Path, expected_completed_bar: str, next_completed_bar: str | None = None) -> dict:
    policy = shadow.read_json(root / "research/hs_leverage/phase_l7_forward_policy.json")
    forward = root / "research/hs_leverage/forward"
    status = shadow.read_json(forward / "daily-status.json")
    price = shadow.read_json(forward / "00631L-adjusted-daily.json")
    ledger = root / policy["paths"]["forward_ledger"]
    outcomes = root / policy["paths"]["outcomes_ledger"]
    records, realized = daily.validate_ledgers(ledger, outcomes, policy)
    rows, metadata = price["item"]["rows"], price["metadata"]
    daily.validate_rows(rows)
    require(policy["strategy_id"] == "HS_LEVERAGE_C_V1" and policy["status"] == "FORWARD_SHADOW_ACTIVE", "INVALID_POLICY")
    require(status.get("data_integrity") == "PASS" and status.get("status") != "FAIL_CLOSED" and status.get("dry_run") is False, "VALIDATION_NOT_SUCCESSFUL")
    require(metadata.get("ticker") == "00631L" and metadata.get("frequency") == "1d" and metadata.get("price_basis") == "Adjusted OHLC", "INVALID_PRICE_SOURCE")
    latest_bar = rows[-1]["date"]
    require(latest_bar == status.get("latest_data_date") == metadata.get("expected_completed_bar"), "PRICE_STATUS_DATE_MISMATCH")
    require(latest_bar <= expected_completed_bar, "FUTURE_PRICE_BAR")
    require(metadata.get("data_version") == status.get("data_version"), "PRICE_VERSION_MISMATCH")
    counts = daily.summarize(records, realized)
    for key in ("forward_observations", "eligible_observations", "pending_outcomes", "completed_outcomes", "outcomes_by_horizon"):
        require(status.get(key) == counts[key], "STATUS_LEDGER_MISMATCH:" + key)
    for key in ("production_signal", "live_capital", "capital_allocation_pct"):
        require(status.get(key) == policy.get(key), "STATUS_POLICY_MISMATCH:" + key)
    checked_at = status.get("checked_at")
    checked = datetime.fromisoformat(checked_at)
    require(checked.tzinfo is not None, "INVALID_VALIDATION_TIME")
    evaluations = [record for record in records if record.get("record_type") == "SIGNAL_EVALUATION"]
    last = evaluations[-1] if evaluations else None
    evaluation_date = last.get("evaluation_date") if last else None
    require(evaluation_date is None or evaluation_date <= latest_bar, "FUTURE_EVALUATION")
    current = last if evaluation_date == latest_bar else None
    require(current is None or current.get("fail_closed_reason") is None, "CURRENT_EVALUATION_FAILED")
    horizon = status["outcomes_by_horizon"]
    return {
        "schema_version": 1,
        "symbol": "00631L",
        "strategy_id": policy["strategy_id"],
        "generated_at": checked_at,
        "price": {"latest_completed_bar": latest_bar,
                  "expected_completed_bar": expected_completed_bar,
                  "freshness": "CURRENT" if latest_bar == expected_completed_bar and next_completed_bar else "STALE" if latest_bar < expected_completed_bar else "UNKNOWN",
                  "stale_after": datetime.combine(date.fromisoformat(next_completed_bar), time(16, 30), daily.TAIPEI).isoformat() if next_completed_bar else None},
        "shadow": {"status": policy["status"], "latest_evaluation_date": evaluation_date,
                   "triggered": current.get("signal_triggered") if current else None,
                   "trigger_date": current.get("evaluation_date") if current and current.get("signal_triggered") else None,
                   "signal_value": current.get("crash_velocity_5d") if current and current.get("signal_triggered") else None,
                   "threshold": current.get("annual_threshold") if current and current.get("signal_triggered") else None,
                   "eligible_count": counts["eligible_observations"],
                   "observation_count": counts["forward_observations"]},
        "outcomes": {f"{state}_{h}d": horizon[str(h)][state] for state in ("pending", "completed") for h in (20, 40, 60)},
        "capital": {"production_signal": policy["production_signal"],
                    "live_capital": policy["live_capital"], "allocation_pct": policy["capital_allocation_pct"]},
        "workflow": {"validation_at": checked_at,
                     "run_id": status.get("workflow_run_id"),
                     "last_successful_validation_at": None},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=shadow.ROOT)
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()
    now = datetime.now(timezone.utc)
    holidays = daily.calendar_days(daily.fetch_json(daily.CALENDAR_URL), now.astimezone(daily.TAIPEI).year)
    expected = daily.expected_day(now, holidays)
    next_day = date.fromisoformat(expected) + timedelta(days=1)
    next_completed = None
    for _ in range(20):
        if next_day.year != now.astimezone(daily.TAIPEI).year:
            break
        if next_day.weekday() < 5 and next_day.isoformat() not in holidays:
            next_completed = next_day.isoformat()
            break
        next_day += timedelta(days=1)
    result = build(args.root, expected, next_completed)
    output = args.output or args.root / OUTPUT
    daily.atomic_json(output, result)
    print(json.dumps({"output": str(output), "latest_completed_bar": result["price"]["latest_completed_bar"],
                      "freshness": result["price"]["freshness"]}))


if __name__ == "__main__":
    main()
