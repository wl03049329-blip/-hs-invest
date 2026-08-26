import importlib.util
import json
import tempfile
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


quotes = load("market_quotes_p0", ROOT / "scripts" / "update_market_quotes.py")
session = load("radar_session_p0", ROOT / "scripts" / "run_intraday_radar_session.py")


def radar_rows(slot, prices=None):
    prices = prices or {}
    rows = []
    for index, code in enumerate(quotes.RADAR_CODES):
        price = prices.get(code, 50 + index * 10)
        rows.append({
            "code": code,
            "name": code,
            "price": price,
            "previous_close": price - 1,
            "date": "2026-08-13",
            "quote_time": f"{slot}:00",
            "market": "TPEx" if code == "009815" else "TWSE",
            "open": price - 0.5,
            "high": price + 1,
            "low": price - 1,
            "volume": 100000,
            "source": quotes.TWSE_MIS_URL,
        })
    return rows


at0930 = datetime.fromisoformat("2026-08-13T09:32:00+08:00")
refresh0930 = quotes.validate_radar_refresh(radar_rows("09:30"), "2026-08-13", "09:30", at0930)
assert refresh0930["verified"] is True
assert refresh0930["codes"] == list(quotes.RADAR_REQUIRED_LIVE_SYMBOLS)
assert refresh0930["non_blocking_status"] == {"009815": "WAIT_NATIVE"}
assert refresh0930["slot"] == "09:30"
assert refresh0930["captured_at"] == "2026-08-13T09:32:00+08:00"
late0930 = quotes.validate_radar_refresh(
    radar_rows("10:18"), "2026-08-13", "09:30", datetime.fromisoformat("2026-08-13T10:18:30+08:00")
)
assert late0930["verified"] is True
assert late0930["market_as_of"]["0050"] == "2026-08-13T10:18:00+08:00"
try:
    quotes.validate_radar_refresh(
        radar_rows("10:19"), "2026-08-13", "09:30", datetime.fromisoformat("2026-08-13T10:18:30+08:00")
    )
    raise AssertionError("future source timestamps must fail closed")
except ValueError as exc:
    assert "future quote rejected" in str(exc)
try:
    quotes.validate_radar_refresh(radar_rows("09:30"), "2026-08-13", "09:30", datetime.fromisoformat("2026-08-13T10:30:00+08:00"))
    raise AssertionError("a closed 09:30 slot must never be backfilled")
except ValueError as exc:
    assert "slot window is not open" in str(exc)

old_fetch_json, old_tracked_channels = quotes.fetch_json, quotes.tracked_channels
mis_rows = [{
    "c": row["code"], "n": row["name"], "z": str(row["price"]), "y": str(row["previous_close"]),
    "d": row["date"].replace("-", ""), "t": row["quote_time"], "h": str(row["high"]),
    "l": str(row["low"]), "o": str(row["open"]), "v": "100", "ex": "otc" if row["code"] == "009815" else "tse",
} for row in radar_rows("09:30")]
quotes.tracked_channels = lambda: [f"tse_{code}.tw" for code in quotes.RADAR_CODES]
quotes.fetch_json = lambda *_args, **_kwargs: {"msgArray": mis_rows}
assert {row["code"] for row in quotes.fetch_mis_snapshot()} == set(quotes.RADAR_CODES)
quotes.fetch_json, quotes.tracked_channels = old_fetch_json, old_tracked_channels

without_native = [row for row in radar_rows("09:30") if row["code"] != "009815"]
assert quotes.validate_radar_refresh(without_native, "2026-08-13", "09:30", at0930)["verified"] is True
for required_code in quotes.RADAR_REQUIRED_LIVE_SYMBOLS:
    bad = [row for row in radar_rows("09:30") if row["code"] != required_code]
    try:
        quotes.validate_radar_refresh(bad, "2026-08-13", "09:30", at0930)
        raise AssertionError(f"missing required {required_code} must fail the whole slot")
    except ValueError as exc:
        assert required_code in str(exc)

assert quotes.spot_quote_mode(datetime.fromisoformat("2026-08-13T13:42:00+08:00"), "2026-08-13", "13:30:00") == "delayed"
assert quotes.spot_quote_mode(datetime.fromisoformat("2026-08-13T14:00:00+08:00"), "2026-08-13", "14:00:00") == "close"

with tempfile.TemporaryDirectory() as temp:
    temp = Path(temp)
    old_output, old_meta, old_root = quotes.OUTPUT, quotes.META_OUTPUT, quotes.ROOT
    quotes.ROOT, quotes.OUTPUT, quotes.META_OUTPUT = temp, temp / "market-quotes.json", temp / "market-quotes-meta.json"
    items = []
    for row in radar_rows("09:30"):
        item = {key: row[key] for key in ("code", "name", "price", "previous_close", "date", "market", "quote_time", "open", "high", "low", "volume")}
        item["quote_mode"] = "delayed"
        items.append(item)
    statuses = {"TWSE": "official_closing_data", "TPEx": "official_closing_data", "TWSE_MIS": "ok"}
    quotes.write_market_cache(items, statuses, at0930, {}, refresh0930, {**refresh0930, "status": "success"})
    first = json.loads(quotes.OUTPUT.read_text(encoding="utf-8"))
    assert list(first["intraday_quote_snapshots"]) == ["2026-08-13_0930"]
    assert set(first["intraday_quote_snapshots"]["2026-08-13_0930"]["items"]) == set(quotes.RADAR_REQUIRED_LIVE_SYMBOLS)
    assert first["intraday_quote_snapshots"]["2026-08-13_0930"]["non_blocking_status"] == {"009815": "WAIT_NATIVE"}
    assert first["intraday_quote_snapshots"]["2026-08-13_0930"]["captured_at"] == refresh0930["captured_at"]
    assert first["intraday_snapshot_meta"]["current_slot"] == "09:30"
    assert first["intraday_snapshot_meta"]["previous_successful_slot"] is None
    at1030 = datetime.fromisoformat("2026-08-13T10:32:00+08:00")
    refresh1030 = quotes.validate_radar_refresh(radar_rows("10:30"), "2026-08-13", "10:30", at1030)
    quotes.write_market_cache(items, statuses, at1030, first, refresh1030, {**refresh1030, "status": "success"})
    second = json.loads(quotes.OUTPUT.read_text(encoding="utf-8"))
    assert second["updated_at"] != first["updated_at"], "same prices must still produce a new successful cache version"
    assert second["radar_refresh"]["slot"] == "10:30"
    assert list(second["intraday_quote_snapshots"]) == ["2026-08-13_0930", "2026-08-13_1030"]
    assert second["intraday_snapshot_meta"]["previous_successful_slot"] == "09:30"
    assert second["intraday_snapshot_meta"]["last_successful_snapshot"] == "2026-08-13_1030"
    conflicting_items = json.loads(json.dumps(items))
    conflicting_items[0]["price"] += 1
    conflicting_items[0]["high"] += 1
    try:
        quotes.write_market_cache(conflicting_items, statuses, at1030, second, refresh1030, {**refresh1030, "status": "success"})
        raise AssertionError("same-slot raw conflict must fail")
    except ValueError as exc:
        assert "INTEGRITY_FAILURE conflicting immutable raw radar snapshot" in str(exc)
    failed = {"verified": False, "status": "failed", "trading_date": "2026-08-13", "slot": "11:30", "error": "fixture"}
    quotes.write_market_cache(items, statuses, datetime.fromisoformat("2026-08-13T11:32:00+08:00"), second, None, failed)
    third = json.loads(quotes.OUTPUT.read_text(encoding="utf-8"))
    assert third["updated_at"] == second["updated_at"]
    assert third["radar_refresh"]["slot"] == "10:30"
    assert third["radar_refresh_attempt"]["slot"] == "11:30"
    assert third["radar_refresh_attempt"]["status"] == "failed"
    assert list(third["intraday_quote_snapshots"]) == ["2026-08-13_0930", "2026-08-13_1030"]
    assert third["intraday_snapshot_meta"]["last_successful_snapshot"] == "2026-08-13_1030"
    quotes.ROOT, quotes.OUTPUT, quotes.META_OUTPUT = old_root, old_output, old_meta

assert session.TARGET_SLOTS == ("09:30", "10:30", "11:30", "12:30", "13:30")
target = session.slot_datetime("2026-08-13", "09:30")
assert session.slot_action(datetime.fromisoformat("2026-08-13T08:25:00+08:00"), target) == "wait"
assert session.slot_action(datetime.fromisoformat("2026-08-13T09:35:00+08:00"), target) == "run"
assert session.slot_action(datetime.fromisoformat("2026-08-13T10:29:59+08:00"), target) == "run"
assert session.slot_action(datetime.fromisoformat("2026-08-13T10:30:00+08:00"), target) == "skip"
assert session.current_slot_for_time(datetime.fromisoformat("2026-08-13T14:19:59+08:00")) == "13:30"
assert session.current_slot_for_time(datetime.fromisoformat("2026-08-13T14:20:00+08:00")) is None

workflow = (ROOT / ".github" / "workflows" / "update-market-quotes.yml").read_text(encoding="utf-8")
assert 'cron: "*/5 1 * * 1-5"' in workflow
assert 'cron: "*/5 2,3,4,5 * * 1-5"' in workflow
assert 'cron: "0,5,10,15,20,30 6 * * 1-5"' in workflow
assert "run_intraday_radar_session.py" in workflow
assert "--scheduled-once" in workflow
assert "timeout-minutes: 20" in workflow
assert "group: hs-live-intraday-slot-v4" in workflow
assert "cancel-in-progress: false" in workflow
assert "needs: intraday" in workflow and "if: ${{ always() }}" in workflow
assert 'cron: "32 1,2,3,4,5 * * 1-5"' not in workflow

print("PASS Slot V4 scheduler, five-ETF validation, WAIT_NATIVE isolation, timestamp preservation and cache version regression")
