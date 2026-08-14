import importlib.util
from datetime import datetime
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


# TEST 2: a first scheduler tick at 13:50 never backfills and is an abnormal 0/5.
late = runner.reconcile_expired_slots(
    runner.new_completeness("2026-08-14"), at("2026-08-14T13:50:00")
)
assert late["missed_slots"] == list(runner.TARGET_SLOTS)
assert late["successful_slots"] == []
assert late["completeness"] == "0/5"
assert late["snapshot_status"] == runner.SNAPSHOT_MISSED
assert runner.eligible_slot(late, at("2026-08-14T13:50:00")) is None
assert runner.workflow_should_fail(late, at("2026-08-14T13:50:00")) is True


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
assert runner.workflow_should_fail(expired, at("2026-08-14T11:30:00")) is True


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


workflow = (ROOT / ".github" / "workflows" / "update-market-quotes.yml").read_text(encoding="utf-8")
assert 'cron: "27,32,37,42,47 1,2,3,4,5 * * 1-5"' in workflow
assert "--scheduled-once" in workflow
assert "cancel-in-progress: false" in workflow
print("PASS P0.2 scheduler completeness tests 1-5")
