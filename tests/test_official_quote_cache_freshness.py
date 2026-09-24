"""Official close cache refresh must advance individual symbols without touching Radar."""

import importlib.util
import json
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("official_quote_refresh", ROOT / "scripts/update_market_quotes.py")
quotes = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(quotes)


def item(code, market, day, price, mode="close"):
    return {"code": code, "name": code, "price": price, "previous_close": price - 1,
            "date": day, "market": market, "quote_mode": mode, "quote_time": "13:30:00" if mode == "delayed" else "收盤"}


with tempfile.TemporaryDirectory() as directory:
    old_output, old_meta, old_fetch, old_mis = quotes.OUTPUT, quotes.META_OUTPUT, quotes.fetch_json, quotes.fetch_mis_snapshot
    try:
        quotes.OUTPUT = Path(directory) / "market-quotes.json"
        quotes.META_OUTPUT = Path(directory) / "market-quotes-meta.json"
        initial = {"version": 2, "updated_at": "2026-09-24T05:30:00Z",
                   "source_dates": {"TWSE": "2026-09-24", "TPEx": "2026-09-22"},
                   "source_status": {"TWSE": "official_closing_data", "TPEx": "official_closing_data"},
                   "items": [item("0050", "TWSE", "2026-09-24", 112, "delayed"),
                             item("006208", "TWSE", "2026-09-22", 255.7),
                             item("009815", "TPEx", "2026-09-22", 11.99)]}
        quotes.OUTPUT.write_text(json.dumps(initial), encoding="utf-8")
        quotes.META_OUTPUT.write_text(json.dumps({
            "version": 2, "updated_at": initial["updated_at"],
            "primary_trigger_source": "RAILWAY_PRIMARY",
            "last_primary_tick_at": "2026-09-24T05:30:00Z",
            "publication_status": "ARTIFACTS_WRITTEN",
            "artifact_commit_sha": None,
            "github_fallback_gap_detected": False,
        }), encoding="utf-8")
        twse = [{"Code": "0050", "Name": "元大台灣50", "Date": "1150923", "ClosingPrice": "111", "Change": "1"},
                {"Code": "006208", "Name": "富邦台50", "Date": "1150923", "ClosingPrice": "257", "Change": "1.3"}]
        tpex = [{"SecuritiesCompanyCode": "009815", "CompanyName": "大華美國MAG7+",
                 "Date": "1150924", "Close": "11.93", "Change": "-0.10"}]
        quotes.fetch_json = lambda url, **_kw: twse if url == quotes.TWSE_CLOSE_URL else tpex
        quotes.fetch_mis_snapshot = lambda **_kw: (_ for _ in ()).throw(AssertionError("MIS must not run"))
        quotes.refresh_official_close_cache()
        cache = json.loads(quotes.OUTPUT.read_text(encoding="utf-8"))
        meta = json.loads(quotes.META_OUTPUT.read_text(encoding="utf-8"))
        rows = {row["code"]: row for row in cache["items"]}
        assert (rows["006208"]["date"], rows["006208"]["price"]) == ("2026-09-23", 257)
        assert rows["0050"]["date"] == "2026-09-24"  # Do not regress a newer genuine MIS trade.
        assert rows["009815"]["date"] == "2026-09-24"
        assert cache["official_source_dates"] == meta["official_source_dates"] == {"TWSE": "2026-09-23", "TPEx": "2026-09-24"}
        assert cache["official_last_checked_at"] == meta["official_last_checked_at"]
        assert cache["official_last_success_at"] == meta["official_last_success_at"]
        assert meta["primary_trigger_source"] == "RAILWAY_PRIMARY"
        assert meta["last_primary_tick_at"] == "2026-09-24T05:30:00Z"
        assert meta["publication_status"] == "ARTIFACTS_WRITTEN"
        assert meta["github_fallback_gap_detected"] is False
        assert cache["source_dates"]["TWSE"] == "2026-09-24"  # Legacy mixed-date field is not an official-date claim.
        first_update = cache["updated_at"]
        quotes.refresh_official_close_cache()
        assert json.loads(quotes.OUTPUT.read_text(encoding="utf-8"))["updated_at"] == first_update
        def one_source_fails(url, **_kw):
            if url == quotes.TWSE_CLOSE_URL:
                raise OSError("test source unavailable")
            return tpex
        quotes.fetch_json = one_source_fails
        quotes.refresh_official_close_cache()
        cache = json.loads(quotes.OUTPUT.read_text(encoding="utf-8"))
        assert cache["source_status"]["TWSE"] == "cached_after_error"
        assert cache["official_source_dates"]["TWSE"] == "2026-09-23"
        assert next(row for row in cache["items"] if row["code"] == "006208")["price"] == 257
        assert cache["updated_at"] == first_update
        print("PASS official close refresh, per-symbol advance, independent MIS, source-error LKG, metadata parity, no fake updated_at")
    finally:
        quotes.OUTPUT, quotes.META_OUTPUT, quotes.fetch_json, quotes.fetch_mis_snapshot = old_output, old_meta, old_fetch, old_mis
