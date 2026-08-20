import importlib.util
import json
import os
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("market_quotes_decoupling_p0", ROOT / "scripts" / "update_market_quotes.py")
quotes = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(quotes)


def item(code, market, day, price):
    return {
        "code": code, "name": code, "price": price, "previous_close": price - 1,
        "date": day, "market": market, "quote_mode": "close", "quote_time": "收盤",
    }


old_items = [
    item("0050", "TWSE", "2026-08-13", 100),
    item("00662", "TWSE", "2026-08-13", 100),
    item("00757", "TWSE", "2026-08-13", 100),
    item("00830", "TWSE", "2026-08-13", 100),
    item("00935", "TWSE", "2026-08-13", 100),
    item("009815", "TPEx", "2026-08-13", 10),
]
new_by_market = {
    "TWSE": [item(code, "TWSE", "2026-08-19", 110 + index) for index, code in enumerate(("0050", "00662", "00757", "00830", "00935"))],
    "TPEx": [item("009815", "TPEx", "2026-08-20", 11.5)],
}


# TEST 1-2: Radar failure cannot roll back newer official close rows or updated_at.
with tempfile.TemporaryDirectory() as temporary:
    temp = Path(temporary)
    old_paths = quotes.OUTPUT, quotes.META_OUTPUT, quotes.OVERVIEW_OUTPUT, quotes.FUTURES_OUTPUT
    old_functions = quotes.fetch_json, quotes.normalize_close_rows, quotes.fetch_mis_snapshot
    old_slot = os.environ.get("HS_RADAR_SLOT")
    try:
        quotes.OUTPUT, quotes.META_OUTPUT = temp / "market-quotes.json", temp / "market-quotes-meta.json"
        quotes.OVERVIEW_OUTPUT, quotes.FUTURES_OUTPUT = temp / "market-overview.json", temp / "tx-futures-quote.json"
        quotes.OUTPUT.write_text(json.dumps({
            "version": 2, "updated_at": "2026-08-13T06:07:55Z",
            "source_dates": {"TWSE": "2026-08-13", "TPEx": "2026-08-13"},
            "source_status": {"TWSE": "official_closing_data", "TPEx": "official_closing_data"},
            "items": old_items,
        }), encoding="utf-8")
        quotes.OVERVIEW_OUTPUT.write_text('{"instruments":{}}', encoding="utf-8")
        quotes.FUTURES_OUTPUT.write_text('{"version":1}', encoding="utf-8")
        quotes.fetch_json = lambda *_args, **_kwargs: []
        quotes.normalize_close_rows = lambda _rows, market: new_by_market[market]
        quotes.fetch_mis_snapshot = lambda: []  # 0050 absent => Radar validation fails.
        os.environ["HS_RADAR_SLOT"] = "10:30"
        quotes.main()
        payload = json.loads(quotes.OUTPUT.read_text(encoding="utf-8"))
    finally:
        quotes.OUTPUT, quotes.META_OUTPUT, quotes.OVERVIEW_OUTPUT, quotes.FUTURES_OUTPUT = old_paths
        quotes.fetch_json, quotes.normalize_close_rows, quotes.fetch_mis_snapshot = old_functions
        if old_slot is None:
            os.environ.pop("HS_RADAR_SLOT", None)
        else:
            os.environ["HS_RADAR_SLOT"] = old_slot

    by_code = {row["code"]: row for row in payload["items"]}
    assert payload["updated_at"] != "2026-08-13T06:07:55Z"
    assert by_code["0050"]["date"] == "2026-08-19"
    assert by_code["00830"]["date"] == "2026-08-19"
    assert by_code["00935"]["date"] == "2026-08-19"
    assert by_code["009815"]["date"] == "2026-08-20"
    assert payload["items"] != old_items
    print("TEST 1 PASS: official close cache advances despite Radar MIS failure")
    print("TEST 2 PASS: no full-cache rollback occurs")

    # TEST 4: Radar failure metadata remains explicit and non-successful.
    attempt = payload["radar_refresh_attempt"]
    assert attempt["status"] == "failed" and attempt["verified"] is False
    assert "0050" in attempt["error"]
    assert not payload.get("radar_refresh")
    print("TEST 4 PASS: Radar failure metadata remains failed")


# TEST 3: An individually absent official symbol keeps only its own LKG.
partial = {market: list(rows) for market, rows in new_by_market.items()}
partial["TWSE"] = [row for row in partial["TWSE"] if row["code"] != "00757"]
merged = {row["code"]: row for row in quotes.merge_official_close_with_lkg(partial, old_items)}
assert merged["0050"]["date"] == "2026-08-19"
assert merged["00830"]["date"] == "2026-08-19"
assert merged["009815"]["date"] == "2026-08-20"
assert merged["00757"]["date"] == "2026-08-13"
print("TEST 3 PASS: per-symbol official LKG does not roll back successful symbols")
