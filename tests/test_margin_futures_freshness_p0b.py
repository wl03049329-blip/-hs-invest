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
                        mock.patch.object(FUTURES, "fetch_json", return_value=[]), \
                        mock.patch.object(
                            FUTURES,
                            "rows_by_date",
                            side_effect=[{source_date: []}, {source_date: []}],
                        ):
                    FUTURES.main()
                self.assertEqual(output.read_bytes(), before)

    def test_workflows_have_late_and_next_morning_retries(self):
        for name in ("update-margin-data.yml", "update-futures-position.yml"):
            workflow = (ROOT / ".github" / "workflows" / name).read_text(encoding="utf-8")
            self.assertIn('cron: "0 13 * * 1-5"', workflow)
            self.assertIn('cron: "30 23 * * 1-5"', workflow)


if __name__ == "__main__":
    unittest.main()
