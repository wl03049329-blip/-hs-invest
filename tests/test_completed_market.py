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

    def test_only_daily_missing_does_not_rerun_final_or_live_producer(self):
        with patch("scripts.check_completed_market.subprocess.check_output", return_value=json.dumps({"workflow_runs": []})), patch("scripts.check_completed_market.subprocess.run") as run:
            result = repair(dt.datetime.now(dt.timezone.utc), ["DAILY_CALENDAR_NOT_CURRENT", "DAILY_BARS_INCOMPLETE"])
            self.assertEqual(result, ["update-radar-daily.yml:REQUESTED_NOT_YET_VERIFIED"])
            self.assertEqual(run.call_count, 1)
            self.assertIn("update-radar-daily.yml", run.call_args.args[0])

    def test_healthy_publication_cannot_create_a_workflow_loop(self):
        with patch("scripts.check_completed_market.subprocess.check_output") as query, patch("scripts.check_completed_market.subprocess.run") as run:
            self.assertEqual(repair(dt.datetime.now(dt.timezone.utc), []), [])
            query.assert_not_called()
            run.assert_not_called()

    def test_post_pages_audit_main_success_same_repo_gate(self):
        from pathlib import Path
        workflow = Path(".github/workflows/completed-market-watchdog.yml").read_text(encoding="utf-8")
        self.assertIn("workflows: [HS Stable App Pages]", workflow)
        self.assertIn("types: [completed]", workflow)
        for gate in ["conclusion == 'success'", "head_branch == 'main'", "head_repository.full_name == github.repository"]:
            self.assertIn(gate, workflow)

    def test_intraday_pages_event_defers_without_claiming_health_or_dispatch(self):
        from scripts import check_completed_market as monitor
        import io
        from contextlib import redirect_stdout
        now = dt.datetime(2026, 11, 4, 10, tzinfo=monitor.TZ)
        with patch.dict("os.environ", {"HS_COMPLETED_AUDIT_TRIGGER": "workflow_run"}), patch.object(monitor.dt, "datetime") as clock, patch.object(monitor, "expected_day") as expected, patch.object(monitor, "repair") as recover, patch("sys.argv", ["check", "--repair"]), redirect_stdout(io.StringIO()) as output:
            clock.now.return_value = now
            monitor.main()
            report = json.loads(output.getvalue())
            self.assertIsNone(report["healthy"])
            self.assertTrue(report["deferred"])
            self.assertEqual(report["repair"], [])
            expected.assert_not_called()
            recover.assert_not_called()


if __name__ == "__main__":
    unittest.main()
