import datetime as dt
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("update_commodity_quotes", ROOT / "scripts" / "update_commodity_quotes.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


class CommodityQuoteTests(unittest.TestCase):
    def fixture(self, symbol: str, price: float, previous: float) -> dict:
        return {
            "meta": {"symbol": symbol, "exchange_timezone": "UTC"},
            "values": [
                {"datetime": "2026-08-02T00:00:00+00:00", "open": str(previous),
                 "high": str(max(price, previous)), "low": str(min(price, previous)),
                 "close": str(price), "volume": None},
                {"datetime": "2026-08-01T23:59:00+00:00", "open": str(previous),
                 "high": str(previous), "low": str(previous), "close": str(previous), "volume": None},
            ],
        }

    def test_gold_and_brent_parse_without_name_typo(self):
        now = dt.datetime(2026, 8, 2, tzinfo=dt.timezone.utc)
        gold = MODULE.parse_time_series(self.fixture("XAU/USD", 4107, 4160.6), "gold", now)
        brent = MODULE.parse_time_series(self.fixture("XBR/USD", 90.12, 89.03), "brent", now)
        self.assertEqual(gold["name"], "黃金現貨")
        self.assertEqual(brent["name"], "布蘭特原油")
        self.assertAlmostEqual(brent["change_pct"], 1.2243, places=4)
        self.assertNotIn("杜蘭特", brent["name"])

    def test_rejects_zero_missing_and_extreme_move(self):
        now = dt.datetime(2026, 8, 2, tzinfo=dt.timezone.utc)
        with self.assertRaises(ValueError):
            MODULE.parse_time_series(self.fixture("XAU/USD", 0, 100), "gold", now)
        with self.assertRaises(ValueError):
            MODULE.parse_time_series(self.fixture("XAU/USD", 200, 100), "gold", now)

    def test_uses_structured_licensed_endpoint_without_browser_secret(self):
        self.assertEqual(MODULE.API, "https://api.twelvedata.com/time_series")
        self.assertNotIn("apikey", MODULE.SOURCE_PAGE.lower())

    def test_checked_in_cache_is_valid(self):
        payload = json.loads((ROOT / "commodity-quotes.json").read_text(encoding="utf-8"))
        self.assertEqual(set(payload["items"]), {"gold", "brent"})
        for key, item in payload["items"].items():
            self.assertTrue(MODULE.valid_item(item, key))
            self.assertGreater(item["value"], 0)


if __name__ == "__main__":
    unittest.main()
