import importlib.util
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
TAIPEI = ZoneInfo("Asia/Taipei")


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


runner = load("hs_live_reliability_runner", ROOT / "scripts" / "run_intraday_radar_session.py")
quotes = load("hs_live_reliability_quotes", ROOT / "scripts" / "update_market_quotes.py")
fixture = json.loads((ROOT / "tests" / "fixtures" / "hs-live-reliability-2026-08-25.json").read_text(encoding="utf-8"))


def at(value):
    return datetime.fromisoformat(value).replace(tzinfo=TAIPEI)


def attempt(slot, row):
    diagnostic = {
        "schema_version": 1,
        "trading_date": fixture["trading_date"],
        "slot": slot,
        "market_fetch": "FAIL",
        "required_symbols": row.get("required_symbols", {}),
        "core_input": "NOT_RUN",
        "score": "NOT_RUN",
        "snapshot_append": "NOT_RUN",
        "failure_class": row.get("failure_class", runner.FAILURE_OPERATIONAL_SOURCE),
        "reason": row.get("error"),
    }
    return {
        "status": "failed",
        "verified": False,
        "trading_date": fixture["trading_date"],
        "slot": slot,
        "error": row.get("error"),
        "failure_class": row.get("failure_class", runner.FAILURE_OPERATIONAL_SOURCE),
        "slot_diagnostic": diagnostic,
    }


# Real 2026-08-25 evidence: operational 0/5 is retained without mutating LKG
# or becoming a global integrity failure.
state = runner.new_completeness(fixture["trading_date"])
state["slots"]["09:30"].update(fixture["slots"]["09:30"])
for slot in ("10:30", "11:30", "12:30"):
    state = runner.record_slot_outcome(state, slot, runner.SLOT_FAILED, attempt(slot, fixture["slots"][slot]), at(f"2026-08-25T{slot}:30"))
state["slots"]["13:30"].update(fixture["slots"]["13:30"])
state = runner.reconcile_closed_slots(state, at("2026-08-25T14:30:00"))
assert state["completeness"] == "0/5"
assert state["successful_slots"] == []
assert state["missed_slots"] == list(runner.TARGET_SLOTS)
assert state["failed_slots"] == []
assert state["contract"] == "HS_LIVE_INTRADAY_SLOT_V4"
assert runner.workflow_should_fail(state, at("2026-08-25T14:30:00")) is False
assert state["slots"]["10:30"]["last_failure"]["reason"].endswith("reason=missing_price")
assert state["slots"]["12:30"]["last_failure"]["reason"] == "urlopen error timed out"
assert fixture["last_known_good"] == {"trading_date": "2026-08-24", "slot": "13:30"}
print("REPLAY PASS: 2026-08-25 0/5 remains operational telemetry; LKG stays 2026-08-24 13:30")


# Hypothetical partial day: successful facts survive failures and produce 3/5.
partial = runner.new_completeness("2026-08-26")
for slot in ("09:30", "11:30", "13:30"):
    success = {
        "verified": True,
        "status": "success",
        "slot": slot,
        "trading_date": "2026-08-26",
        "market_as_of": {"0050": f"2026-08-26T{slot}:00+08:00"},
        "source": "TWSE_MIS",
        "slot_diagnostic": {"market_fetch": "PASS", "core_input": "PASS", "score": "PASS", "snapshot_append": "PASS"},
    }
    partial = runner.record_slot_outcome(partial, slot, runner.SLOT_SUCCESS, success, at(f"2026-08-26T{slot}:30"))
for slot in ("10:30", "12:30"):
    partial = runner.record_slot_outcome(
        partial,
        slot,
        runner.SLOT_FAILED,
        {"error": "temporary source", "failure_class": runner.FAILURE_OPERATIONAL_SOURCE},
        at(f"2026-08-26T{slot}:30"),
    )
assert partial["completeness"] == "3/5"
assert partial["successful_slots"] == ["09:30", "11:30", "13:30"]
assert runner.workflow_should_fail(partial, at("2026-08-26T13:31:00")) is False
print("PARTIAL PASS: 09:30/11:30/13:30 immutable successes produce 3/5 PARTIAL")


# Source semantics: z is the official last traded price.  A populated y or pz
# cannot silently replace an absent z.
parsed, reason = quotes.parse_mis_row({
    "c": "0050", "z": "-", "pz": "102.9", "y": "103.8", "d": "20260825", "t": "10:38:09",
    "o": "102.9", "h": "103.1", "l": "102.4", "v": "31479", "ex": "tse",
}, required=True)
assert parsed is None and reason == "missing_price"
print("SOURCE PASS: missing z stays fail-closed; pz/y are not fabricated into a live quote")


workflow = (ROOT / ".github" / "workflows" / "update-market-quotes.yml").read_text(encoding="utf-8")
assert "group: hs-live-intraday-slot-v4" in workflow
assert "cancel-in-progress: false" in workflow
assert "needs: intraday" in workflow
assert "if: ${{ always() }}" in workflow
assert "node scripts/finalize_core_score_history.js" in workflow
assert 'cron: "*/5 1 * * 1-5"' in workflow
assert 'cron: "*/5 2,3,4,5 * * 1-5"' in workflow
assert 'cron: "0,5,10,15,20,30 6 * * 1-5"' in workflow
print("EOD PASS: finalizer remains always-run; intraday retries are serialized without cancellation")
