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
assert refresh0930["codes"] == list(quotes.RADAR_CODES)
assert refresh0930["slot"] == "09:30"

bad = radar_rows("09:30")[:-1]
try:
    quotes.validate_radar_refresh(bad, "2026-08-13", "09:30", at0930)
    raise AssertionError("missing one radar ETF must fail the whole slot")
except ValueError:
    pass

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
    at1030 = datetime.fromisoformat("2026-08-13T10:32:00+08:00")
    refresh1030 = quotes.validate_radar_refresh(radar_rows("10:30"), "2026-08-13", "10:30", at1030)
    quotes.write_market_cache(items, statuses, at1030, first, refresh1030, {**refresh1030, "status": "success"})
    second = json.loads(quotes.OUTPUT.read_text(encoding="utf-8"))
    assert second["updated_at"] != first["updated_at"], "same prices must still produce a new successful cache version"
    assert second["radar_refresh"]["slot"] == "10:30"
    failed = {"verified": False, "status": "failed", "trading_date": "2026-08-13", "slot": "11:30", "error": "fixture"}
    quotes.write_market_cache(items, statuses, datetime.fromisoformat("2026-08-13T11:32:00+08:00"), second, None, failed)
    third = json.loads(quotes.OUTPUT.read_text(encoding="utf-8"))
    assert third["updated_at"] == second["updated_at"]
    assert third["radar_refresh"]["slot"] == "10:30"
    assert third["radar_refresh_attempt"]["slot"] == "11:30"
    assert third["radar_refresh_attempt"]["status"] == "failed"
    quotes.ROOT, quotes.OUTPUT, quotes.META_OUTPUT = old_root, old_output, old_meta

assert session.TARGET_SLOTS == ("09:30", "10:30", "11:30", "12:30", "13:30")
target = session.slot_datetime("2026-08-13", "09:30")
assert session.slot_action(datetime.fromisoformat("2026-08-13T08:25:00+08:00"), target) == "wait"
assert session.slot_action(datetime.fromisoformat("2026-08-13T09:35:00+08:00"), target) == "run"
assert session.slot_action(datetime.fromisoformat("2026-08-13T09:46:00+08:00"), target) == "skip"

workflow = (ROOT / ".github" / "workflows" / "update-market-quotes.yml").read_text(encoding="utf-8")
assert 'cron: "25 0 * * 1-5"' in workflow
assert "run_intraday_radar_session.py" in workflow
assert "timeout-minutes: 345" in workflow
assert 'cron: "32 1,2,3,4,5 * * 1-5"' not in workflow

print("PASS production intraday scheduler, five-ETF validation, 13:30 timestamp mode and cache version regression")
