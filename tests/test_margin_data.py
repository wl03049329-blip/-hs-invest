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


class MarginDataTests(unittest.TestCase):
    def test_checked_in_payload_is_valid_and_never_uses_zero_for_missing_ratio(self):
        payload = json.loads((ROOT / "margin-data.json").read_text(encoding="utf-8"))
        MODULE.validate_payload(payload)
        self.assertGreater(payload["margin_balance"]["value"], 0)
        self.assertIsNone(payload["maintenance_ratio"]["value"])
        self.assertEqual(payload["data_mode"], "after_hours")
        self.assertIn("maintenance_ratio", payload["source_status"])
        self.assertEqual(payload["source_status"]["maintenance_ratio"]["reason"], "official_market_aggregate_not_published")

    def test_payload_rejects_bad_values(self):
        payload = {
            "data_date": "2026-07-31",
            "margin_balance": {"value": math.nan},
            "maintenance_ratio": {"value": None},
        }
        with self.assertRaises(ValueError):
            MODULE.validate_payload(payload)

    def test_payload_rejects_unreasonable_daily_jump(self):
        payload = {
            "data_date": "2026-07-31",
            "margin_balance": {"value": 100, "daily_change": 60},
            "maintenance_ratio": {"value": None},
        }
        with self.assertRaisesRegex(ValueError, "daily jump"):
            MODULE.validate_payload(payload)

    def test_percentile_requires_enough_samples(self):
        self.assertIsNone(MODULE.percentile([1.0] * 19, 1.0))
        self.assertEqual(MODULE.percentile(list(range(1, 21)), 10), 50.0)

    def test_roc_date_conversion(self):
        self.assertEqual(MODULE.roc_date_to_iso("1150731"), "2026-07-31")
        self.assertIsNone(MODULE.roc_date_to_iso("bad"))

    def test_workflow_has_both_taipei_after_hours_runs(self):
        workflow = (ROOT / ".github" / "workflows" / "update-margin-data.yml").read_text(encoding="utf-8")
        self.assertIn('cron: "0 10 * * 1-5"', workflow)
        self.assertIn('cron: "0 11 * * 1-5"', workflow)
        self.assertIn("cancel-in-progress: true", workflow)


if __name__ == "__main__":
    unittest.main()
