import importlib.util
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
TAIPEI = ZoneInfo("Asia/Taipei")
spec = importlib.util.spec_from_file_location(
    "intraday_completeness_p02", ROOT / "scripts" / "run_intraday_radar_session.py"
)
runner = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(runner)


def at(value):
    return datetime.fromisoformat(value).replace(tzinfo=TAIPEI)


def successful_attempt(slot, as_of=None):
    return {
        "verified": True,
        "status": "success",
        "slot": slot,
        "trading_date": "2026-08-14",
        "verified_at": f"2026-08-14T{slot}:30+08:00",
        "market_as_of": {"00830": as_of or f"2026-08-14T{slot}:00+08:00"},
        "source": "TWSE_MIS",
    }


# TEST 1: five on-time, idempotent successful slots produce 5/5.
state = runner.new_completeness("2026-08-14")
for slot in runner.TARGET_SLOTS:
    state = runner.record_slot_outcome(
        state, slot, runner.SLOT_SUCCESS, successful_attempt(slot), at(f"2026-08-14T{slot}:30")
    )
assert state["completeness"] == "5/5"
assert state["snapshot_status"] == runner.SNAPSHOT_SUCCESS
assert state["successful_slots"] == list(runner.TARGET_SLOTS)


# TEST 2: a first scheduler tick at 13:50 never backfills; 0/5 is an
# observable operational state, not an integrity failure.
late = runner.reconcile_expired_slots(
    runner.new_completeness("2026-08-14"), at("2026-08-14T13:50:00")
)
assert late["missed_slots"] == list(runner.TARGET_SLOTS)
assert late["successful_slots"] == []
assert late["completeness"] == "0/5"
assert late["snapshot_status"] == runner.SNAPSHOT_MISSED
assert runner.eligible_slot(late, at("2026-08-14T13:50:00")) is None
assert runner.workflow_should_fail(late, at("2026-08-14T13:50:00")) is False
assert late["workflow_status"] == "OPERATIONAL_DEGRADED"


# TEST 3: a 10:30 failure can retry at 10:35 while the legal window remains open.
retry = runner.new_completeness("2026-08-14")
retry = runner.record_slot_outcome(
    retry, "10:30", runner.SLOT_FAILED, {"error": "temporary source error"}, at("2026-08-14T10:31:00")
)
assert runner.eligible_slot(retry, at("2026-08-14T10:35:00")) == "10:30"
retry = runner.record_slot_outcome(
    retry, "10:30", runner.SLOT_SUCCESS, successful_attempt("10:30"), at("2026-08-14T10:35:00")
)
assert retry["slots"]["10:30"]["status"] == runner.SLOT_SUCCESS
assert retry["slots"]["10:30"]["attempts"] == 2


# TEST 4: once 10:30 expires, an 11:30 tick cannot manufacture the old slot.
expired = runner.reconcile_expired_slots(
    runner.new_completeness("2026-08-14"), at("2026-08-14T11:30:00")
)
assert expired["slots"]["10:30"]["status"] == runner.SLOT_MISSED
assert runner.eligible_slot(expired, at("2026-08-14T11:30:00")) == "11:30"
assert runner.workflow_should_fail(expired, at("2026-08-14T11:30:00")) is False


# TEST 5: duplicate successful execution keeps the first production snapshot.
duplicate = runner.new_completeness("2026-08-14")
first = successful_attempt("09:30", "2026-08-14T09:30:00+08:00")
duplicate = runner.record_slot_outcome(
    duplicate, "09:30", runner.SLOT_SUCCESS, first, at("2026-08-14T09:31:00")
)
saved = dict(duplicate["slots"]["09:30"])
duplicate = runner.record_slot_outcome(
    duplicate,
    "09:30",
    runner.SLOT_SUCCESS,
    successful_attempt("09:30", "2026-08-14T09:37:00+08:00"),
    at("2026-08-14T09:37:00"),
)
assert duplicate["slots"]["09:30"] == saved


# TEST 6: all five slots retain their legal execution windows; the prewake
# scheduler may enter from 09:27, but it never permits a +16-minute backfill.
for slot in runner.TARGET_SLOTS:
    target = runner.slot_datetime("2026-08-14", slot)
    state = runner.new_completeness("2026-08-14")
    assert runner.slot_action(target - timedelta(minutes=3), target) == "wait"
    assert runner.upcoming_slot(state, target - timedelta(minutes=3), prewake_minutes=15) == slot
    assert runner.slot_action(target + timedelta(minutes=2), target) == "run"
    assert runner.slot_action(target + timedelta(minutes=14), target) == "run"
    assert runner.slot_action(target + timedelta(minutes=16), target) == "skip"
print("TEST 6 PASS: every slot has prewake and legal retry windows")


# TEST 7: a failed slot remains FAILED with its original source error after
# expiration, while completeness still records that the slot was missed.
failed_expired = runner.new_completeness("2026-08-14")
failed_expired = runner.record_slot_outcome(
    failed_expired, "10:30", runner.SLOT_FAILED, {"error": "radar quote missing: 0050"}, at("2026-08-14T10:32:00")
)
failed_expired = runner.reconcile_expired_slots(failed_expired, at("2026-08-14T10:46:00"))
row = failed_expired["slots"]["10:30"]
assert row["status"] == runner.SLOT_FAILED
assert row["error"] == "radar quote missing: 0050"
assert row["expired"] is True and row["expiry_reason"] == "legal_asof_window_expired"
assert "10:30" in failed_expired["failed_slots"] and "10:30" in failed_expired["missed_slots"]
assert failed_expired["snapshot_status"] == runner.SNAPSHOT_FAILED
print("TEST 7 PASS: failed reason survives expiration")


# TEST 8: only integrity-class failures make the process fail.
integrity = runner.new_completeness("2026-08-14")
integrity = runner.record_slot_outcome(
    integrity,
    "10:30",
    runner.SLOT_FAILED,
    {"error": "same slot conflict", "failure_class": runner.FAILURE_INTEGRITY},
    at("2026-08-14T10:32:00"),
)
assert runner.workflow_should_fail(integrity, at("2026-08-14T10:32:00")) is True
assert integrity["integrity_status"] == "FAIL"
print("TEST 8 PASS: only integrity failure is a non-zero workflow gate")


workflow = (ROOT / ".github" / "workflows" / "update-market-quotes.yml").read_text(encoding="utf-8")
assert 'cron: "27,30,35,40,45 1,2,3,4,5 * * 1-5"' in workflow
assert "--scheduled-once" in workflow
assert "concurrency:" not in workflow
assert "needs: intraday" in workflow and "if: ${{ always() }}" in workflow
print("PASS Reliability V2 scheduler completeness tests 1-8")
