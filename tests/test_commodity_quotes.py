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
        return {"chart": {"result": [{"meta": {
            "symbol": symbol,
            "regularMarketPrice": price,
            "previousClose": previous,
            "regularMarketTime": 1785531594,
        }}], "error": None}}

    def test_gold_and_brent_parse_without_name_typo(self):
        now = dt.datetime(2026, 8, 2, tzinfo=dt.timezone.utc)
        gold = MODULE.parse_chart(self.fixture("GC=F", 4107, 4160.6), "gold", now)
        brent = MODULE.parse_chart(self.fixture("BZ=F", 90.12, 89.03), "brent", now)
        self.assertEqual(gold["name"], "黃金期貨")
        self.assertEqual(brent["name"], "布蘭特原油")
        self.assertAlmostEqual(brent["change_pct"], 1.2243, places=4)
        self.assertNotIn("杜蘭特", brent["name"])

    def test_rejects_zero_missing_and_extreme_move(self):
        now = dt.datetime(2026, 8, 2, tzinfo=dt.timezone.utc)
        with self.assertRaises(ValueError):
            MODULE.parse_chart(self.fixture("GC=F", 0, 100), "gold", now)
        with self.assertRaises(ValueError):
            MODULE.parse_chart(self.fixture("GC=F", 200, 100), "gold", now)

    def test_checked_in_cache_is_valid(self):
        payload = json.loads((ROOT / "commodity-quotes.json").read_text(encoding="utf-8"))
        self.assertEqual(set(payload["items"]), {"gold", "brent"})
        for key, item in payload["items"].items():
            self.assertTrue(MODULE.valid_item(item, key))
            self.assertGreater(item["value"], 0)


if __name__ == "__main__":
    unittest.main()
