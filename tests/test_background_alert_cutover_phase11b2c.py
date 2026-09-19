from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from backend.background_alerts import BackgroundAlertEvaluator
from backend.push_service import PushConfig, PushService
from backend.push_store import CUTOVER_VERSION, PushSubscriptionStore


SUBSCRIPTION = {
    "endpoint": "https://fcm.googleapis.com/fcm/send/b2c",
    "keys": {"p256dh": "A" * 87, "auth": "B" * 22},
}
CONFIG = PushConfig("B" + "A" * 86, "private-test-only", "https://example.test")


def rule(*, cross=True, score=True, threshold=40, distance=0):
    return {
        "cross_level": cross,
        "downward_cross": True,
        "levels": "ALL",
        "score_enabled": score,
        "score_threshold": threshold,
        "distance": distance,
        "percentile_enabled": False,
        "percentiles": [90],
        "data_status": False,
        "data_recovery": False,
    }


def preferences(global_rule=None, etfs=None):
    return {"version": "HS_RADAR_ALERT_RULES_V1", "global": global_rule or rule(), "etfs": etfs or {}}


def artifact(scores_by_symbol):
    length = max(len(values) for values in scores_by_symbol.values())
    snapshots = []
    for index in range(length):
        date = f"2026-09-{18 + index:02d}"
        rows = []
        for symbol, values in scores_by_symbol.items():
            score = values[index]
            rows.append({"symbol": symbol, "final_core_score": score, "core_score_version": "FINAL_CORE_WEIGHT_V1"})
        rows.append({"symbol": "009815", "final_core_score": None, "status": "WAIT_NATIVE"})
        snapshots.append({"date": date, "snapshot_type": "FINALIZED_CLOSE", "finalized": True, "rows": rows})
    return {"schema_version": 1, "core_score_version": "FINAL_CORE_WEIGHT_V1", "snapshots": snapshots}


class CutoverTests(unittest.TestCase):
    def setup_case(self, scores=None, *, enabled=True, sender=None):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        path = Path(temporary.name, "final.json")
        path.write_text(json.dumps(artifact(scores or {"00830": [39]})), encoding="utf-8")
        sent = []
        store = PushSubscriptionStore(temporary.name)
        service = PushService(store, config=CONFIG, sender=sender or (lambda **kwargs: sent.append(kwargs)))
        subscription_id = service.subscribe(SUBSCRIPTION, user_agent="iOS Safari")["subscription_id"]
        evaluator = BackgroundAlertEvaluator(service, finalized_path=path, enabled=enabled)
        return path, sent, store, subscription_id, evaluator

    def test_01_cutover_baselines_current_finalized(self):
        _, sent, store, sid, evaluator = self.setup_case()
        evaluator.sync_rules(sid, preferences())
        result = evaluator.evaluate_once()
        metadata = store.cutover_metadata()
        self.assertEqual(metadata["version"], CUTOVER_VERSION)
        self.assertEqual(metadata["baseline_finalized_date"], "2026-09-18")
        self.assertEqual((result["candidate_count"], sent), (0, []))

    def test_02_same_fingerprint_and_restart_are_idempotent(self):
        path, sent, store, sid, evaluator = self.setup_case()
        evaluator.sync_rules(sid, preferences())
        evaluator.evaluate_once()
        restarted = BackgroundAlertEvaluator(PushService(PushSubscriptionStore(store.root), config=CONFIG, sender=lambda **kwargs: sent.append(kwargs)), finalized_path=path, enabled=True)
        self.assertEqual(restarted.evaluate_once()["push_success_count"], 0)
        self.assertEqual(sent, [])

    def test_03_new_finalized_without_condition_sends_zero(self):
        path, sent, _, sid, evaluator = self.setup_case()
        quiet = preferences(rule(cross=False, score=False, distance=0))
        evaluator.sync_rules(sid, quiet)
        evaluator.evaluate_once()
        path.write_text(json.dumps(artifact({"00830": [39, 39]})), encoding="utf-8")
        result = evaluator.evaluate_once()
        self.assertEqual((result["candidate_count"], sent), (0, []))

    def test_04_new_cross_level_sends_one_bundle(self):
        path, sent, _, sid, evaluator = self.setup_case()
        evaluator.sync_rules(sid, preferences())
        evaluator.evaluate_once()
        path.write_text(json.dumps(artifact({"00830": [39, 40]})), encoding="utf-8")
        result = evaluator.evaluate_once()
        self.assertEqual((result["bundle_count"], result["push_success_count"], len(sent)), (1, 1, 1))

    def test_05_disabled_rule_sends_zero(self):
        path, sent, _, sid, evaluator = self.setup_case()
        evaluator.sync_rules(sid, preferences(rule(cross=False, score=False)))
        evaluator.evaluate_once()
        path.write_text(json.dumps(artifact({"00830": [39, 40]})), encoding="utf-8")
        self.assertEqual((evaluator.evaluate_once()["push_success_count"], sent), (0, []))

    def test_06_same_etf_multiple_rules_bundle_once(self):
        path, sent, _, sid, evaluator = self.setup_case()
        evaluator.sync_rules(sid, preferences())
        evaluator.evaluate_once()
        path.write_text(json.dumps(artifact({"00830": [39, 40]})), encoding="utf-8")
        result = evaluator.evaluate_once()
        self.assertEqual((result["candidate_count"] >= 2, result["bundle_count"], len(sent)), (True, 1, 1))

    def test_07_different_etfs_push_separately(self):
        path, sent, _, sid, evaluator = self.setup_case({"0050": [39], "00830": [39]})
        evaluator.sync_rules(sid, preferences())
        evaluator.evaluate_once()
        path.write_text(json.dumps(artifact({"0050": [39, 40], "00830": [39, 40]})), encoding="utf-8")
        result = evaluator.evaluate_once()
        self.assertEqual((result["bundle_count"], len(sent)), (2, 2))

    def test_08_feature_flag_off_rebaselines_without_push(self):
        path, sent, store, sid, evaluator = self.setup_case(enabled=False)
        evaluator.sync_rules(sid, preferences())
        evaluator.evaluate_once()
        path.write_text(json.dumps(artifact({"00830": [39, 40]})), encoding="utf-8")
        result = evaluator.evaluate_once()
        record = store.get(sid)
        self.assertEqual((result["status"], result["push_success_count"], sent), ("BACKGROUND_ALERT_DISABLED", 0, []))
        self.assertEqual(record["last_evaluated_finalized_fingerprint"], store.cutover_metadata()["last_evaluated_finalized_fingerprint"])

    def test_09_enabling_after_disabled_period_does_not_backfill(self):
        path, sent, store, sid, disabled = self.setup_case(enabled=False)
        disabled.sync_rules(sid, preferences())
        disabled.evaluate_once()
        path.write_text(json.dumps(artifact({"00830": [39, 40]})), encoding="utf-8")
        disabled.evaluate_once()
        enabled = BackgroundAlertEvaluator(PushService(store, config=CONFIG, sender=lambda **kwargs: sent.append(kwargs)), finalized_path=path, enabled=True)
        self.assertEqual((enabled.evaluate_once()["push_success_count"], sent), (0, []))

    def test_10_rule_update_baselines_current_and_requires_rearm(self):
        path, sent, _, sid, evaluator = self.setup_case()
        evaluator.sync_rules(sid, preferences(rule(cross=False, score=False, threshold=30)))
        evaluator.evaluate_once()
        evaluator.sync_rules(sid, preferences(rule(cross=False, score=True, threshold=30)))
        self.assertEqual(sent, [])
        path.write_text(json.dumps(artifact({"00830": [39, 40]})), encoding="utf-8")
        self.assertEqual(evaluator.evaluate_once()["push_success_count"], 0)
        path.write_text(json.dumps(artifact({"00830": [39, 40, 29]})), encoding="utf-8")
        self.assertEqual(evaluator.evaluate_once()["push_success_count"], 0)
        path.write_text(json.dumps(artifact({"00830": [39, 40, 29, 30]})), encoding="utf-8")
        self.assertEqual(evaluator.evaluate_once()["push_success_count"], 1)

    def test_11_etf_override_update_uses_same_baseline(self):
        path, sent, _, sid, evaluator = self.setup_case()
        custom = {"00830": {"mode": "custom", "rules": rule(cross=False, score=True, threshold=30)}}
        evaluator.sync_rules(sid, preferences(rule(cross=False, score=False), custom))
        evaluator.evaluate_once()
        self.assertEqual(sent, [])
        path.write_text(json.dumps(artifact({"00830": [39, 40]})), encoding="utf-8")
        self.assertEqual(evaluator.evaluate_once()["push_success_count"], 0)

    def test_12_production_payload_has_no_test_namespace(self):
        path, sent, _, sid, evaluator = self.setup_case()
        evaluator.sync_rules(sid, preferences())
        evaluator.evaluate_once()
        path.write_text(json.dumps(artifact({"00830": [39, 40]})), encoding="utf-8")
        evaluator.evaluate_once()
        payload = json.loads(sent[0]["data"])
        self.assertEqual(payload["type"], "ETF_ALERT_BUNDLE")
        self.assertNotIn("TEST", json.dumps(payload, ensure_ascii=False).upper())
        self.assertNotIn("測試", json.dumps(payload, ensure_ascii=False))
        self.assertNotIn("模擬", json.dumps(payload, ensure_ascii=False))

    def test_13_finalized_artifact_is_read_only(self):
        path, _, _, sid, evaluator = self.setup_case()
        evaluator.sync_rules(sid, preferences())
        before = path.read_bytes()
        evaluator.evaluate_once()
        self.assertEqual(path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
