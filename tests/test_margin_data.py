import datetime as dt
import importlib.util
import json
import math
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("update_margin_data", ROOT / "scripts" / "update_margin_data.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


def official_fixture(missing_tpex_price=False):
    return {
        "twse_margin": [{"股票代號": "2330", "融資今日餘額": "10"}],
        "twse_prices": [{"Date": "1150731", "Code": "2330", "ClosingPrice": "100"}],
        "tpex_margin": [{"Date": "1150731", "SecuritiesCompanyCode": "6488", "MarginPurchaseBalance": "10"}],
        "tpex_prices": ([{"Date": "1150731", "SecuritiesCompanyCode": "9999", "Close": "100"}]
                        if missing_tpex_price else [{"Date": "1150731", "SecuritiesCompanyCode": "6488", "Close": "100"}]),
    }


def balance_history(count=130):
    start = dt.date(2026, 1, 30)
    rows = []
    date = start
    while len(rows) < count:
        if date.weekday() < 5:
            rows.append({"date": date.isoformat(), "value": 10_000_000 + len(rows) * 1000, "previous": 10_000_000})
        date += dt.timedelta(days=1)
    rows[-1]["date"] = "2026-07-31"
    return rows


class MarginDataTests(unittest.TestCase):
    def test_estimate_formula_and_unit_conversion(self):
        result = MODULE.estimate_market_ratio(official_fixture(), 1_000_000, "2026-07-31")
        self.assertEqual(result["collateral_market_value"], 2_000_000)
        self.assertEqual(result["financing_amount"], 1_000_000)
        self.assertEqual(result["value"], 200.0)

    def test_estimate_rejects_unreasonable_ratio(self):
        with self.assertRaisesRegex(ValueError, "unreasonable"):
            MODULE.estimate_market_ratio(official_fixture(), 10_000_000, "2026-07-31")

    def test_publishable_estimate_uses_realistic_fixture(self):
        data = official_fixture()
        data["twse_prices"][0]["ClosingPrice"] = "1000"
        data["tpex_prices"][0]["Close"] = "1000"
        result = MODULE.estimate_market_ratio(data, 10_000_000, "2026-07-31")
        self.assertEqual(result["value"], 200.0)
        self.assertEqual(result["coverage_ratio"], 100.0)
        self.assertEqual(result["matched_security_count"], 2)

    def test_date_scope_must_match(self):
        data = official_fixture()
        data["tpex_margin"][0]["Date"] = "1150730"
        with self.assertRaisesRegex(ValueError, "dates do not match"):
            MODULE.estimate_market_ratio(data, 10_000_000, "2026-07-31")

    def test_recent_cached_close_counts_as_suspended(self):
        data = official_fixture(missing_tpex_price=True)
        data["twse_prices"][0]["ClosingPrice"] = "1000"
        data["tpex_prices"].append({"Date": "1150730", "SecuritiesCompanyCode": "6488", "Close": "1000"})
        result = MODULE.estimate_market_ratio(data, 10_000_000, "2026-07-31")
        self.assertEqual(result["suspended_price_count"], 1)
        self.assertEqual(result["coverage_ratio"], 100.0)

    def test_coverage_below_95_retains_previous(self):
        data = official_fixture(missing_tpex_price=True)
        data["twse_prices"][0]["ClosingPrice"] = "2000"
        previous = {
            "data_date": "2026-07-30",
            "maintenance_ratio": {"value": 175.5, "effective_data_date": "2026-07-30", "collateral_market_value": 1, "financing_amount": 1},
            "history": [], "price_cache": {}
        }
        payload = MODULE.build_payload(balance_history(), dt.datetime(2026, 7, 31, 12, tzinfo=dt.timezone.utc), previous, data)
        self.assertEqual(payload["maintenance_ratio"]["value"], 175.5)
        self.assertTrue(payload["maintenance_ratio"]["retained_previous"])
        self.assertEqual(payload["maintenance_ratio"]["coverage_state"], "retained_previous")

    def test_checked_in_payload_is_valid_and_estimated(self):
        payload = json.loads((ROOT / "margin-data.json").read_text(encoding="utf-8"))
        MODULE.validate_payload(payload)
        self.assertGreater(payload["margin_balance"]["value"], 0)
        self.assertEqual(payload["maintenance_ratio"]["method"], "estimated_market_margin_maintenance_ratio")
        self.assertTrue(payload["maintenance_ratio"]["is_estimated"])
        self.assertGreaterEqual(len(payload["history"]), 120)

    def test_payload_rejects_nan_and_zero(self):
        payload = {
            "data_date": "2026-07-31", "margin_balance": {"value": math.nan},
            "maintenance_ratio": {"value": 0, "method": "estimated_market_margin_maintenance_ratio", "is_estimated": True},
            "history": [{}] * 120,
        }
        with self.assertRaises(ValueError):
            MODULE.validate_payload(payload)

    def test_history_keeps_at_least_120_rows(self):
        rows = MODULE.merge_history(balance_history(130), None, None)
        self.assertEqual(len(rows), 130)
        self.assertIn("collateral_market_value", rows[-1])

    def test_risk_bands_include_regulatory_reference_without_margin_call_claim(self):
        self.assertEqual(MODULE.risk_state_for(130), "接近法規參考區")
        self.assertEqual(MODULE.risk_state_for(129.9), "極端壓力區")

    def test_workflow_has_both_taipei_after_hours_runs(self):
        workflow = (ROOT / ".github" / "workflows" / "update-margin-data.yml").read_text(encoding="utf-8")
        self.assertIn('cron: "0 10 * * 1-5"', workflow)
        self.assertIn('cron: "0 11 * * 1-5"', workflow)
        self.assertIn("cancel-in-progress: true", workflow)


if __name__ == "__main__":
    unittest.main()
