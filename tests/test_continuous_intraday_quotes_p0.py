import importlib.util
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


quotes = load("continuous_quotes", ROOT / "scripts" / "update_market_quotes.py")
runner = load("continuous_runner", ROOT / "scripts" / "run_intraday_radar_session.py")


def rows(quote_time):
    result = []
    for index, code in enumerate(quotes.RADAR_REQUIRED_LIVE_SYMBOLS):
        price = 100 + index
        result.append({
            "code": code, "name": code, "price": price, "price_field": "pz",
            "previous_close": price - 1, "date": "2026-09-07", "quote_time": quote_time,
            "market": "TWSE", "open": price - .5, "high": price + 1,
            "low": price - 1, "volume": 1000, "source": quotes.TWSE_MIS_URL,
        })
    return result


def success(date, slot):
    as_of = f"{date}T{slot}:00+08:00"
    return True, {
        "verified": True, "status": "success", "trading_date": date, "slot": slot,
        "market_as_of": {code: as_of for code in quotes.RADAR_REQUIRED_LIVE_SYMBOLS},
        "slot_diagnostic": {"market_fetch": "PASS", "core_input": "PASS", "score": "PASS", "snapshot_append": "PASS"},
    }


for slot in ("10:17", "11:43"):
    now = datetime.fromisoformat(f"2026-09-07T{slot}:30+08:00")
    result = quotes.validate_radar_refresh(rows(f"{slot}:00"), "2026-09-07", slot, now)
    assert result["verified"] is True and result["slot"] == slot
print("A/B PASS: arbitrary legal 10:17 and 11:43 observations validate")

try:
    quotes.validate_radar_refresh(
        rows("11:27:00"), "2026-09-07", "11:43",
        datetime.fromisoformat("2026-09-07T11:43:30+08:00"),
    )
    raise AssertionError("16-minute-old quote must fail closed")
except ValueError as exc:
    assert "stale quote" in str(exc)
print("C PASS: rolling freshness rejects observations older than 15 minutes")

assert runner.rolling_slot_for_time(datetime.fromisoformat("2026-09-07T10:17:59+08:00")) == "10:17"
assert runner.rolling_slot_for_time(datetime.fromisoformat("2026-09-07T11:43:02+08:00")) == "11:43"
assert runner.rolling_slot_for_time(datetime.fromisoformat("2026-09-07T08:59:59+08:00")) is None
assert runner.rolling_slot_for_time(datetime.fromisoformat("2026-09-07T13:31:00+08:00")) is None
print("D PASS: runner gates only the cash session, not fixed publication slots")

calls = []
for slot in ("10:17", "10:22"):
    code = runner.run_scheduled_once(
        now_fn=lambda slot=slot: datetime.fromisoformat(f"2026-09-07T{slot}:20+08:00"),
        execute_fn=lambda date, actual_slot: (calls.append((date, actual_slot)) or success(date, actual_slot)),
        git_sync=False,
    )
    assert code == 0
assert calls == [("2026-09-07", "10:17"), ("2026-09-07", "10:22")]
print("E PASS: every scheduler tick recomputes instead of locking the first hourly success")

closed_calls = []
assert runner.run_scheduled_once(
    now_fn=lambda: datetime.fromisoformat("2026-09-07T14:00:00+08:00"),
    execute_fn=lambda *_: closed_calls.append(True), git_sync=False,
) == 0
assert closed_calls == []
assert runner.run_scheduled_once(
    now_fn=lambda: datetime.fromisoformat("2026-09-07T10:17:00+08:00"),
    execute_fn=lambda *_: (False, {"error": "fixture failure"}), git_sync=False,
) == 1
print("F PASS: legal closed skip exits zero; production tick failure exits non-zero")

print("PASS continuous intraday quote/runner contract 6/6")
