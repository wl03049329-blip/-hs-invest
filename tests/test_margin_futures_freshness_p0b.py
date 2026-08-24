import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


def load(name: str, path: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


MARGIN = load("margin_freshness_p0b", "scripts/update_margin_data.py")
FUTURES = load("futures_freshness_p0b", "scripts/update_futures_position.py")


class FreshnessTests(unittest.TestCase):
    def assert_both(self, expected, source, production, status):
        self.assertEqual(MARGIN.freshness_status(expected, source, production), status)
        self.assertEqual(FUTURES.freshness_status(expected, source, production), status)

    def test_case_a_new_source_updates(self):
        self.assert_both("2026-08-18", "2026-08-18", "2026-08-17", "UPDATED_SUCCESSFULLY")

    def test_case_b_source_not_ready_keeps_last_known_good(self):
        self.assert_both("2026-08-18", "2026-08-17", "2026-08-17", "SOURCE_NOT_READY")

    def test_case_c_retry_catches_up(self):
        self.assert_both("2026-08-18", "2026-08-17", "2026-08-17", "SOURCE_NOT_READY")
        self.assert_both("2026-08-18", "2026-08-18", "2026-08-17", "UPDATED_SUCCESSFULLY")

    def test_case_d_older_source_is_rejected(self):
        self.assert_both("2026-08-18", "2026-08-16", "2026-08-17", "STALE_DATA_DETECTED")

    def test_futures_same_or_older_source_never_rewrites_last_known_good(self):
        for source_date in ("2026-08-17", "2026-08-16"):
            with self.subTest(source_date=source_date), tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / "futures-position.json"
                payload = {"data_date": "2026-08-17", "sentinel": "last-known-good"}
                output.write_text(json.dumps(payload), encoding="utf-8")
                before = output.read_bytes()
                with mock.patch.object(FUTURES, "OUTPUT", output), \
                        mock.patch.object(
                            FUTURES, "resolve_official_candidate",
                            return_value=({"data_date": source_date}, FUTURES.SOURCE_NOT_READY, ["fixture"]),
                        ):
                    FUTURES.main()
                self.assertEqual(output.read_bytes(), before)

    def test_futures_workflow_has_low_cost_official_source_retries(self):
        workflow = (ROOT / ".github" / "workflows" / "update-futures-position.yml").read_text(encoding="utf-8")
        for cron in ('30 7 * * 1-5', '30 8 * * 1-5', '0 10 * * 1-5', '0 12 * * 1-5', '0 23 * * 0-4'):
            self.assertIn(f'cron: "{cron}"', workflow)
        self.assertIn("cancel-in-progress: false", workflow)


if __name__ == "__main__":
    unittest.main()
