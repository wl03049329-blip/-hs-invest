import importlib.util
import json
import tempfile
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRIMARY = (ROOT / ".github" / "workflows" / "update-market-quotes.yml").read_text(encoding="utf-8")
WATCHDOG = (ROOT / ".github" / "workflows" / "intraday-scheduler-watchdog.yml").read_text(encoding="utf-8")

assert "name: Update delayed market quotes" in PRIMARY
for workflow in (PRIMARY, WATCHDOG):
    assert "group: hs-live-intraday-slot-v4" in workflow
    assert "cancel-in-progress: false" in workflow
    assert "python scripts/run_intraday_radar_session.py --scheduled-once" in workflow
assert 'cron: "33,48 1 * * 1-5"' in WATCHDOG
assert 'cron: "3,18,33,48 2,3,4,5 * * 1-5"' in WATCHDOG
assert 'cron: "3,18 6 * * 1-5"' in WATCHDOG
assert "fetch-depth: 0" in WATCHDOG and "ref: main" in WATCHDOG
assert 'python-version: "3.12"' in WATCHDOG and 'node-version: "20"' in WATCHDOG
assert "git pull --rebase origin main" in WATCHDOG
assert "--slot" not in WATCHDOG and "backfill" not in WATCHDOG.lower()

spec = importlib.util.spec_from_file_location("intraday_runner_watchdog_test", ROOT / "scripts" / "run_intraday_radar_session.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

with tempfile.TemporaryDirectory() as folder:
    old_root = runner.ROOT
    runner.ROOT = Path(folder)
    for filename in ("market-quotes.json", "market-quotes-meta.json"):
        (runner.ROOT / filename).write_text('{"schema_version":1}\n', encoding="utf-8")
    executions = []

    def first_tick(trading_date, slot):
        executions.append((trading_date, slot))
        return True, {
            "verified": True,
            "status": "success",
            "trading_date": trading_date,
            "slot": slot,
            "market_as_of": f"{trading_date}T{slot}:00+08:00",
            "attempted_at": f"{trading_date}T01:33:00Z",
            "slot_diagnostic": {"market_fetch": "PASS", "core_input": "PASS", "score": "PASS", "snapshot_append": "PASS"},
        }

    assert runner.run_scheduled_once(now_fn=lambda: datetime.fromisoformat("2026-08-28T09:33:00+08:00"), execute_fn=first_tick, git_sync=False) == 0
    assert runner.run_scheduled_once(now_fn=lambda: datetime.fromisoformat("2026-08-28T09:48:00+08:00"), execute_fn=lambda *_: (_ for _ in ()).throw(AssertionError("duplicate execution")), git_sync=False) == 0
    state = json.loads((runner.ROOT / "market-quotes-meta.json").read_text(encoding="utf-8"))["intraday_completeness"]
    assert executions == [("2026-08-28", "09:30")]
    assert state["slots"]["09:30"]["status"] == runner.SLOT_SUCCESS
    assert state["slots"]["09:30"]["attempts"] == 1
    diagnostic = state["slots"]["09:30"]["diagnostic"]
    assert diagnostic["trigger_status"] == "TRIGGERED"
    assert diagnostic["fetch_status"] == "FETCH_OK"
    assert diagnostic["core_status"] == "CORE_OK"
    assert diagnostic["snapshot_write_status"] == "SNAPSHOT_WRITTEN"
    runner.ROOT = old_root

print("PASS independent watchdog schedule and cross-workflow first-success idempotency")
