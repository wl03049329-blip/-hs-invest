"""Manual, append-only forward shadow evaluator for frozen HS_LEVERAGE_C_V1.

No broker, scheduler, capital allocation, UI, or production signal is present.
The official ledger is forward-only: source rows before forward_start_date can only
be used in TEST_MODE or integrity checks, never as official observations.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "research/hs_leverage"
OUT = BASE / "output"
DATA = BASE / "data/00631L-historical-adjusted.json"
SPEC = BASE / "phase_l6_spec.json"
SCHEMA = BASE / "phase_l6_shadow_schema.json"
POLICY = BASE / "phase_l7_forward_policy.json"
L3_SUMMARY = OUT / "phase_l3_summary.json"
STATES = {"IDLE", "SIGNAL_PENDING", "ENTRY_ELIGIBLE", "ACTIVE", "COOLDOWN_HOLDING", "CLOSED", "FAIL_CLOSED"}
HORIZONS = (5, 10, 20, 40, 60)
PROVENANCE_DIR = "research/hs_leverage/frozen-v1"
# Recovery-only mirrors for the seven files restored from the exact frozen V1
# bundle.  Hash authority remains phase_l7_forward_policy.json.
PROVENANCE_SCOPE = (
    ("research/hs_leverage/phase_l3.py", "phase_l3.py"),
    ("research/hs_leverage/phase_l4.py", "phase_l4.py"),
    ("research/hs_leverage/phase_l5.py", "phase_l5.py"),
    ("research/hs_leverage/phase_l6_spec.json", "phase_l6_spec.json"),
    ("research/hs_leverage/phase_l6_risk_policy.md", "phase_l6_risk_policy.md"),
    ("research/hs_leverage/phase_l6_shadow_schema.json", "phase_l6_shadow_schema.json"),
    ("research/hs_leverage/output/phase_l6_report.md", "output/phase_l6_report.md"),
)


class IntegrityError(RuntimeError):
    """A frozen-rule or data-integrity failure that must fail closed."""


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def payload_hash(record, previous_hash):
    payload = {k: v for k, v in record.items() if k not in {"record_hash", "previous_record_hash"}}
    return hashlib.sha256((canonical(payload) + "|" + str(previous_hash)).encode("utf-8")).hexdigest()


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_provenance(policy, root=ROOT):
    """Fail closed unless each recovery mirror matches policy and working bytes."""
    for relative, mirror_relative in PROVENANCE_SCOPE:
        expected = policy["protected_hashes"][relative]
        working = root / relative
        mirror = root / PROVENANCE_DIR / mirror_relative
        if not mirror.exists() or sha(mirror) != expected:
            raise IntegrityError("PROVENANCE_ARTIFACT_HASH_MISMATCH:" + relative)
        if not working.exists() or working.read_bytes() != mirror.read_bytes():
            raise IntegrityError("WORKING_PROVENANCE_BYTE_MISMATCH:" + relative)
    return True


def read_jsonl(path):
    if not path.exists() or not path.read_text(encoding="utf-8").strip():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def validate_hash_chain(path):
    previous = None
    seen = set()
    for index, record in enumerate(read_jsonl(path)):
        if record.get("record_id") in seen:
            return {"status": "FAIL", "index": index, "reason": "DUPLICATE_RECORD_ID"}
        seen.add(record.get("record_id"))
        if record.get("previous_record_hash") != previous:
            return {"status": "FAIL", "index": index, "reason": "PREVIOUS_HASH_MISMATCH"}
        expected = payload_hash(record, previous)
        if record.get("record_hash") != expected:
            return {"status": "FAIL", "index": index, "reason": "RECORD_HASH_MISMATCH"}
        previous = record["record_hash"]
    return {"status": "PASS", "record_count": len(seen), "head_hash": previous}


def append_record(path, record):
    existing = read_jsonl(path)
    if any(x.get("record_id") == record.get("record_id") for x in existing):
        return {"status": "NOOP_ALREADY_RECORDED", "record_id": record["record_id"]}
    chain = validate_hash_chain(path)
    if chain["status"] != "PASS":
        raise IntegrityError("HASH_CHAIN_INVALID")
    record = dict(record)
    record["previous_record_hash"] = chain["head_hash"]
    record["record_hash"] = payload_hash(record, chain["head_hash"])
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(canonical(record) + "\n")
    return {"status": "APPENDED", "record_id": record["record_id"], "record_hash": record["record_hash"]}


def load_context(root=ROOT):
    base = root / "research/hs_leverage"
    policy = read_json(base / "phase_l7_forward_policy.json")
    spec = read_json(base / "phase_l6_spec.json")
    schema = read_json(base / "phase_l6_shadow_schema.json")
    if spec["specification"]["strategy_id"] != "HS_LEVERAGE_C_V1":
        raise IntegrityError("STRATEGY_ID_MISMATCH")
    if spec["signal_identity"]["formula"]["crash_velocity_5d"] != "max(0, -ret_5d) / 5":
        raise IntegrityError("FROZEN_FORMULA_MISMATCH")
    if not spec["annual_threshold_policy"]["frequency"] == "ONCE_PER_CALENDAR_YEAR":
        raise IntegrityError("THRESHOLD_POLICY_MISMATCH")
    if schema.get("x-ledger-mode") != "APPEND_ONLY":
        raise IntegrityError("LEDGER_SCHEMA_MISMATCH")
    for relative, expected in policy["protected_hashes"].items():
        if sha(root / relative) != expected:
            raise IntegrityError("PROTECTED_ARTIFACT_HASH_MISMATCH:" + relative)
    validate_provenance(policy, root)
    data = read_json(base / "data/00631L-historical-adjusted.json")
    if data.get("metadata", {}).get("price_basis") != "Adjusted OHLC":
        raise IntegrityError("ADJUSTED_PRICE_BASIS_FAIL")
    l3 = read_json(root / "research/hs_leverage/output/phase_l3_summary.json")
    audit = [x for x in l3["threshold_audit"] if x["candidate"] == "C" and x["oos_year"] == 2026]
    if len(audit) != 1:
        raise IntegrityError("THRESHOLD_ARTIFACT_MISSING")
    frozen = policy["threshold"]
    if audit[0]["training_end"] != frozen["threshold_training_end"] or abs(audit[0]["thresholds"]["velocity_5d"] - frozen["threshold_value"]) > 1e-9:
        raise IntegrityError("THRESHOLD_INTEGRITY_FAIL")
    return policy, data


def valid_bar(row):
    required = ("date", "open", "high", "low", "close")
    if any(key not in row or row[key] is None for key in required):
        return "MISSING_ADJUSTED_OHLC"
    try:
        open_, high, low, close = (float(row[k]) for k in ("open", "high", "low", "close"))
    except (TypeError, ValueError):
        return "INVALID_OHLC"
    if min(open_, high, low, close) <= 0 or low > min(open_, close) or high < max(open_, close):
        return "INVALID_OHLC"
    return None


def number_or_none(value):
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def validate_history(rows, symbol):
    if symbol != "00631L":
        return "SYMBOL_MISMATCH"
    prior = None
    for row in rows:
        reason = valid_bar(row)
        if reason:
            return reason
        if prior is not None and row["date"] <= prior:
            return "DUPLICATE_OR_NONCHRONOLOGICAL_DATE"
        prior = row["date"]
    return None


def source_freshness_error(data, policy):
    generated = data.get("metadata", {}).get("generated_at")
    if not generated:
        return "SOURCE_TIMESTAMP_ANOMALY"
    try:
        generated_at = datetime.fromisoformat(generated)
    except ValueError:
        return "SOURCE_TIMESTAMP_ANOMALY"
    age_hours = (datetime.now(timezone.utc) - generated_at.astimezone(timezone.utc)).total_seconds() / 3600
    if age_hours < 0 or age_hours > policy["data_contract"]["maximum_source_age_hours"]:
        return "STALE_ADJUSTED_OHLC"
    return None


def crash_velocity(rows, index):
    if index < 5:
        raise IntegrityError("INSUFFICIENT_5D_LOOKBACK")
    close_now, close_then = float(rows[index]["close"]), float(rows[index - 5]["close"])
    # L3 freezes returns and therefore CrashVelocity5 in percentage-point units.
    # The 2026 threshold (2.033335) is in the same unit, not decimal-return units.
    ret = (close_now / close_then - 1) * 100
    return ret, max(0.0, -ret) / 5


def regime_for(index, rows):
    if index < 60:
        return "TRANSITION"
    close, ma = float(rows[index]["close"]), sum(float(x["close"]) for x in rows[index - 59:index + 1]) / 60
    return "BULL" if close > ma * 1.02 else "BEAR" if close < ma * .98 else "TRANSITION"


def latest_state(records):
    for record in reversed(records):
        if record.get("record_type") == "SIGNAL_EVALUATION":
            return record["state_after"]
    return "IDLE"


def evaluate(rows, index, policy, state_before="IDLE", test_mode=False):
    row = rows[index]
    reason = valid_bar(row) or ("INSUFFICIENT_5D_LOOKBACK" if index < 5 else None)
    threshold = policy["threshold"]
    if not threshold.get("threshold_version") or threshold.get("threshold_value") is None:
        reason = reason or "THRESHOLD_INVALID"
    ret, velocity = crash_velocity(rows, index) if reason is None and index >= 5 else (None, None)
    triggered = bool(reason is None and velocity >= threshold["threshold_value"])
    repeat = state_before in {"SIGNAL_PENDING", "ENTRY_ELIGIBLE", "ACTIVE", "COOLDOWN_HOLDING"} and triggered
    if reason:
        state_after = "FAIL_CLOSED"
    elif state_before == "FAIL_CLOSED":
        state_after = "FAIL_CLOSED"
        reason = "RECOVERY_ACTION_REQUIRED"
        triggered = False
    elif state_before == "SIGNAL_PENDING":
        state_after = "COOLDOWN_HOLDING"
    elif state_before in {"ENTRY_ELIGIBLE", "ACTIVE", "COOLDOWN_HOLDING"}:
        state_after = "COOLDOWN_HOLDING"
    elif triggered:
        state_after = "SIGNAL_PENDING"
    else:
        state_after = "IDLE"
    next_date = rows[index + 1]["date"] if index + 1 < len(rows) else None
    entry_reference = float(row["open"]) if state_before == "SIGNAL_PENDING" else None
    regime = regime_for(index, rows) if reason is None else None
    return {
        "record_type": "SIGNAL_EVALUATION",
        "record_id": f"EVAL:{policy['strategy_id']}:{row['date']}",
        "strategy_id": policy["strategy_id"], "strategy_version": policy["strategy_version"],
        "evaluation_date": row["date"], "symbol": "00631L",
        "adjusted_open": number_or_none(row.get("open")), "adjusted_high": number_or_none(row.get("high")),
        "adjusted_low": number_or_none(row.get("low")), "adjusted_close": number_or_none(row.get("close")),
        "ret_5d": ret, "crash_velocity_5d": velocity,
        "annual_threshold": threshold["threshold_value"],
        "distance_to_threshold": None if velocity is None else velocity - threshold["threshold_value"],
        "threshold_version": threshold["threshold_version"],
        "threshold_training_end": threshold["threshold_training_end"],
        "signal_triggered": triggered, "signal_status": "TRIGGERED" if triggered else "NO_SIGNAL",
        "market_regime": regime,
        "risk_warning": "HIGHER_PATH_RISK" if regime == "BEAR" else None,
        "state_before": state_before, "state_after": state_after, "repeat_signal": repeat,
        "data_as_of": row["date"] + "T23:59:59+08:00",
        "data_source": "research/hs_leverage/data/00631L-historical-adjusted.json",
        "data_version": "adjusted_ohlc_v1", "adjustment_status": "VALIDATED_ADJUSTED",
        "corporate_action_status": "REVALIDATED", "fail_closed_reason": reason,
        "signal_date": row["date"] if triggered else None,
        "planned_entry_date": next_date if triggered else None,
        "planned_entry_reference": "NEXT_OPEN" if triggered else None,
        "shadow_entry_reference": entry_reference,
        "calculated_at": "TEST_MODE" if test_mode else datetime.now(timezone.utc).isoformat(),
        "forward_start_date": policy["forward_start_date"],
        "live_capital": False, "capital_allocation_pct": 0, "test_mode": test_mode
    }


def mature_outcomes(signal_record, rows, entry_index, policy, test_mode=False):
    if signal_record.get("shadow_entry_reference") is None:
        return []
    entry = signal_record["shadow_entry_reference"]
    output = []
    for horizon in HORIZONS:
        end = entry_index + horizon
        if end >= len(rows):
            continue
        low = min(float(x["low"]) for x in rows[entry_index:end + 1])
        high = max(float(x["high"]) for x in rows[entry_index:end + 1])
        output.append({
            "record_type": "REALIZED_OUTCOME", "record_id": f"OUTCOME:{signal_record['record_id']}:{horizon}D",
            "signal_record_id": signal_record["record_id"], "strategy_id": policy["strategy_id"],
            "strategy_version": policy["strategy_version"], "horizon": horizon,
            "entry_reference": entry, "end_date": rows[end]["date"],
            "forward_return": (float(rows[end]["close"]) / entry - 1) * 100,
            "mae": (low / entry - 1) * 100, "mfe": (high / entry - 1) * 100,
            "outcome_calculated_at": "TEST_MODE" if test_mode else datetime.now(timezone.utc).isoformat(),
            "test_mode": test_mode
        })
    return output


def fail_closed_record(rows, policy, state_before, reason):
    record = evaluate(rows, len(rows) - 1, policy, state_before=state_before)
    record.update({
        "record_id": f"FAIL:{policy['strategy_id']}:{rows[-1]['date']}:{reason}",
        "signal_triggered": False, "signal_status": "NO_SIGNAL", "signal_date": None,
        "planned_entry_date": None, "planned_entry_reference": None,
        "shadow_entry_reference": None, "repeat_signal": False,
        "state_after": "FAIL_CLOSED", "fail_closed_reason": reason,
        "market_regime": None, "risk_warning": None
    })
    return record


def append_mature_outcomes(ledger_path, outcomes_path, rows, policy):
    """Append only horizons whose entry-to-end trading bars now exist."""
    existing = {x.get("record_id") for x in read_jsonl(outcomes_path)}
    appended = []
    index_by_date = {row["date"]: i for i, row in enumerate(rows)}
    for signal in read_jsonl(ledger_path):
        if signal.get("record_type") != "SIGNAL_EVALUATION" or signal.get("shadow_entry_reference") is None:
            continue
        entry_index = index_by_date.get(signal.get("evaluation_date"))
        if entry_index is None:
            continue
        for outcome in mature_outcomes(signal, rows, entry_index, policy):
            if outcome["record_id"] not in existing:
                appended.append(append_record(outcomes_path, outcome))
                existing.add(outcome["record_id"])
    return appended


def initialize(policy, root=ROOT):
    path = root / policy["paths"]["forward_ledger"]
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and read_jsonl(path):
        return {"status": "NOOP_ALREADY_INITIALIZED", "record_count": len(read_jsonl(path))}
    record = {
        "record_type": "FORWARD_LEDGER_INITIALIZATION", "record_id": "L7_INIT_20260822",
        "strategy_id": policy["strategy_id"], "strategy_version": policy["strategy_version"],
        "status": "FORWARD_SHADOW_ACTIVE", "live_capital": False, "production_signal": False,
        "capital_allocation_pct": 0, "forward_start_date": policy["forward_start_date"],
        "first_eligible_observation_date": policy["first_eligible_observation_date"],
        "historical_shadow_backfill": False, "threshold_version": policy["threshold"]["threshold_version"],
        "threshold_value": policy["threshold"]["threshold_value"], "initialized_at": policy["activation_date"] + "T00:00:00+08:00"
    }
    result = append_record(path, record)
    (root / policy["paths"]["outcomes_ledger"]).touch(exist_ok=True)
    return result


def run_manual(evaluate_latest=False):
    policy, data = load_context()
    init = initialize(policy)
    ledger_path = ROOT / policy["paths"]["forward_ledger"]
    outcomes_path = ROOT / policy["paths"]["outcomes_ledger"]
    rows = sorted(data["item"]["rows"], key=lambda x: x["date"])
    history_error = validate_history(rows, data["metadata"].get("ticker"))
    freshness_error = source_freshness_error(data, policy)
    result = {"initialization": init, "forward_start_date": policy["forward_start_date"], "latest_completed_bar": rows[-1]["date"], "ledger": validate_hash_chain(ledger_path), "outcomes": validate_hash_chain(outcomes_path)}
    if history_error or freshness_error:
        reason = history_error or freshness_error
        if rows[-1]["date"] >= policy["forward_start_date"]:
            record = fail_closed_record(rows, policy, latest_state(read_jsonl(ledger_path)), reason)
            result.update({"status": append_record(ledger_path, record)["status"], "fail_closed_reason": reason, "state_after": "FAIL_CLOSED"})
        else:
            result.update({"status": "WAITING_FOR_NEXT_COMPLETED_TRADING_DAY", "pre_boundary_integrity_status": reason})
        return result
    result["mature_outcomes_appended"] = append_mature_outcomes(ledger_path, outcomes_path, rows, policy)
    if not evaluate_latest or rows[-1]["date"] < policy["forward_start_date"]:
        result["status"] = "WAITING_FOR_NEXT_COMPLETED_TRADING_DAY"
        return result
    records = read_jsonl(ledger_path)
    state = latest_state(records)
    record = evaluate(rows, len(rows) - 1, policy, state_before=state)
    appended = append_record(ledger_path, record)
    result.update({"status": appended["status"], "evaluation_date": record["evaluation_date"], "signal_triggered": record["signal_triggered"], "state_after": record["state_after"]})
    return result


def main():
    parser = argparse.ArgumentParser(description="Manual HS_LEVERAGE_C_V1 forward shadow evaluator")
    parser.add_argument("--evaluate-latest", action="store_true", help="Evaluate only if latest source bar is on/after forward_start_date.")
    args = parser.parse_args()
    try:
        print(json.dumps(run_manual(args.evaluate_latest), ensure_ascii=False, indent=2))
    except IntegrityError as exc:
        print(json.dumps({"status": "FAIL_CLOSED", "reason": str(exc)}, ensure_ascii=False, indent=2))
        raise SystemExit(2)


if __name__ == "__main__":
    main()
