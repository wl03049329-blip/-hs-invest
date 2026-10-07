"""Isolated, published-anchor fixtures; never mutate production ledgers."""
import copy
import os
import subprocess
import unittest
from unittest.mock import patch

import phase_l7_bridge as bridge
import phase_l7_daily as daily
import phase_l7_shadow as shadow
import test_phase_l7_sources as sources
from test_phase_l7_daily import at, data_for, yahoo_for


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.source = sources.SourceTests()
        self.source.setUpClass()
        self.source.setUp()
        self.policy = self.source.policy
        self.source.prior = data_for(self.source.rows, at("2026-09-30"))
        anchor = self.source.prior["item"]["rows"][-1]
        anchor["source_provenance"] = {"integrity_status": "PASS", "trading_date": anchor["date"],
                                       "adjustment_factor": 1, "effective_source": "YAHOO"}
        self.source.prior["metadata"]["data_version"] = "adjusted_daily_v1:fixture"
        self.source.publish_verified_previous()
        self.addCleanup(self.source.doCleanups)
        self.root = self.source.root
        self.source.rows += [{**copy.deepcopy(self.source.rows[-1]), "date": day} for day in
                             ("2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07")]
        self.source.yahoo = yahoo_for(self.source.rows)
        self.source.official["202610"] = {"stat": "OK", "date": "20261001", "title": "00631L 各日成交資訊",
            "fields": ["日期", "成交股數", "開盤價", "最高價", "最低價", "收盤價"],
            "data": [[r["date"], "100", "40", "41", "39", "40"] for r in self.source.rows[-5:]]}
        self.now = at("2026-10-08", "03:00:00")

    def collect(self, enabled=True):
        return daily.collect(self.source.historical, self.source.prior, self.policy, self.now,
                             self.source.fetch, root=self.root, allow_official_bridge=enabled,
                             bridge_review_required=enabled)[0]

    def null(self, day="2026-10-07", fields=("close", "adjclose")):
        result = self.source.yahoo["chart"]["result"][0]
        index = [daily.datetime.fromtimestamp(s, daily.TAIPEI).date().isoformat()
                 for s in result["timestamp"]].index(day)
        for field in fields:
            array = (result["indicators"]["adjclose"][0]["adjclose"] if field == "adjclose"
                     else result["indicators"]["quote"][0][field])
            array[index] = None

    def omit(self, day="2026-10-06"):
        result = self.source.yahoo["chart"]["result"][0]
        index = [daily.datetime.fromtimestamp(s, daily.TAIPEI).date().isoformat()
                 for s in result["timestamp"]].index(day)
        result["timestamp"].pop(index)
        for array in result["indicators"]["quote"][0].values():
            array.pop(index)
        result["indicators"]["adjclose"][0]["adjclose"].pop(index)

    def incident(self, reason="FALLBACK_ADJUSTMENT_UNRESOLVED", identifier="GAP:fixture", requires_review=True):
        shadow.append_record(self.root / daily.INCIDENTS, {"record_type": "DAILY_VALIDATION_FAILURE",
            "record_id": identifier, "reason": reason, "requires_integrity_review": requires_review,
            "latest_data_date": "2026-09-30", "expected_completed_bar": "2026-10-07",
            "checked_at": at("2026-10-08", "01:00:00").isoformat()})

    def tick(self, flag=False, event="workflow_dispatch"):
        with patch.dict(os.environ, {"GITHUB_EVENT_NAME": event, "GITHUB_RUN_ID": "12346"}), patch.object(
                shadow, "load_context", return_value=(self.policy, self.source.historical)):
            return daily.run(self.root, now=self.now, fetcher=self.source.fetch,
                             review_source_gap_recovery=flag)

    def test_complete_primary_remains_yahoo_without_bridge(self):
        data = self.collect(enabled=False)
        self.assertTrue(all(r["source_provenance"]["effective_source"] == "YAHOO" for r in data["item"]["rows"][-5:]))
        self.assertNotIn("official_factor_one_bridge", data["metadata"])

    def test_full_primary_recovery_does_not_hide_non_one_adjustment(self):
        self.source.yahoo["chart"]["result"][0]["indicators"]["adjclose"][0]["adjclose"][-1] = 39
        with self.assertRaisesRegex(daily.Error, "BRIDGE_NON_ONE_ADJUSTMENT"):
            daily.collect(self.source.historical, self.source.prior, self.policy, self.now,
                          self.source.fetch, root=self.root, allow_official_bridge=True)

    def test_absent_session_and_null_latest_bridge_with_provenance(self):
        self.omit()
        self.null()
        before = copy.deepcopy(self.source.yahoo)
        data = self.collect()
        self.assertEqual(self.source.yahoo, before)
        self.assertEqual(data["metadata"]["official_factor_one_bridge"]["bridge_sessions"],
                         ["2026-10-06", "2026-10-07"])
        for r in data["item"]["rows"][-2:]:
            self.assertEqual(r["adjustment_factor"], 1)
            self.assertEqual(r["source_provenance"]["effective_source"], "TWSE_FACTOR_ONE_BRIDGE")
            self.assertEqual(r["source_provenance"]["bridge_anchor_date"], "2026-09-30")
            self.assertEqual(set(r["source_provenance"]["corporate_action_receipts_sha256"]), set(bridge.ACTION_DATASETS))

    def test_whole_null_row_can_bridge_but_arbitrary_missing_open_cannot(self):
        self.null("2026-10-06", (*daily.FIELDS, "volume", "adjclose"))
        self.assertEqual(self.collect()["item"]["rows"][-2]["source_provenance"]["effective_source"], "TWSE_FACTOR_ONE_BRIDGE")
        self.source.yahoo = yahoo_for(self.source.rows)
        self.null("2026-10-06", ("open",))
        with self.assertRaisesRegex(daily.Error, "BRIDGE_UNSUPPORTED_PRIMARY_GAP"):
            self.collect()

    def test_non_null_price_or_adjustment_conflict_fails(self):
        for field in ("open", "high", "low", "close", "adjclose"):
            with self.subTest(field=field):
                self.source.yahoo = yahoo_for(self.source.rows)
                self.null()
                result = self.source.yahoo["chart"]["result"][0]
                array = (result["indicators"]["adjclose"][0]["adjclose"] if field == "adjclose"
                         else result["indicators"]["quote"][0][field])
                array[-1] = 42
                with self.assertRaisesRegex(daily.Error, "BRIDGE_PRIMARY_CONFLICT|BRIDGE_NON_ONE_ADJUSTMENT"):
                    self.collect()

    def test_volume_discrepancy_is_provenance_and_row_uses_twse_volume(self):
        self.null()
        self.source.yahoo["chart"]["result"][0]["indicators"]["quote"][0]["volume"][-1] = 99
        row = self.collect()["item"]["rows"][-1]
        self.assertEqual(row["volume"], 100)
        self.assertEqual(row["source_provenance"]["yahoo_volume"], 99)
        self.assertEqual(row["source_provenance"]["twse_volume"], 100)
        self.assertTrue(row["source_provenance"]["volume_discrepancy"])
        self.assertEqual(row["source_provenance"]["volume_difference"], 1)

    def test_volume_if_present_must_still_be_finite_and_positive(self):
        self.null()
        for value in (0, -1, float("nan"), float("inf"), True):
            self.source.yahoo["chart"]["result"][0]["indicators"]["quote"][0]["volume"][-1] = value
            with self.subTest(value=value):
                with self.assertRaisesRegex(daily.Error, "BRIDGE_INVALID_PRIMARY_VALUE"):
                    self.collect()

    def test_each_corporate_action_event_and_unavailability_fails(self):
        for dataset in bridge.ACTION_DATASETS:
            original = copy.deepcopy(self.source.actions[dataset])
            with self.subTest(dataset=dataset, mode="event"):
                self.source.actions[dataset]["data"] = [{"stock_id": "00631L", "date": "2026-10-06"}]
                with self.assertRaisesRegex(daily.Error, "CORPORATE_ACTION_REVIEW_REQUIRED"):
                    self.collect()
            self.source.actions[dataset] = {"status": 502, "msg": "unavailable", "data": []}
            with self.subTest(dataset=dataset, mode="unavailable"):
                with self.assertRaisesRegex(daily.Error, "CORPORATE_ACTION_SOURCE_UNAVAILABLE"):
                    self.collect()
            self.source.actions[dataset] = original

    def test_anchor_tampering_or_non_one_is_rejected(self):
        self.source.prior["item"]["rows"][-1]["adjustment_factor"] = .5
        with self.assertRaisesRegex(daily.Error, "ANCHOR_UNVERIFIED|ADJUSTMENT_UNRESOLVED"):
            self.collect()

    def test_anchor_missing_provenance_fails(self):
        del self.source.prior["item"]["rows"][-1]["source_provenance"]
        with self.assertRaisesRegex(daily.Error, "ANCHOR_UNVERIFIED|PROVENANCE_REQUIRED"):
            self.collect()

    def test_official_missing_session_fails(self):
        self.source.official["202610"]["data"].pop(-2)
        self.omit()
        with self.assertRaisesRegex(daily.Error, "BRIDGE_OFFICIAL_SESSION_MISSING"):
            self.collect()

    def test_bridge_origin_does_not_reset_ten_session_limit(self):
        anchor = copy.deepcopy(self.source.prior["item"]["rows"][-1])
        anchor["source_provenance"].update(bridge_anchor_date="2026-09-01", verified_commit="a" * 40,
                                          verified_workflow_run_id="1")
        with patch.object(daily, "verified_previous_bar", return_value=anchor):
            with self.assertRaisesRegex(daily.Error, "BRIDGE_WINDOW_REVIEW_REQUIRED"):
                self.collect()

    def test_flag_false_stays_latched_and_schedule_cannot_approve(self):
        self.incident()
        ledger = self.root / self.policy["paths"]["forward_ledger"]
        before = ledger.read_bytes()
        self.assertTrue(self.tick()["requires_integrity_review"])
        self.assertEqual(ledger.read_bytes(), before)
        with self.assertRaisesRegex(daily.Error, "RECOVERY_MANUAL_NON_DRY_DISPATCH_REQUIRED"):
            self.tick(flag=True, event="schedule")
        self.assertEqual(ledger.read_bytes(), before)

    def test_authorized_recovery_no_backfill_preserves_incidents_and_is_idempotent(self):
        self.omit()
        self.null()
        self.incident()
        ledger = self.root / self.policy["paths"]["forward_ledger"]
        r = shadow.evaluate(self.source.rows, len(self.source.rows) - 7, self.policy)
        r["calculated_at"] = at("2026-09-29").isoformat()
        shadow.append_record(ledger, r)
        old_ledger = ledger.read_bytes()
        old_incidents = (self.root / daily.INCIDENTS).read_bytes()
        status = self.tick(flag=True)
        self.assertEqual(status["status"], "NO_CURRENT_COMPLETED_SESSION_NO_BACKFILL")
        self.assertEqual(status["latest_data_date"], "2026-10-07")
        self.assertEqual(status["forward_observations"], 1)
        self.assertFalse(status["requires_integrity_review"])
        self.assertEqual(status["eligible_observations"], 0)
        self.assertEqual(status["capital_allocation_pct"], 0)
        self.assertTrue(ledger.read_bytes().startswith(old_ledger))
        self.assertEqual((self.root / daily.INCIDENTS).read_bytes(), old_incidents)
        recovery = shadow.read_jsonl(ledger)[-1]
        self.assertEqual(recovery["record_type"], "CORPORATE_ACTION_RECOVERY")
        self.assertEqual(recovery["incident_id"], "GAP:fixture")
        self.assertEqual(recovery["approved_by"], bridge.APPROVED_BY)
        self.assertGreaterEqual(len(recovery["recovery_steps_completed"]), 12)
        before = ledger.read_bytes()
        subprocess.run(["git", "-C", str(self.root), "-c", "core.autocrlf=false", "add", "--",
                        daily.SNAPSHOT, daily.STATUS, self.policy["paths"]["forward_ledger"]], check=True)
        subprocess.run(["git", "-C", str(self.root), "-c", "user.name=github-actions[bot]",
                        "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
                        "commit", "-qm", "fixture publish recovery"], check=True)
        self.source.prior = shadow.read_json(self.root / daily.SNAPSHOT)
        # A following normal run can use the approved bridge, but cannot review.
        self.assertEqual(self.tick(event="schedule")["forward_observations"], 1)
        self.assertEqual(ledger.read_bytes(), before)
        self.assertEqual(shadow.validate_hash_chain(ledger)["status"], "PASS")

    def test_p0_prevents_all_recovery(self):
        self.incident()
        self.incident("PROVENANCE_ARTIFACT_HASH_MISMATCH:file", "P0:fixture")
        ledger = self.root / self.policy["paths"]["forward_ledger"]
        before = ledger.read_bytes()
        self.assertEqual(self.tick(flag=True)["status"], "FAIL_CLOSED")
        self.assertEqual(ledger.read_bytes(), before)

    def test_historical_revision_is_never_reviewed(self):
        self.incident("HISTORICAL_REVISION_REVIEW_REQUIRED:2026-09-30", "REVISION:fixture")
        self.assertTrue(self.tick(flag=True)["requires_integrity_review"])
        self.assertFalse(any(r.get("record_type") == "CORPORATE_ACTION_RECOVERY"
                             for r in shadow.read_jsonl(self.root / self.policy["paths"]["forward_ledger"])))

    def test_exact_whitelist_keeps_old_nonadjacent_and_removed_date_latched(self):
        self.incident()
        self.incident("FALLBACK_PREVIOUS_ANCHOR_NOT_ADJACENT", "OTHER:anchor")
        self.incident("HISTORICAL_DATE_REMOVED", "OTHER:historical")
        status = self.tick(flag=True)
        self.assertEqual(status["status"], "FAIL_CLOSED")
        records = shadow.read_jsonl(self.root / self.policy["paths"]["forward_ledger"])
        self.assertEqual([r["incident_id"] for r in records if r["record_type"] == "CORPORATE_ACTION_RECOVERY"],
                         ["GAP:fixture"])
        self.assertTrue(status["requires_integrity_review"])

    def test_legacy_false_review_flags_do_not_block_or_receive_recovery(self):
        self.incident()
        self.incident("FALLBACK_PREVIOUS_ANCHOR_NOT_ADJACENT", "LEGACY:anchor", requires_review=False)
        self.incident("HISTORICAL_DATE_REMOVED", "LEGACY:historical", requires_review=False)
        self.incident("UNKNOWN_LEGACY_REASON", "LEGACY:unknown", requires_review=False)
        before = (self.root / daily.INCIDENTS).read_bytes()
        status = self.tick(flag=True)
        self.assertEqual(status["status"], "NO_CURRENT_COMPLETED_SESSION_NO_BACKFILL")
        self.assertEqual(status["data_integrity"], "PASS")
        self.assertFalse(status["requires_integrity_review"])
        records = shadow.read_jsonl(self.root / self.policy["paths"]["forward_ledger"])
        self.assertEqual([r["incident_id"] for r in records if r["record_type"] == "CORPORATE_ACTION_RECOVERY"],
                         ["GAP:fixture"])
        self.assertEqual((self.root / daily.INCIDENTS).read_bytes(), before)

    def test_dry_run_cannot_approve(self):
        self.incident()
        with patch.dict(os.environ, {"GITHUB_EVENT_NAME": "workflow_dispatch"}):
            with self.assertRaisesRegex(daily.Error, "RECOVERY_MANUAL_NON_DRY_DISPATCH_REQUIRED"):
                daily.run(self.root, now=self.now, fetcher=self.source.fetch, dry_run=True,
                          review_source_gap_recovery=True)

    def test_bad_fresh_second_collection_cannot_publish(self):
        self.incident()
        before = (self.root / daily.SNAPSHOT).read_bytes()
        original = self.source.fetch
        calls = 0
        def fetch(url):
            nonlocal calls
            if url == daily.CALENDAR_URL:
                calls += 1
                if calls == 2:
                    raise OSError("secret")
            return original(url)
        with patch.object(self.source, "fetch", side_effect=fetch):
            self.assertEqual(self.tick(flag=True)["status"], "FAIL_CLOSED")
        self.assertEqual((self.root / daily.SNAPSHOT).read_bytes(), before)

    def test_workflow_recovery_default_false_and_manual_only(self):
        text = (shadow.ROOT / ".github/workflows/00631l-forward-shadow.yml").read_text()
        recovery = text.split("review_source_gap_recovery:", 1)[1].split("push:", 1)[0]
        self.assertIn("default: false", recovery)
        self.assertIn("github.event_name == 'workflow_dispatch' && inputs.review_source_gap_recovery", text)
        self.assertIn('test "$DRY_RUN" = "false"', text)


if __name__ == "__main__":
    unittest.main()
