import unittest
import datetime as dt
import json
from unittest.mock import patch
from scripts.check_completed_market import inspect
from scripts.check_completed_market import repair
from scripts import update_market_quotes as quotes


class CompletedPublication(unittest.TestCase):
    def setUp(self):
        self.q = dict(official_source_dates=dict(TWSE="2026-11-02", TPEx="2026-11-02"),
                      source_status=dict(TWSE="official_closing_data_daily_report", TPEx="official_closing_data"))
        self.d = dict(expected_completed_bar="2026-11-02", next_expected_trading_day="2026-11-03",
                      symbols={str(i): dict(status="CURRENT", latest_verified_date="2026-11-02") for i in range(6)})
        self.s = dict(snapshots=[dict(date="2026-11-02", finalized=True)])

    def run_report(self):
        return inspect("2026-11-02", self.q, self.d, self.s)

    def test_complete(self):
        self.assertTrue(self.run_report()["healthy"])

    def test_fresh_timestamp_cannot_mask_old_date(self):
        self.q["updated_at"] = "2026-11-03T00:53:00+08:00"
        self.q["official_source_dates"]["TWSE"] = "2026-10-30"
        self.assertIn("OFFICIAL_CLOSE_NOT_CURRENT_TWSE", self.run_report()["reasons"])

    def test_single_market_failure(self):
        self.q["source_status"]["TPEx"] = "cached_after_error"
        self.assertFalse(self.run_report()["healthy"])

    def test_stale_bar(self):
        self.d["symbols"]["0"]["latest_verified_date"] = "2026-10-30"
        self.assertIn("DAILY_BARS_INCOMPLETE", self.run_report()["reasons"])

    def test_stale_calendar(self):
        self.d["expected_completed_bar"] = "2026-10-30"
        self.assertIn("DAILY_CALENDAR_NOT_CURRENT", self.run_report()["reasons"])

    def test_old_core(self):
        self.s["snapshots"][0]["date"] = "2026-10-30"
        self.assertIn("CORE_CLOSE_NOT_CURRENT", self.run_report()["reasons"])

    def test_running_producer_not_dispatched_twice(self):
        with patch("scripts.check_completed_market.subprocess.check_output", return_value=json.dumps({"workflow_runs": [{"status": "in_progress"}]})), patch("scripts.check_completed_market.subprocess.run") as run:
            self.assertTrue(all("ALREADY_RUNNING" in r for r in repair(dt.datetime.now(dt.timezone.utc))))
            run.assert_not_called()

    def test_repair_cooldown_is_not_reported_as_success(self):
        now = dt.datetime(2026, 11, 2, 17, tzinfo=dt.timezone.utc)
        runs = [{"status": "completed", "event": "workflow_dispatch", "created_at": "2026-11-02T16:59:00Z"}]
        with patch("scripts.check_completed_market.subprocess.check_output", return_value=json.dumps({"workflow_runs": runs})), patch("scripts.check_completed_market.subprocess.run") as run:
            self.assertTrue(all("BOUNDED_COOLDOWN" in r for r in repair(now)))
            run.assert_not_called()

    def test_official_transport_retry_recovers_without_changing_data(self):
        with patch.object(quotes, "fetch_json", side_effect=[OSError("network"), {"raw": "official"}]) as fetch, patch.object(quotes.time_module, "sleep"):
            self.assertEqual(quotes.fetch_official_json("https://www.twse.com.tw/"), {"raw": "official"})
            self.assertEqual(fetch.call_count, 2)

    def test_official_transport_retry_bounded_and_fails_closed(self):
        with patch.object(quotes, "fetch_json", side_effect=OSError("network")) as fetch, patch.object(quotes.time_module, "sleep"):
            with self.assertRaises(OSError):
                quotes.fetch_official_json("https://www.twse.com.tw/")
            self.assertEqual(fetch.call_count, 3)


if __name__ == "__main__":
    unittest.main()
