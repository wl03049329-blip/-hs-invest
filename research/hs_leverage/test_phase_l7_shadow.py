"""Focused TEST_MODE checks for the L7 manual shadow engine."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import phase_l7_shadow as shadow


class ShadowEngineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.policy, cls.data = shadow.load_context()
        cls.rows = sorted(cls.data["item"]["rows"], key=lambda x: x["date"])
        cls.signal_index = next(i for i in range(5, len(cls.rows) - 61) if shadow.crash_velocity(cls.rows, i)[1] >= cls.policy["threshold"]["threshold_value"])
        cls.false_index = next(i for i in range(5, len(cls.rows) - 1) if shadow.crash_velocity(cls.rows, i)[1] < cls.policy["threshold"]["threshold_value"])

    def test_01_exact_crash_velocity(self):
        ret, velocity = shadow.crash_velocity(self.rows, self.signal_index)
        self.assertEqual(velocity, max(0.0, -ret) / 5)

    def test_02_2026_frozen_threshold_loading(self):
        self.assertEqual(self.policy["threshold"]["threshold_value"], 2.033335)
        self.assertEqual(self.policy["threshold"]["threshold_training_end"], "2025-12-31")

    def test_03_adjusted_ohlc_enforcement(self):
        bad = dict(self.rows[self.signal_index]); bad["low"] = None
        self.assertEqual(shadow.valid_bar(bad), "MISSING_ADJUSTED_OHLC")

    def test_04_signal_true_case(self):
        record = shadow.evaluate(self.rows, self.signal_index, self.policy, test_mode=True)
        self.assertTrue(record["signal_triggered"])
        self.assertEqual(record["state_after"], "SIGNAL_PENDING")

    def test_05_signal_false_case(self):
        record = shadow.evaluate(self.rows, self.false_index, self.policy, test_mode=True)
        self.assertFalse(record["signal_triggered"])
        self.assertEqual(record["state_after"], "IDLE")

    def test_06_fail_closed_missing_data(self):
        rows = list(self.rows); rows[self.signal_index] = dict(rows[self.signal_index], close=None)
        record = shadow.evaluate(rows, self.signal_index, self.policy, test_mode=True)
        self.assertEqual(record["state_after"], "FAIL_CLOSED")

    def test_07_duplicate_run_idempotency(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ledger.jsonl"; record = shadow.evaluate(self.rows, self.signal_index, self.policy, test_mode=True)
            self.assertEqual(shadow.append_record(path, record)["status"], "APPENDED")
            self.assertEqual(shadow.append_record(path, record)["status"], "NOOP_ALREADY_RECORDED")

    def test_08_append_only_hash_chain(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ledger.jsonl"; record = shadow.evaluate(self.rows, self.signal_index, self.policy, test_mode=True)
            shadow.append_record(path, record)
            self.assertEqual(shadow.validate_hash_chain(path)["status"], "PASS")

    def test_09_next_open_reference(self):
        record = shadow.evaluate(self.rows, self.signal_index + 1, self.policy, state_before="SIGNAL_PENDING", test_mode=True)
        self.assertEqual(record["shadow_entry_reference"], float(self.rows[self.signal_index + 1]["open"]))
        self.assertEqual(record["state_after"], "COOLDOWN_HOLDING")

    def test_10_outcome_not_available_before_maturity(self):
        entry = shadow.evaluate(self.rows, len(self.rows) - 1, self.policy, state_before="SIGNAL_PENDING", test_mode=True)
        self.assertEqual(shadow.mature_outcomes(entry, self.rows, len(self.rows) - 1, self.policy, test_mode=True), [])

    def test_11_outcome_after_maturity(self):
        entry = shadow.evaluate(self.rows, self.signal_index + 1, self.policy, state_before="SIGNAL_PENDING", test_mode=True)
        outcomes = shadow.mature_outcomes(entry, self.rows, self.signal_index + 1, self.policy, test_mode=True)
        self.assertEqual([x["horizon"] for x in outcomes], [5, 10, 20, 40, 60])

    def test_12_repeat_signal_no_pyramiding(self):
        record = shadow.evaluate(self.rows, self.signal_index, self.policy, state_before="COOLDOWN_HOLDING", test_mode=True)
        self.assertEqual(record["capital_allocation_pct"], 0)
        self.assertEqual(record["state_after"], "COOLDOWN_HOLDING")

    def test_13_hash_chain_tamper_detection(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ledger.jsonl"; record = shadow.evaluate(self.rows, self.signal_index, self.policy, test_mode=True)
            shadow.append_record(path, record)
            saved = json.loads(path.read_text(encoding="utf-8")); saved["signal_triggered"] = False
            path.write_text(json.dumps(saved) + "\n", encoding="utf-8")
            self.assertEqual(shadow.validate_hash_chain(path)["status"], "FAIL")


if __name__ == "__main__":
    unittest.main()
