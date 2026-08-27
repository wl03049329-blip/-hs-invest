"""Focused, non-mutating checks for HS_LEVERAGE_C_V1 recovery provenance."""
from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
import unittest
from pathlib import Path

import phase_l7_shadow as shadow


ROOT = shadow.ROOT
BASE = ROOT / "research/hs_leverage"
POLICY_PATH = BASE / "phase_l7_forward_policy.json"
class ProvenanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.policy_bytes = POLICY_PATH.read_bytes()
        cls.policy = json.loads(cls.policy_bytes)
        # Tests intentionally use an isolated deterministic fixture: the live
        # append-only Forward ledger is mutable operational state, not a test
        # dependency or part of the frozen release bundle.
        cls.ledger_tmp = tempfile.TemporaryDirectory()
        cls.ledger_path = Path(cls.ledger_tmp.name) / "ledger.jsonl"
        first = {"record_type": "TEST_INITIALIZATION", "record_id": "TEST_INIT", "strategy_id": cls.policy["strategy_id"]}
        first["previous_record_hash"] = None
        first["record_hash"] = shadow.payload_hash(first, None)
        second = {"record_type": "TEST_EVALUATION", "record_id": "TEST_EVAL:2026-08-24", "evaluation_date": "2026-08-24", "strategy_id": cls.policy["strategy_id"]}
        second["previous_record_hash"] = first["record_hash"]
        second["record_hash"] = shadow.payload_hash(second, first["record_hash"])
        cls.ledger_path.write_text("\n".join(shadow.canonical(record) for record in (first, second)) + "\n", encoding="utf-8")
        cls.ledger_bytes = cls.ledger_path.read_bytes()
        cls.ledger_state = shadow.validate_hash_chain(cls.ledger_path)

    @classmethod
    def tearDownClass(cls):
        cls.ledger_tmp.cleanup()

    def test_01_provenance_index_has_no_hash_authority(self):
        index = json.loads((BASE / "frozen-v1/provenance.json").read_text(encoding="utf-8"))
        self.assertEqual(index["purpose"], "RECOVERY_ONLY")
        self.assertEqual(index["policyManifest"], "../phase_l7_forward_policy.json")
        self.assertFalse("hash" in json.dumps(index).lower())

    def test_02_mirrors_and_working_files_match_policy(self):
        self.assertTrue(shadow.validate_provenance(self.policy))
        for relative, mirror_relative in shadow.PROVENANCE_SCOPE:
            expected = self.policy["protected_hashes"][relative]
            self.assertEqual(shadow.sha(ROOT / relative), expected)
            self.assertEqual(shadow.sha(ROOT / shadow.PROVENANCE_DIR / mirror_relative), expected)

    def test_03_working_bytes_equal_mirrors(self):
        for relative, mirror_relative in shadow.PROVENANCE_SCOPE:
            self.assertEqual((ROOT / relative).read_bytes(), (ROOT / shadow.PROVENANCE_DIR / mirror_relative).read_bytes())

    def test_04_mutated_mirror_fails_closed(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            relative, mirror_relative = shadow.PROVENANCE_SCOPE[0]
            working = root / relative; mirror = root / shadow.PROVENANCE_DIR / mirror_relative
            working.parent.mkdir(parents=True); mirror.parent.mkdir(parents=True)
            working.write_bytes((ROOT / relative).read_bytes()); mirror.write_bytes(b"tampered")
            with self.assertRaisesRegex(shadow.IntegrityError, "PROVENANCE_ARTIFACT_HASH_MISMATCH"):
                shadow.validate_provenance(self.policy, root)

    def test_05_mutated_working_file_fails_closed(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            relative, mirror_relative = shadow.PROVENANCE_SCOPE[0]
            working = root / relative; mirror = root / shadow.PROVENANCE_DIR / mirror_relative
            working.parent.mkdir(parents=True); mirror.parent.mkdir(parents=True)
            working.write_bytes(b"tampered"); mirror.write_bytes((ROOT / shadow.PROVENANCE_DIR / mirror_relative).read_bytes())
            with self.assertRaisesRegex(shadow.IntegrityError, "WORKING_PROVENANCE_BYTE_MISMATCH"):
                shadow.validate_provenance(self.policy, root)

    def test_06_policy_provenance_disagreement_fails_closed(self):
        altered = json.loads(json.dumps(self.policy))
        altered["protected_hashes"][shadow.PROVENANCE_SCOPE[0][0]] = "0" * 64
        with self.assertRaisesRegex(shadow.IntegrityError, "PROVENANCE_ARTIFACT_HASH_MISMATCH"):
            shadow.validate_provenance(altered)

    def test_07_exact_restore_into_temp_root(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            for relative, mirror_relative in shadow.PROVENANCE_SCOPE:
                target = root / relative; source = ROOT / shadow.PROVENANCE_DIR / mirror_relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
                self.assertEqual(shadow.sha(target), self.policy["protected_hashes"][relative])

    def test_08_ledger_is_unchanged_and_valid(self):
        self.assertEqual(self.ledger_path.read_bytes(), self.ledger_bytes)
        self.assertEqual(shadow.validate_hash_chain(self.ledger_path), self.ledger_state)
        self.assertEqual(self.ledger_state["record_count"], 2)
        self.assertFalse(any("2026-08-27" in json.dumps(record) for record in shadow.read_jsonl(self.ledger_path)))

    def test_09_frozen_contract_unchanged(self):
        spec = json.loads((BASE / "phase_l6_spec.json").read_text(encoding="utf-8"))
        self.assertEqual(spec["specification"]["strategy_id"], "HS_LEVERAGE_C_V1")
        self.assertEqual(spec["signal_identity"]["formula"]["crash_velocity_5d"], "max(0, -ret_5d) / 5")
        self.assertEqual(self.policy["threshold"]["threshold_value"], 2.033335)
        self.assertEqual(self.policy["threshold"]["threshold_training_end"], "2025-12-31")
        self.assertEqual(spec["execution_policy"]["planned_entry_reference"], "NEXT_OPEN")
        self.assertFalse(spec["overlap_policy"]["pyramiding_allowed"])
        self.assertFalse(self.policy["historical_shadow_backfill"])
        self.assertFalse(self.policy["live_capital"])

    def test_10_policy_manifest_unchanged(self):
        self.assertEqual(POLICY_PATH.read_bytes(), self.policy_bytes)
        self.assertEqual(hashlib.sha256(POLICY_PATH.read_bytes()).hexdigest(), hashlib.sha256(self.policy_bytes).hexdigest())


if __name__ == "__main__":
    unittest.main()
