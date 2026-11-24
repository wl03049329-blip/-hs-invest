import unittest
import datetime as dt
import json
from unittest.mock import patch
from scripts.check_completed_market import inspect, SYMBOLS
from scripts.check_completed_market import repair
from scripts import update_market_quotes as quotes


class CompletedPublication(unittest.TestCase):
    def setUp(self):
        self.q = dict(official_source_dates=dict(TWSE="2026-11-02", TPEx="2026-11-02"),
                      source_status=dict(TWSE="official_closing_data_daily_report", TPEx="official_closing_data"))
        self.d = dict(expected_completed_bar="2026-11-02", next_expected_trading_day="2026-11-03",
                      symbols={s: dict(status="CURRENT", latest_verified_date="2026-11-02") for s in SYMBOLS})
        self.s = dict(snapshots=[dict(date="2026-11-02", finalized=True)])

    def run_report(self):
        return inspect("2026-11-02", self.q, self.d, self.s)

    def test_complete(self):
        self.assertTrue(self.run_report()["healthy"])

    def test_unknown_next_session_does_not_invalidate_completed_session(self):
        self.d["next_expected_trading_day"] = None
        self.assertTrue(self.run_report()["healthy"])
        del self.q["official_source_dates"]["TWSE"]
        self.assertEqual(self.run_report()["reasons"], ["OFFICIAL_CLOSE_NOT_CURRENT_TWSE"])
        self.s["snapshots"] = []
        self.assertIn("CORE_CLOSE_NOT_CURRENT", self.run_report()["reasons"])

    def test_explicit_unknown_does_not_mask_bad_bars_or_calendar(self):
        self.d["next_expected_trading_day"] = None
        self.d["symbols"].pop(next(iter(SYMBOLS)))
        self.d["symbols"]["unrelated"] = dict(status="CURRENT", latest_verified_date="2026-11-02")
        self.assertEqual(self.run_report()["reasons"], ["DAILY_BARS_INCOMPLETE"])
        self.d["expected_completed_bar"] = "2026-10-30"
        self.assertIn("DAILY_CALENDAR_NOT_CURRENT", self.run_report()["reasons"])

    def test_fresh_timestamp_cannot_mask_old_date(self):
        self.q["updated_at"] = "2026-11-03T00:53:00+08:00"
        self.q["official_source_dates"]["TWSE"] = "2026-10-30"
        self.assertIn("OFFICIAL_CLOSE_NOT_CURRENT_TWSE", self.run_report()["reasons"])

    def test_single_market_failure(self):
        self.q["source_status"]["TPEx"] = "cached_after_error"
        self.assertFalse(self.run_report()["healthy"])

    def test_stale_bar(self):
        self.d["symbols"][next(iter(SYMBOLS))]["latest_verified_date"] = "2026-10-30"
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

    def test_post_pages_waits_only_for_bounded_handoff_from_complete_prior_release(self):
        from scripts import check_completed_market as monitor
        from contextlib import redirect_stdout
        import io
        now = dt.datetime(2026, 11, 2, 21, 21, tzinfo=monitor.TZ)
        prior = "2026-10-30"
        self.d.update(expected_completed_bar=prior, next_expected_trading_day="2026-11-02",
                      symbols={s: dict(status="CURRENT", latest_verified_date=prior) for s in monitor.SYMBOLS})
        for event, elapsed, prior_failed, wait in [
            ("workflow_run", 60, False, True),
            ("workflow_run", 1200, False, False),
            ("workflow_run", 60, True, False),
            ("schedule", 60, False, True),
        ]:
            with self.subTest(event=event, elapsed=elapsed, prior_failed=prior_failed):
                self.d["symbols"]["009815"].update(
                    status="STALE" if prior_failed else "CURRENT",
                    reason="HTTP Error 522" if prior_failed else None)
                runs = [dict(id=100, status="in_progress", created_at=(now-dt.timedelta(seconds=elapsed)).isoformat(),
                             head_branch="main", path=".github/workflows/update-radar-daily.yml", event="schedule",
                             display_title="HS daily close calendar-current")]
                with patch.dict("os.environ", {"HS_COMPLETED_AUDIT_TRIGGER": event}), patch.object(monitor.dt, "datetime", wraps=dt.datetime) as clock, patch.object(monitor, "expected_day", return_value=("2026-11-02", None, None)), patch.object(monitor, "public_json", side_effect=[self.q, self.d, self.s]), patch.object(monitor.subprocess, "check_output", return_value=json.dumps({"workflow_runs": runs})), patch.object(monitor.subprocess, "run") as dispatch, patch("sys.argv", ["check", "--repair"]), redirect_stdout(io.StringIO()) as output:
                    clock.now.return_value = now
                    if wait:
                        monitor.main()
                    else:
                        with self.assertRaises(SystemExit) as failure:
                            monitor.main()
                        self.assertEqual(failure.exception.code, 1)
                    report = json.loads(output.getvalue())
                    self.assertIs(report["healthy"], None if wait else False)
                    self.assertEqual(report.get("waiting"), "WAIT_DAILY_PUBLICATION" if wait else None)
                    self.assertEqual(report["daily_unverified"]["009815"]["reason"], "HTTP Error 522" if prior_failed else None)
                    dispatch.assert_not_called()

    def test_real_incident_queued_repair_null_forecast_and_machine_report_are_not_false_failure(self):
        from scripts import check_completed_market as monitor
        from contextlib import redirect_stdout, redirect_stderr
        from pathlib import Path
        import tempfile
        import io
        now = dt.datetime(2026, 11, 24, 18, 16, 4, tzinfo=monitor.TZ)
        q = dict(official_source_dates={m:"2026-11-24" for m in ("TWSE","TPEx")},
                 source_status={m:"official_closing_data" for m in ("TWSE","TPEx")})
        d = dict(expected_completed_bar="2026-11-23", next_expected_trading_day=None,
                 symbols={s:dict(status="CURRENT",latest_verified_date="2026-11-23",reason=None) for s in SYMBOLS})
        scores = dict(snapshots=[dict(date="2026-11-24",finalized=True)])
        run = dict(id=45373134389,status="queued",created_at="2026-11-24T10:16:03Z",event="workflow_dispatch",
                   head_branch="main",path=".github/workflows/update-radar-daily.yml",display_title="HS daily close 2026-11-24")
        def child(command, **kwargs):
            self.assertIn("as_of=2026-11-24", command)
            kwargs["stdout"].write("https://github.com/fixture/actions/runs/45373134389\n")
        with tempfile.TemporaryDirectory() as temp, patch.dict("os.environ", {"HS_COMPLETED_AUDIT_TRIGGER":"workflow_run","HS_COMPLETED_PRODUCER_RESULT":""}), patch.object(monitor.dt,"datetime",wraps=dt.datetime) as clock, patch.object(monitor,"expected_day",return_value=("2026-11-24",None,None)), patch.object(monitor,"public_json",side_effect=[q,d,scores]), patch.object(monitor.subprocess,"check_output",side_effect=[json.dumps({"workflow_runs":[]}),json.dumps({"workflow_runs":[run]})]), patch.object(monitor.subprocess,"run",side_effect=child), redirect_stdout(io.StringIO()) as out, redirect_stderr(io.StringIO()) as err:
            destination=Path(temp)/"completed-market.json"
            clock.now.return_value=now
            with patch("sys.argv",["check","--repair","--report",str(destination)]):
                monitor.main()
            report=json.loads(destination.read_text(encoding="utf-8"))
            self.assertEqual(report,json.loads(out.getvalue()))
            self.assertIn("https://github.com/fixture",err.getvalue())
            self.assertIsNone(report["healthy"])
            self.assertEqual(report["waiting"],"WAIT_DAILY_PUBLICATION")
            self.assertEqual(report["repair_evidence"]["update-radar-daily.yml"]["id"],45373134389)
            self.assertEqual(set(report["reasons"]),{"DAILY_CALENDAR_NOT_CURRENT","DAILY_BARS_INCOMPLETE"})

    def test_handoff_evidence_uses_creation_deadline_and_exact_producer_scope(self):
        from scripts.check_completed_market import daily_publication_evidence
        now=dt.datetime(2026,11,24,10,20,tzinfo=dt.timezone.utc)
        base=dict(id=123,status="in_progress",created_at="2026-11-24T10:01:00Z",head_branch="main",
                  path=".github/workflows/update-radar-daily.yml",event="workflow_dispatch",display_title="HS daily close 2026-11-24")
        self.assertIsNotNone(daily_publication_evidence(base,now,"2026-11-24"))
        for patch_value in [dict(created_at="2026-11-24T10:00:00Z",run_started_at="2026-11-24T10:19:59Z"),
                            dict(created_at="2026-11-24T10:21:00Z"),dict(id=None),dict(status="completed",conclusion="failure"),
                            dict(head_branch="other"),dict(path="other.yml"),dict(event="pull_request"),
                            dict(display_title="HS daily close 2026-11-23"),dict(display_title="legacy unknown scope")]:
            with self.subTest(patch_value=patch_value):
                self.assertIsNone(daily_publication_evidence(base|patch_value,now,"2026-11-24"))

    def test_dispatch_acceptance_without_observed_run_does_not_defer(self):
        from scripts import check_completed_market as monitor
        now=dt.datetime(2026,11,2,21,tzinfo=monitor.TZ)
        evidence={}
        with patch.object(monitor.subprocess,"check_output",return_value=json.dumps({"workflow_runs":[]})), patch.object(monitor.subprocess,"run"), patch.object(monitor.time,"sleep"):
            result=repair(now,["DAILY_BARS_INCOMPLETE"],evidence=evidence,expected="2026-11-02")
        self.assertEqual(result,["update-radar-daily.yml:REQUESTED_NOT_YET_VERIFIED"])
        self.assertEqual(evidence,{})
        self.d.update(expected_completed_bar="2026-10-30",next_expected_trading_day=None,
                      symbols={s:dict(status="CURRENT",latest_verified_date="2026-10-30",reason=None) for s in SYMBOLS})
        report=inspect("2026-11-02",self.q,self.d,self.s)|dict(repair=result,repair_evidence=evidence)
        self.assertFalse(monitor.waiting_for_daily_publication(report,now))

    def test_delayed_schedule_uses_same_actual_session_gate_without_erasing_incident(self):
        from scripts import check_completed_market as monitor
        import io
        from contextlib import redirect_stdout
        for trigger in ("schedule","workflow_dispatch","workflow_run"):
            for hour,minute in ((9,0),(16,16),(17,59)):
                with self.subTest(trigger=trigger,hour=hour), patch.dict("os.environ",{"HS_COMPLETED_AUDIT_TRIGGER":trigger}), patch.object(monitor.dt,"datetime",wraps=dt.datetime) as clock, patch.object(monitor,"expected_day") as calendar, patch.object(monitor,"repair") as recover, patch("sys.argv",["check","--repair"]), redirect_stdout(io.StringIO()) as out:
                    clock.now.return_value=dt.datetime(2026,11,23,hour,minute,tzinfo=monitor.TZ)
                    monitor.main()
                    report=json.loads(out.getvalue());self.assertIsNone(report["healthy"])
                    self.assertEqual(report["reasons"],["WAIT_COMPLETED_SESSION_GATE"])
                    calendar.assert_not_called();recover.assert_not_called()
        for hour,minute in ((8,47),(18,0),(22,47)):
            with patch.object(monitor.dt,"datetime",wraps=dt.datetime) as clock, patch.object(monitor,"expected_day",side_effect=RuntimeError("CALENDAR_MUST_STILL_VALIDATE")), patch("sys.argv",["check","--repair"]):
                clock.now.return_value=dt.datetime(2026,11,23,hour,minute,tzinfo=monitor.TZ)
                with self.assertRaisesRegex(RuntimeError,"CALENDAR_MUST_STILL_VALIDATE"):monitor.main()

    def test_producer_completion_or_missing_forecast_contract_cannot_wait(self):
        from scripts import check_completed_market as monitor
        import io
        from contextlib import redirect_stdout
        now=dt.datetime(2026,11,2,21,21,tzinfo=monitor.TZ)
        self.d.update(expected_completed_bar="2026-10-30",next_expected_trading_day=None,
                      symbols={s:dict(status="CURRENT",latest_verified_date="2026-10-30",reason=None) for s in SYMBOLS})
        run=dict(id=123,status="in_progress",created_at=(now-dt.timedelta(seconds=60)).isoformat(),head_branch="main",
                 path=".github/workflows/update-radar-daily.yml",event="schedule",display_title="HS daily close calendar-current")
        for completion in ("success","failure","cancelled"):
            with patch.dict("os.environ",{"HS_COMPLETED_PRODUCER_RESULT":completion}), patch.object(monitor.dt,"datetime",wraps=dt.datetime) as clock, patch.object(monitor,"expected_day",return_value=("2026-11-02",None,None)), patch.object(monitor,"public_json",side_effect=[self.q,self.d,self.s]), patch.object(monitor.subprocess,"check_output",return_value=json.dumps({"workflow_runs":[run]})), patch("sys.argv",["check","--repair"]), redirect_stdout(io.StringIO()) as output:
                clock.now.return_value=now
                with self.assertRaises(SystemExit):monitor.main()
                self.assertIs(json.loads(output.getvalue())["healthy"],False)
        self.d.pop("next_expected_trading_day")
        report=inspect("2026-11-02",self.q,self.d,self.s)|dict(repair=["update-radar-daily.yml:PUBLICATION_IN_PROGRESS"],repair_evidence={"update-radar-daily.yml":run})
        self.assertFalse(monitor.waiting_for_daily_publication(report,now))

    def test_report_artifact_is_exclusive_and_contains_no_cli_output(self):
        from scripts.check_completed_market import emit_report
        import tempfile
        import io
        from pathlib import Path
        from contextlib import redirect_stdout
        with tempfile.TemporaryDirectory() as directory, redirect_stdout(io.StringIO()):
            path=Path(directory)/"report.json"
            emit_report({"healthy":False,"reasons":["SOURCE_FAILURE"]},path)
            before=path.read_bytes()
            with self.assertRaises(FileExistsError):emit_report({"healthy":True},path)
            self.assertEqual(path.read_bytes(),before)


if __name__ == "__main__":
    unittest.main()
