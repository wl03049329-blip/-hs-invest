"""Isolated operational dedupe; real collector with fixture network sources."""
import copy
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import phase_l7_daily as daily
import phase_l7_incidents as ops
import phase_l7_shadow as shadow
import build_frontend_status as frontend
from test_phase_l7_daily import at, data_for, yahoo_for
import test_phase_l7_sources as source_cases


class IncidentTests(unittest.TestCase):
    def setUp(self):
        self.source = source_cases.SourceTests()
        source_cases.SourceTests.setUpClass()
        self.source.setUp()
        self.policy = self.source.policy
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source.root = self.root
        self.now = at("2026-10-02")
        self.source.rows += [
            {**self.source.rows[-1], "date": "2026-10-01"},
            {**self.source.rows[-1], "date": "2026-10-02"},
        ]
        self.prior = data_for(self.source.rows[:-2], at("2026-09-30"))
        self.source.prior = self.prior
        self.source.yahoo = yahoo_for(self.source.rows)
        self.source.official["202610"] = {
            "stat": "OK", "date": "20261001", "title": "00631L 各日成交資訊",
            "fields": ["日期", "成交股數", "開盤價", "最高價", "最低價", "收盤價"],
            "data": [[day, "100", "40", "41", "39", "40"] for day in ("2026-10-01", "2026-10-02")],
        }
        self.partial = copy.deepcopy(self.source.yahoo)
        item = self.partial["chart"]["result"][0]
        for series in item["indicators"]["quote"][0].values():
            series[-2] = None
        item["indicators"]["adjclose"][0]["adjclose"][-2:] = [None, None]
        item["indicators"]["quote"][0]["close"][-1] = None
        self.source.yahoo = copy.deepcopy(self.partial)
        self.files = [daily.SNAPSHOT, daily.STATUS, daily.INCIDENTS,
                      *self.policy["paths"].values(), "00631l-leverage-status-v1.json"]
        for relative in self.files:
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if relative == daily.SNAPSHOT:
                target.write_text(json.dumps(self.prior), encoding="utf-8")
            elif relative == "00631l-leverage-status-v1.json":
                target.write_bytes((shadow.ROOT / relative).read_bytes())
            elif relative == daily.STATUS:
                target.write_text("{}", encoding="utf-8")
            else:
                target.write_bytes(b"")
        (self.root / "research/hs_leverage/phase_l7_forward_policy.json").write_text(
            json.dumps(self.policy), encoding="utf-8")

    def tick(self, **kw):
        with patch.object(shadow, "load_context", return_value=(self.policy, self.source.historical)):
            return daily.run(self.root, now=self.now, fetcher=self.source.fetch, **kw)

    def bytes(self):
        return {p.relative_to(self.root).as_posix(): p.read_bytes()
                for p in self.root.rglob("*") if p.is_file() and ".git" not in p.parts}

    def test_first_second_third_and_source_probe_every_wakeup(self):
        untouched = {p: (self.root / p).read_bytes() for p in self.files
                     if p not in (daily.STATUS, daily.INCIDENTS)}
        first = self.tick()
        self.assertEqual(first["workflow_classification"], "NEW_FAIL_CLOSED")
        self.assertEqual(ops.exit_code(first), 2)
        self.assertTrue(first["requires_integrity_review"])
        self.assertEqual(len(shadow.read_jsonl(self.root / daily.INCIDENTS)), 1)
        before = self.bytes()
        for clock in ("19:47:00", "21:47:00"):
            self.now = at("2026-10-02", clock)
            with patch.object(self.source, "fetch", wraps=self.source.fetch) as fetch:
                result = self.tick()
            self.assertTrue(any("yahoo" in call.args[0] for call in fetch.call_args_list))
            self.assertEqual(result["workflow_classification"], "KNOWN_FAIL_CLOSED_DEDUPED")
            self.assertEqual(result["data_integrity"], "FAIL")
            self.assertTrue(result["requires_integrity_review"])
            self.assertEqual(ops.exit_code(result), 0)
            self.assertEqual(self.bytes(), before)
        self.assertEqual(untouched, {p: (self.root / p).read_bytes() for p in untouched})
        self.assertEqual(shadow.validate_hash_chain(self.root / daily.INCIDENTS)["status"], "PASS")

    def test_duplicate_git_diff_clean(self):
        self.tick()
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        subprocess.run(["git", "-C", str(self.root), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.root), "-c", "user.name=Fixture",
                        "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], check=True)
        self.tick()
        self.assertEqual(subprocess.check_output(
            ["git", "-C", str(self.root), "status", "--porcelain"]), b"")

    def test_new_cause_is_new_not_recovery_change(self):
        self.tick()
        # Ensure the official expected day is still resolved before failure.
        def broken(*args, **kw):
            args[4](daily.CALENDAR_URL)
            raise daily.Error("SOURCE_SCHEMA_CHANGED")
        with patch.object(daily, "collect", side_effect=broken):
            result = self.tick()
        self.assertEqual(result["workflow_classification"], "NEW_FAIL_CLOSED")
        self.assertEqual(len(shadow.read_jsonl(self.root / daily.INCIDENTS)), 2)

    def test_new_target_same_cause_is_new(self):
        self.tick()
        self.now = at("2026-10-05")
        result = self.tick()
        self.assertEqual(result["expected_completed_bar"], "2026-10-05")
        self.assertEqual(result["workflow_classification"], "NEW_FAIL_CLOSED")
        self.assertEqual(len(shadow.read_jsonl(self.root / daily.INCIDENTS)), 2)

    def test_material_partial_evidence_change_then_duplicate(self):
        self.tick()
        self.source.yahoo["chart"]["result"][0]["indicators"]["quote"][0]["open"][-2] = 40
        result = self.tick()
        self.assertEqual(result["workflow_classification"], "RECOVERY_EVIDENCE_CHANGED")
        self.assertEqual(ops.exit_code(result), 2)
        before = self.bytes()
        self.assertEqual(self.tick()["workflow_classification"], "KNOWN_FAIL_CLOSED_DEDUPED")
        self.assertEqual(before, self.bytes())

    def test_complete_yahoo_recovery_stays_latched_without_price_or_ledger(self):
        self.tick()
        protected = {p: (self.root / p).read_bytes() for p in self.files
                     if p not in (daily.STATUS, daily.INCIDENTS)}
        self.source.yahoo = yahoo_for(self.source.rows)
        result = self.tick()
        self.assertEqual(result["workflow_classification"], "RECOVERY_EVIDENCE_AVAILABLE")
        self.assertTrue(result["requires_integrity_review"])
        self.assertEqual(result["status"], "FAIL_CLOSED")
        self.assertEqual(ops.exit_code(result), 2)
        self.assertEqual(result["forward_observations"], 0)
        self.assertEqual(protected, {p: (self.root / p).read_bytes() for p in protected})
        before = self.bytes()
        self.assertEqual(self.tick()["workflow_classification"], "KNOWN_FAIL_CLOSED_DEDUPED")
        self.assertEqual(before, self.bytes())

    def test_p0_errors_never_suppressed(self):
        self.tick()
        for reason in ("PROTECTED_ARTIFACT_HASH_MISMATCH:file", "PROVENANCE_ARTIFACT_HASH_MISMATCH:file",
                       "WORKING_PROVENANCE_BYTE_MISMATCH:file", "INCIDENT_HASH_CHAIN_INVALID"):
            with self.subTest(reason=reason):
                with patch.object(daily, "collect", side_effect=daily.Error(reason)):
                    first = self.tick()
                    second = self.tick()
                self.assertEqual(first["workflow_classification"], "NEW_FAIL_CLOSED")
                self.assertEqual(second["workflow_classification"], "NEW_FAIL_CLOSED")
                self.assertEqual(ops.exit_code(second), 2)

    def test_unreviewed_p0_cannot_be_hidden_by_known_source_failure(self):
        self.tick()
        shadow.append_record(self.root / daily.INCIDENTS, {
            "record_type": "DAILY_VALIDATION_FAILURE", "record_id": "P0:fixture",
            "requires_integrity_review": True, "reason": "PROVENANCE_ARTIFACT_HASH_MISMATCH:file",
            "checked_at": self.now.isoformat(), "latest_data_date": "2026-09-30"})
        self.assertEqual(ops.exit_code(self.tick()), 2)
        self.source.yahoo = yahoo_for(self.source.rows)
        self.assertEqual(self.tick()["workflow_classification"], "NEW_FAIL_CLOSED")

    def test_load_context_integrity_checks_precede_any_suppression(self):
        self.tick()
        context_files = [*self.policy["protected_hashes"],
                         "research/hs_leverage/phase_l6_shadow_schema.json",
                         "research/hs_leverage/data/00631L-historical-adjusted.json"]
        context_files += [shadow.PROVENANCE_DIR + "/" + mirror for _, mirror in shadow.PROVENANCE_SCOPE]
        for relative in context_files:
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((shadow.ROOT / relative).read_bytes())
        for relative, reason in (
            ("research/hs_leverage/phase_l3.py", "PROTECTED_ARTIFACT_HASH_MISMATCH"),
            ("research/hs_leverage/frozen-v1/phase_l3.py", "PROVENANCE_ARTIFACT_HASH_MISMATCH"),
        ):
            target = self.root / relative
            original = target.read_bytes()
            target.write_bytes(b"tampered isolated fixture")
            try:
                for _ in range(2):
                    with self.assertRaisesRegex(daily.Error, reason):
                        daily.run(self.root, now=self.now, fetcher=self.source.fetch)
            finally:
                target.write_bytes(original)

    def test_fingerprint_excludes_volatile_metadata(self):
        self.tick()
        before = self.bytes()
        self.source.yahoo["chart"]["result"][0]["meta"]["regularMarketTime"] = 999
        with patch.dict(os.environ, {"GITHUB_RUN_ID": "different"}):
            result = self.tick()
        self.assertEqual(result["workflow_classification"], "KNOWN_FAIL_CLOSED_DEDUPED")
        self.assertEqual(self.bytes(), before)

    def test_transport_failure_no_raw_exception_body(self):
        with patch.object(daily, "collect", side_effect=OSError("SECRET raw credential payload")):
            result = self.tick()
        self.assertEqual(result["reason"], "SOURCE_TRANSPORT_ERROR")
        self.assertNotIn("SECRET", json.dumps(result))
        self.assertEqual(ops.exit_code(result), 2)

    def test_dry_run_writes_nothing(self):
        before = self.bytes()
        self.tick(dry_run=True)
        self.assertEqual(self.bytes(), before)

    def test_legacy_incident_uses_calendar_not_record_id(self):
        legacy = {"record_type": "DAILY_VALIDATION_FAILURE", "record_id": "FAIL:2026-10-03:old",
                  "checked_at": at("2026-10-03", "00:06:00").isoformat(),
                  "reason": "FALLBACK_ADJUSTMENT_UNRESOLVED",
                  "latest_data_date": "2026-09-30", "requires_integrity_review": True}
        shadow.append_record(self.root / daily.INCIDENTS, legacy)
        before = self.bytes()
        result = self.tick()
        self.assertEqual(result["workflow_classification"], "KNOWN_FAIL_CLOSED_DEDUPED")
        self.assertEqual(result["incident_identity"]["target_completed_trading_date"], "2026-10-02")
        self.assertEqual(before, self.bytes())
        self.source.yahoo = yahoo_for(self.source.rows)
        self.assertEqual(self.tick()["workflow_classification"], "RECOVERY_EVIDENCE_AVAILABLE")

    def test_github_success_never_promotes_snapshot(self):
        self.tick()
        self.assertEqual(ops.exit_code(self.tick()), 0)
        with self.assertRaisesRegex(ValueError, "VALIDATION_NOT_SUCCESSFUL"):
            frontend.build(self.root, "2026-10-02")
        node = os.environ.get("HS_TEST_NODE", "node")
        script = """const fs=require('fs'),assert=require('assert');
        const view=require('./leverage-state-view.js');
        const snapshot=JSON.parse(fs.readFileSync('00631l-leverage-status-v1.json'));
        snapshot.workflow.conclusion='success';
        const value=view.officialStatus(snapshot,Date.parse('2026-10-03T00:00:00+08:00'));
        assert.equal(value.price.freshness,'STALE');"""
        subprocess.run([node, "-e", script], cwd=shadow.ROOT, check=True)
        self.assertNotIn("conclusion", (shadow.ROOT / "leverage-state-view.js").read_text(encoding="utf-8"))
        self.assertEqual((self.root / "00631l-leverage-status-v1.json").read_bytes(),
                         (shadow.ROOT / "00631l-leverage-status-v1.json").read_bytes())

    def test_workflow_contract_no_snapshot_on_suppressed_success(self):
        text = (shadow.ROOT / ".github/workflows/00631l-forward-shadow.yml").read_text(encoding="utf-8")
        self.assertIn("47 9,11,13 * * 1-5", text)
        self.assertIn("workflows: [Finalize official EOD Core Score history]", text)
        self.assertIn("steps.collect.outputs.classification != 'KNOWN_FAIL_CLOSED_DEDUPED'", text)
        self.assertEqual(text.count("steps.collect.outputs.classification }}\" = \"VALIDATED"), 2)
        self.assertIn("if: steps.collect.outcome == 'failure'", text)

    def test_main_outputs_warning_and_exit_zero_without_promoting_health(self):
        self.tick()
        status = self.tick()
        summary = self.root / "summary.txt"
        output = self.root / "outputs.txt"
        with patch.object(shadow, "ROOT", self.root), patch.object(daily, "run", return_value=status), \
             patch("sys.argv", ["phase_l7_daily.py"]), patch.dict(os.environ, {
                 "GITHUB_OUTPUT": str(output), "GITHUB_STEP_SUMMARY": str(summary)}):
            self.assertEqual(daily.main(), 0)
        self.assertIn("classification=KNOWN_FAIL_CLOSED_DEDUPED", output.read_text(encoding="utf-8"))
        self.assertIn(ops.WARNING, summary.read_text(encoding="utf-8"))
        self.assertIn('"data_integrity": "FAIL"', summary.read_text(encoding="utf-8"))
        self.assertFalse((self.root / daily.FORWARD / ".daily.lock").exists())

    def test_unknown_target_and_unexpected_errors_never_suppress(self):
        self.tick()
        for error in (daily.Error("CALENDAR_UNAVAILABLE"), KeyError("secret raw provider body")):
            with patch.object(daily, "collect", side_effect=error):
                result = self.tick()
            self.assertEqual(ops.exit_code(result), 2)
            self.assertEqual(result["workflow_classification"], "NEW_FAIL_CLOSED")
            self.assertNotIn("secret", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
