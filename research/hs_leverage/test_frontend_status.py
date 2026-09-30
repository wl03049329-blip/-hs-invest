"""Contract tests for the read-only 00631L frontend snapshot."""
import copy
import hashlib
import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

import build_frontend_status as frontend
import phase_l7_daily as daily
import phase_l7_shadow as shadow


class FrontendStatusTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.files = (
            "research/hs_leverage/phase_l7_forward_policy.json",
            "research/hs_leverage/forward/daily-status.json",
            "research/hs_leverage/forward/00631L-adjusted-daily.json",
            "research/hs_leverage/forward/hs_leverage_c_v1_forward_ledger.jsonl",
            "research/hs_leverage/forward/hs_leverage_c_v1_outcomes.jsonl",
        )
        for relative in self.files:
            source = shadow.ROOT / relative
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read_bytes() if source.exists() else b"")
        # A mutable production failure report is not a successful-build fixture.
        # Construct a coherent success case only in this temporary test root;
        # the rejection test below independently verifies failed validation.
        policy = self.read("research/hs_leverage/phase_l7_forward_policy.json")
        price = self.read("research/hs_leverage/forward/00631L-adjusted-daily.json")
        records, realized = daily.validate_ledgers(self.root / policy["paths"]["forward_ledger"],
                                                   self.root / policy["paths"]["outcomes_ledger"], policy)
        self.latest = price["item"]["rows"][-1]["date"]
        self.write("research/hs_leverage/forward/daily-status.json", {
            "status": "NOOP_ALREADY_RECORDED", "data_integrity": "PASS", "dry_run": False,
            "latest_data_date": self.latest, "data_version": price["metadata"]["data_version"],
            "checked_at": price["metadata"]["generated_at"], **daily.summarize(records, realized)})

    def read(self, relative):
        return json.loads((self.root / relative).read_text(encoding="utf-8"))

    def write(self, relative, value):
        (self.root / relative).write_text(json.dumps(value), encoding="utf-8")

    def hashes(self):
        return {name: hashlib.sha256((self.root / name).read_bytes()).hexdigest() for name in self.files}

    def test_idempotent_read_only_snapshot_and_real_counts(self):
        before = self.hashes()
        first = frontend.build(self.root, self.latest)
        second = frontend.build(self.root, self.latest)
        self.assertEqual(first, second)
        self.assertEqual(self.hashes(), before)
        self.assertEqual(first["strategy_id"], "HS_LEVERAGE_C_V1")
        status = self.read("research/hs_leverage/forward/daily-status.json")
        self.assertEqual(first["shadow"]["observation_count"], status["forward_observations"])
        self.assertEqual(first["shadow"]["eligible_count"], status["eligible_observations"])
        self.assertEqual(first["workflow"]["last_successful_validation_at"], None)
        self.assertEqual(first["price"]["freshness"], "CURRENT")

    def test_stale_uses_expected_trading_day_not_calendar_subtraction(self):
        self.assertEqual(frontend.classify_freshness("2026-09-29", "2026-09-30"), "STALE")
        self.assertEqual(frontend.classify_freshness("2026-09-30", "2026-09-30"), "CURRENT")

    def test_weekend_holiday_and_taipei_midnight_expected_day(self):
        self.assertEqual(daily.expected_day(datetime.fromisoformat("2026-10-05T08:00:00+08:00"), set()), "2026-10-02")
        holidays = {"2026-09-25", "2026-09-28"}
        self.assertEqual(daily.expected_day(datetime.fromisoformat("2026-09-29T08:00:00+08:00"), holidays), "2026-09-24")
        self.assertEqual(daily.expected_day(datetime.fromisoformat("2026-09-30T16:06:00+00:00"), set()), "2026-09-30")

    def test_unknown_only_for_missing_or_invalid_dates(self):
        for latest, expected in ((None, "2026-09-30"), ("2026-09-29", None),
                                 ("bad-date", "2026-09-30"), ("2026-09-29", "bad-date")):
            self.assertEqual(frontend.classify_freshness(latest, expected), "UNKNOWN")
        self.assertEqual(frontend.build(self.root, None)["price"]["freshness"], "UNKNOWN")
        self.assertEqual(frontend.build(self.root, "bad-date")["price"]["freshness"], "UNKNOWN")

    def test_future_bar_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "FUTURE_PRICE_BAR"):
            frontend.build(self.root, "1900-01-01")

    def test_failed_validation_and_mismatch_fail_closed(self):
        path = "research/hs_leverage/forward/daily-status.json"
        original = self.read(path)
        failed = copy.deepcopy(original)
        failed["data_integrity"] = "FAIL"
        self.write(path, failed)
        with self.assertRaisesRegex(ValueError, "VALIDATION_NOT_SUCCESSFUL"):
            frontend.build(self.root, self.latest)
        mismatched = copy.deepcopy(original)
        mismatched["forward_observations"] += 1
        self.write(path, mismatched)
        with self.assertRaisesRegex(ValueError, "STATUS_LEDGER_MISMATCH"):
            frontend.build(self.root, self.latest)

    def test_missing_sources_do_not_become_zero(self):
        (self.root / "research/hs_leverage/forward/daily-status.json").unlink()
        with self.assertRaises(FileNotFoundError):
            frontend.build(self.root, self.latest)


if __name__ == "__main__":
    unittest.main()
