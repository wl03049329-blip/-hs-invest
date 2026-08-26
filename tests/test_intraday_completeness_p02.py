import importlib.util
import json
import tempfile
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
TAIPEI = ZoneInfo("Asia/Taipei")
spec = importlib.util.spec_from_file_location(
    "intraday_slot_v4", ROOT / "scripts" / "run_intraday_radar_session.py"
)
runner = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(runner)


def at(value):
    parsed = datetime.fromisoformat(value)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=TAIPEI)


def successful_attempt(slot, as_of=None):
    market_as_of = as_of or f"2026-08-26T{slot}:31+08:00"
    return {
        "verified": True,
        "status": "success",
        "slot": slot,
        "trading_date": "2026-08-26",
        "verified_at": market_as_of,
        "captured_at": market_as_of,
        "market_as_of": {code: market_as_of for code in ("0050", "00662", "00757", "00830", "00935")},
        "source": "TWSE_MIS",
        "slot_diagnostic": {"market_fetch": "PASS", "core_input": "PASS", "score": "PASS", "snapshot_append": "PASS"},
    }


# TEST 1: exact V4 boundary classification uses full slot windows.
boundaries = {
    "2026-08-26T09:29:59+08:00": None,
    "2026-08-26T09:30:00+08:00": "09:30",
    "2026-08-26T10:29:59+08:00": "09:30",
    "2026-08-26T10:30:00+08:00": "10:30",
    "2026-08-26T11:29:59+08:00": "10:30",
    "2026-08-26T11:30:00+08:00": "11:30",
    "2026-08-26T12:29:59+08:00": "11:30",
    "2026-08-26T12:30:00+08:00": "12:30",
    "2026-08-26T13:29:59+08:00": "12:30",
    "2026-08-26T13:30:00+08:00": "13:30",
    "2026-08-26T14:19:59+08:00": "13:30",
    "2026-08-26T14:20:00+08:00": None,
    "2026-08-26T14:29:59+08:00": None,
    "2026-08-26T14:30:00+08:00": None,
}
for timestamp, expected in boundaries.items():
    assert runner.current_slot_for_time(at(timestamp)) == expected
print("TEST 1 PASS: V4 slot boundary classification")


# TEST 2: every slot can reach 5/5 and publishes the V4 contract.
state = runner.new_completeness("2026-08-26")
for slot in runner.TARGET_SLOTS:
    state = runner.record_slot_outcome(state, slot, runner.SLOT_SUCCESS, successful_attempt(slot), at(f"2026-08-26T{slot}:31"))
assert state["contract"] == runner.SLOT_CONTRACT == "HS_LIVE_INTRADAY_SLOT_V4"
assert state["completeness"] == "5/5" and state["snapshot_status"] == runner.SNAPSHOT_SUCCESS
print("TEST 2 PASS: five immutable successes produce 5/5")


# TEST 3: FIRST SUCCESS WINS, including its actual market timestamp.
first_wins = runner.new_completeness("2026-08-26")
first = successful_attempt("09:30", "2026-08-26T09:47:12+08:00")
first_wins = runner.record_slot_outcome(first_wins, "09:30", runner.SLOT_SUCCESS, first, at("2026-08-26T09:47:20"))
saved = dict(first_wins["slots"]["09:30"])
first_wins = runner.record_slot_outcome(
    first_wins, "09:30", runner.SLOT_SUCCESS,
    successful_attempt("09:30", "2026-08-26T10:18:02+08:00"), at("2026-08-26T10:18:10")
)
assert first_wins["slots"]["09:30"] == saved
assert first_wins["slots"]["09:30"]["market_as_of"]["0050"] == "2026-08-26T09:47:12+08:00"
print("TEST 3 PASS: first success and actual market timestamp are immutable")


# TEST 4: a retry failure is non-terminal and a later success clears terminal failure state.
retry = runner.new_completeness("2026-08-26")
failure = {"error": "temporary source error", "failure_class": runner.FAILURE_OPERATIONAL_SOURCE}
retry = runner.record_slot_outcome(retry, "10:30", runner.SLOT_FAILED, failure, at("2026-08-26T10:31:00"))
assert runner.eligible_slot(retry, at("2026-08-26T11:20:00")) == "10:30"
retry = runner.record_slot_outcome(retry, "10:30", runner.SLOT_SUCCESS, successful_attempt("10:30"), at("2026-08-26T11:20:00"))
row = retry["slots"]["10:30"]
assert row["status"] == runner.SLOT_SUCCESS and row["attempts"] == 2
assert "error" not in row and "failure_class" not in row and "10:30" not in retry["failed_slots"]
print("TEST 4 PASS: retry-after-failure can succeed")


# TEST 5: MISSED is assigned only when the complete window closes, preserving failure evidence.
missed = runner.new_completeness("2026-08-26")
missed = runner.record_slot_outcome(missed, "09:30", runner.SLOT_FAILED, failure, at("2026-08-26T09:40:00"))
missed = runner.reconcile_closed_slots(missed, at("2026-08-26T10:29:59"))
assert missed["slots"]["09:30"]["status"] == runner.SLOT_FAILED
missed = runner.reconcile_closed_slots(missed, at("2026-08-26T10:30:00"))
assert missed["slots"]["09:30"]["status"] == runner.SLOT_MISSED
assert missed["slots"]["09:30"]["last_failure"]["reason"] == "temporary source error"
print("TEST 5 PASS: MISSED waits for window close and retains source evidence")


# TEST 6: final 13:30 slot retries through 14:19:59 and closes at 14:20.
final_slot = runner.new_completeness("2026-08-26")
final_slot = runner.reconcile_closed_slots(final_slot, at("2026-08-26T14:19:59"))
assert runner.eligible_slot(final_slot, at("2026-08-26T14:19:59")) == "13:30"
final_slot = runner.reconcile_closed_slots(final_slot, at("2026-08-26T14:20:00"))
assert final_slot["slots"]["13:30"]["status"] == runner.SLOT_MISSED
assert runner.eligible_slot(final_slot, at("2026-08-26T14:20:00")) is None
print("TEST 6 PASS: 13:30 extended retry window")


# TEST 7: delayed triggers classify from actual time and never backfill a closed slot.
delayed = runner.reconcile_closed_slots(runner.new_completeness("2026-08-26"), at("2026-08-26T11:10:00"))
assert delayed["slots"]["09:30"]["status"] == runner.SLOT_MISSED
assert runner.eligible_slot(delayed, at("2026-08-26T11:10:00")) == "10:30"
assert runner.slot_action(at("2026-08-26T10:18:00"), runner.slot_datetime("2026-08-26", "09:30")) == "run"
assert runner.slot_action(at("2026-08-26T10:30:00"), runner.slot_datetime("2026-08-26", "09:30")) == "skip"
print("TEST 7 PASS: delayed Actions map correctly without historical backfill")


# TEST 8: diagnostics expose every required pipeline stage.
diagnostic = runner.complete_slot_diagnostic(
    "2026-08-26", "10:30", {**failure, "attempted_at": "2026-08-26T03:01:00Z"},
    at("2026-08-26T11:01:00"), existing_slot_success=False, retry_number=2
)
for key in ("trading_date", "classified_slot", "actual_run_time", "market_fetch", "required_symbols", "market_as_of", "core_input", "score", "snapshot_append", "existing_slot_success", "retry_number", "failure_class", "reason"):
    assert key in diagnostic
print("TEST 8 PASS: SLOT_DIAGNOSTIC contract")


# TEST 9: optional missing artifacts never turn staging into a pathspec failure.
with tempfile.TemporaryDirectory() as temp_dir:
    previous_root = runner.ROOT
    runner.ROOT = Path(temp_dir)
    (runner.ROOT / "market-quotes-meta.json").write_text("{}", encoding="utf-8")
    assert runner.stageable_cache_files() == ("market-quotes-meta.json",)
    runner.ROOT = previous_root
print("TEST 9 PASS: missing-artifact staging regression")


# TEST 10: scheduled retries persist FAILED -> SUCCESS and then lock the slot.
with tempfile.TemporaryDirectory() as temp_dir:
    previous_root = runner.ROOT
    runner.ROOT = Path(temp_dir)
    for filename in ("market-quotes.json", "market-quotes-meta.json"):
        (runner.ROOT / filename).write_text('{"version":2}\n', encoding="utf-8")
    failed_code = runner.run_scheduled_once(
        now_fn=lambda: at("2026-08-26T10:40:00"),
        execute_fn=lambda _date, _slot: (False, failure),
        git_sync=False,
    )
    assert failed_code == 0
    success_code = runner.run_scheduled_once(
        now_fn=lambda: at("2026-08-26T10:50:00"),
        execute_fn=lambda _date, slot: (True, successful_attempt(slot)),
        git_sync=False,
    )
    assert success_code == 0
    calls = []
    runner.run_scheduled_once(
        now_fn=lambda: at("2026-08-26T11:00:00"),
        execute_fn=lambda *_args: calls.append(True),
        git_sync=False,
    )
    persisted = json.loads((runner.ROOT / "market-quotes-meta.json").read_text(encoding="utf-8"))["intraday_completeness"]
    assert persisted["slots"]["10:30"]["status"] == runner.SLOT_SUCCESS
    assert persisted["slots"]["10:30"]["attempts"] == 2
    assert calls == []
    runner.ROOT = previous_root
print("TEST 10 PASS: scheduler retries, succeeds, and locks first success")


workflow = (ROOT / ".github" / "workflows" / "update-market-quotes.yml").read_text(encoding="utf-8")
for cron in ('cron: "*/5 1 * * 1-5"', 'cron: "*/5 2,3,4,5 * * 1-5"', 'cron: "0,5,10,15,20,30 6 * * 1-5"'):
    assert cron in workflow
assert "hs-live-intraday-slot-v4" in workflow and "cancel-in-progress: false" in workflow
assert "--scheduled-once" in workflow and "needs: intraday" in workflow and "if: ${{ always() }}" in workflow
print("PASS HS_LIVE_INTRADAY_SLOT_V4 completeness tests 1-10")
