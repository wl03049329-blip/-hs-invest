import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import update_futures_position as futures  # noqa: E402
import update_market_quotes as quotes  # noqa: E402


class MarketQuoteTests(unittest.TestCase):
    def test_near_month_rolls_past_expired_contract(self):
        rows = [
            {
                "Date": "20260720",
                "Contract": "TX",
                "ContractMonth(Week)": "202607",
                "Last": "41000",
                "Change": "100",
                "%": "0.25%",
                "OpenInterest": "90000",
                "TradingSession": "一般",
            },
            {
                "Date": "20260720",
                "Contract": "TX",
                "ContractMonth(Week)": "202608",
                "Last": "41200",
                "Change": "120",
                "%": "0.29%",
                "OpenInterest": "80000",
                "TradingSession": "一般",
            },
        ]
        result = quotes.select_near_month_tx(rows)
        self.assertEqual(result["contract_month"], "202608")
        self.assertEqual(result["value"], 41200)

    def test_overview_rejects_missing_required_instrument(self):
        with self.assertRaises(ValueError):
            quotes.build_overview([], {"value": 1}, quotes.datetime.now(quotes.TAIPEI))


class FuturesPositionTests(unittest.TestCase):
    @staticmethod
    def institutional_rows(product):
        values = {
            "自營商": (100, 120),
            "投信": (20, 10),
            "外資及陸資": (300, 250),
        }
        return [
            {
                "ContractCode": product,
                "Item": item,
                "OpenInterest(Long)": str(long_value),
                "OpenInterest(Short)": str(short_value),
                "OpenInterest(Net)": str(long_value - short_value),
            }
            for item, (long_value, short_value) in values.items()
        ]

    def test_non_institutional_formula(self):
        daily = [
            {
                "Contract": "MTX",
                "ContractMonth(Week)": "202608",
                "TradingSession": "一般",
                "OpenInterest": "1000",
            },
            {
                "Contract": "MTX",
                "ContractMonth(Week)": "202608W1",
                "TradingSession": "一般",
                "OpenInterest": "500",
            },
        ]
        result, scope = futures.estimate_non_institutional(
            daily, self.institutional_rows("小型臺指期貨"), "MTX"
        )
        self.assertEqual(result, {"long": 1080, "short": 1120, "net": -40})
        self.assertEqual(scope, ["202608", "202608W1"])

    def test_scope_mismatch_stops_calculation(self):
        daily = [
            {
                "Contract": "TMF",
                "ContractMonth(Week)": "202608",
                "TradingSession": "一般",
                "OpenInterest": "100",
            }
        ]
        with self.assertRaisesRegex(ValueError, "scope cannot align"):
            futures.estimate_non_institutional(
                daily, self.institutional_rows("微型臺指期貨"), "TMF"
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
