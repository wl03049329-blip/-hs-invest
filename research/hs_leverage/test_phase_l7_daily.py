"""Deterministic isolated tests; never write official Forward observations."""
import copy
import json
import math
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import phase_l7_daily as daily
import phase_l7_shadow as shadow


def fixture_rows(count=80):
    rows, day = [], date(2026, 8, 17)
    while len(rows) < count:
        if day.weekday() < 5:
            i = len(rows)
            close = 100 if i < 5 else 86 + max(0, i - 6) * .1
            rows.append({"date": day.isoformat(), "open": close + .25, "high": close + 1,
                         "low": close - 1, "close": close, "volume": 100})
        day += timedelta(days=1)
    return rows


def at(day, clock="18:00:00"):
    return datetime.fromisoformat(day + "T" + clock + "+08:00")


def data_for(rows, now=None):
    now = now or at(rows[-1]["date"])
    return {"metadata": {"generated_at": now.isoformat(), "frequency": "1d", "ticker": "00631L",
                         "price_basis": "Adjusted OHLC", "corporate_action_status": "REVALIDATED",
                         "expected_completed_bar": rows[-1]["date"], "data_version": "fixture-v1",
                         "source_receipts_sha256": {}}, "item": {"rows": copy.deepcopy(rows)}}


def yahoo_for(rows):
    return {"chart": {"error": None, "result": [{"meta": {
        "symbol": "00631L.TW", "currency": "TWD", "instrumentType": "ETF",
        "dataGranularity": "1d", "exchangeTimezoneName": "Asia/Taipei"},
        "timestamp": [int(at(r["date"], "09:00:00").timestamp()) for r in rows],
        "indicators": {"quote": [{k: [r[k] for r in rows] for k in (*daily.FIELDS, "volume")}],
                       "adjclose": [{"adjclose": [r["close"] for r in rows]}]}}]}}


class DailyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.policy, cls.historical = shadow.load_context()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.rows = fixture_rows()
        self.ledger = self.root / self.policy["paths"]["forward_ledger"]
        self.outcomes = self.root / self.policy["paths"]["outcomes_ledger"]

    def tick(self, index, now=None, holidays=None):
        now = now or at(self.rows[index]["date"])
        return daily.update_ledgers(self.root, self.policy, data_for(self.rows[:index + 1], now), now, holidays or set())

    def test_same_day_idempotent_bytes(self):
        first = self.tick(5)
        saved = self.ledger.read_bytes()
        second = self.tick(5, at(self.rows[5]["date"], "21:00:00"))
        self.assertEqual(first["eligible_observations"], 1)
        self.assertEqual(second["status"], "NOOP_ALREADY_RECORDED")
        self.assertEqual(saved, self.ledger.read_bytes())

    def test_holiday_updates_no_historical_observation(self):
        result = self.tick(5, at("2026-08-25"), {"2026-08-25"})
        self.assertEqual(result["forward_observations"], 0)
        self.assertFalse(self.ledger.exists())

    def test_before_publication_rejects_current_bar(self):
        with self.assertRaisesRegex(daily.Error, "STALE_OR_INCOMPLETE"):
            self.tick(5, at("2026-08-24", "13:29:59"))

    def test_no_backfill_preopen_previous_bar(self):
        result = self.tick(5, at("2026-08-25", "10:00:00"))
        self.assertEqual(result["forward_observations"], 0)

    def test_stale_latest_is_rejected_even_fresh_fetch(self):
        with self.assertRaisesRegex(daily.Error, "STALE_OR_INCOMPLETE"):
            self.tick(5, at("2026-08-25"))

    def test_pending_then_exact_next_open_after_missed_run(self):
        self.tick(5)
        result = self.tick(8)
        entries = [r for r in shadow.read_jsonl(self.ledger) if r["record_type"] == "SHADOW_ENTRY"]
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["evaluation_date"], self.rows[6]["date"])
        self.assertEqual(entries[0]["shadow_entry_reference"], self.rows[6]["open"])
        self.assertEqual(result["forward_observations"], 2)
        self.assertEqual(result["pending_outcomes"], 3)

    def test_maturity_uses_trading_bars_not_calendar_days(self):
        self.tick(5)
        self.tick(6)
        before = self.tick(25)
        self.assertEqual(before["completed_outcomes"], 0)
        result = self.tick(26)
        self.assertEqual(result["completed_outcomes"], 1)
        self.assertEqual(result["pending_outcomes"], 2)
        outcome = next(r for r in shadow.read_jsonl(self.outcomes) if r["horizon"] == 20)
        self.assertEqual(outcome["end_date"], self.rows[26]["date"])
        self.assertAlmostEqual(outcome["forward_return"], (self.rows[26]["close"] / self.rows[6]["open"] - 1) * 100)
        self.assertAlmostEqual(outcome["mae"], (min(r["low"] for r in self.rows[6:27]) / self.rows[6]["open"] - 1) * 100)

    def test_all_maturities_idempotent_no_automatic_horizon_selection(self):
        self.tick(5)
        result = self.tick(66)
        before = self.outcomes.read_bytes()
        self.tick(66)
        self.assertEqual(before, self.outcomes.read_bytes())
        self.assertEqual(result["completed_outcomes"], 3)
        self.assertEqual(result["all_horizons_completed_outcomes"], 5)
        self.assertEqual(result["pending_outcomes"], 0)
        self.assertEqual(shadow.latest_state(shadow.read_jsonl(self.ledger)), "COOLDOWN_HOLDING")

    def test_repeat_does_not_add_entry_or_restart_clock(self):
        self.tick(5)
        self.tick(6)
        result = self.tick(7)
        self.assertEqual(result["forward_samples"], 1)
        self.assertEqual(result["eligible_observations"], 1)
        self.assertGreater(result["repeat_signal_count"], 0)
        self.assertFalse(result["live_capital"])

    def test_no_trigger_day(self):
        for row in self.rows:
            row.update(open=100, high=101, low=99, close=100)
        result = self.tick(5)
        self.assertEqual(result["forward_observations"], 1)
        self.assertEqual(result["eligible_observations"], 0)

    def test_hash_tamper_rejected_on_duplicate_run(self):
        self.tick(5)
        self.ledger.write_text(self.ledger.read_text().replace('"capital_allocation_pct":0', '"capital_allocation_pct":1'))
        with self.assertRaisesRegex(daily.Error, "HASH_CHAIN"):
            self.tick(5)

    def test_duplicate_dates_even_different_record_ids_rejected(self):
        self.tick(5)
        duplicate = shadow.read_jsonl(self.ledger)[0]
        duplicate["record_id"] = "OTHER_ID"
        shadow.append_record(self.ledger, duplicate)
        with self.assertRaisesRegex(daily.Error, "DUPLICATE_OR_NONCHRONOLOGICAL"):
            self.tick(5)

    def test_test_mode_ledger_rejected(self):
        record = shadow.evaluate(self.rows, 5, self.policy, test_mode=True)
        shadow.append_record(self.ledger, record)
        with self.assertRaisesRegex(daily.Error, "NON_SHADOW"):
            self.tick(5)

    def test_backdated_record_rejected(self):
        record = shadow.evaluate(self.rows, 5, self.policy)
        record["calculated_at"] = at("2026-09-01").isoformat()
        shadow.append_record(self.ledger, record)
        with self.assertRaisesRegex(daily.Error, "BACKFILL"):
            self.tick(5)

    def test_expired_threshold(self):
        policy = copy.deepcopy(self.policy)
        policy["threshold"]["threshold_effective_to"] = "2026-08-23"
        with self.assertRaisesRegex(daily.Error, "THRESHOLD_EXPIRED"):
            daily.update_ledgers(self.root, policy, data_for(self.rows[:6]), at("2026-08-24"), set())

    def test_nonfinite_and_duplicate_bar(self):
        for value in (math.nan, math.inf, -math.inf, None):
            rows = copy.deepcopy(self.rows[:6])
            rows[-1]["close"] = value
            with self.assertRaises((daily.Error, TypeError)):
                daily.validate_rows(rows)
        with self.assertRaises(daily.Error):
            daily.validate_rows(self.rows[:6] + self.rows[5:6])

    def test_stale_or_future_source_timestamp(self):
        for timestamp in ("2026-08-17T18:00:00+08:00", "2026-08-25T18:00:00+08:00"):
            data = data_for(self.rows[:6])
            data["metadata"]["generated_at"] = timestamp
            with self.assertRaisesRegex(daily.Error, "STALE_SOURCE_TIMESTAMP"):
                daily.update_ledgers(self.root, self.policy, data, at("2026-08-24"), set())

    def test_entry_basis_revision_rejected(self):
        self.tick(5)
        self.tick(6)
        self.rows[6]["open"] += .5
        with self.assertRaisesRegex(daily.Error, "ENTRY_BASIS_REVISION"):
            self.tick(7)

    def test_fail_closed_state_requires_review(self):
        record = shadow.evaluate(self.rows, 5, self.policy)
        record.update(calculated_at=at("2026-08-24").isoformat(), state_after="FAIL_CLOSED")
        shadow.append_record(self.ledger, record)
        with self.assertRaisesRegex(daily.Error, "RECOVERY_REQUIRED"):
            self.tick(6)

    def test_yahoo_daily_complete_and_adjust_all_ohlc(self):
        rows = self.rows[:6]
        history = data_for(rows)
        yahoo = yahoo_for(rows)
        result = daily.parse_yahoo(yahoo, history, rows[-1]["date"])
        self.assertEqual([r["close"] for r in result], [r["close"] for r in rows])
        yahoo["chart"]["result"][0]["indicators"]["adjclose"][0]["adjclose"][-1] *= .5
        with self.assertRaisesRegex(daily.Error, "HISTORICAL_REVISION"):
            daily.parse_yahoo(yahoo, history, rows[-1]["date"])

    def test_yahoo_monthly_symbol_or_adjustment_missing(self):
        history = data_for(self.rows[:6])
        for key, value in (("dataGranularity", "1mo"), ("symbol", "0050.TW"), ("exchangeTimezoneName", "UTC")):
            yahoo = yahoo_for(self.rows[:6])
            yahoo["chart"]["result"][0]["meta"][key] = value
            with self.assertRaises(daily.Error):
                daily.parse_yahoo(yahoo, history, "2026-08-24")
        yahoo = yahoo_for(self.rows[:6])
        yahoo["chart"]["result"][0]["indicators"]["adjclose"][0]["adjclose"][-1] = None
        with self.assertRaisesRegex(daily.Error, "MISSING_ADJUSTED"):
            daily.parse_yahoo(yahoo, history, "2026-08-24")

    def test_new_corporate_action_rejected(self):
        yahoo = yahoo_for(self.rows[:6])
        yahoo["chart"]["result"][0]["events"] = {"splits": {"x": {"date": int(at("2026-08-24").timestamp()), "numerator": 2, "denominator": 1}}}
        with self.assertRaisesRegex(daily.Error, "CORPORATE_ACTION"):
            daily.parse_yahoo(yahoo, data_for(self.rows[:6]), "2026-08-24")

    def test_yahoo_zero_volume_cannot_replace_a_real_session(self):
        yahoo = yahoo_for(self.rows[:6])
        yahoo["chart"]["result"][0]["indicators"]["quote"][0]["volume"][-1] = 0
        with self.assertRaisesRegex(daily.Error, "STALE"):
            daily.parse_yahoo(yahoo, data_for(self.rows[:6]), "2026-08-24")

    def test_future_provider_bar_filtered(self):
        result = daily.parse_yahoo(yahoo_for(self.rows[:7]), data_for(self.rows[:6]), "2026-08-24")
        self.assertEqual(result[-1]["date"], "2026-08-24")

    def test_calendar_year_coverage_and_holiday(self):
        holidays = [{"Date": f"2026{m:02d}01", "Name": "休市", "Description": ""} for m in range(1, 13)]
        holidays += [{"Date": "1150925", "Name": "中秋節", "Description": "依規定放假1日。"},
                     {"Date": "1150928", "Name": "教師節", "Description": "依規定放假1日。"}]
        closed = daily.calendar_days(holidays, 2026)
        self.assertEqual(daily.expected_day(at("2026-09-28"), closed), "2026-09-24")
        with self.assertRaisesRegex(daily.Error, "YEAR_UNCOVERED"):
            daily.calendar_days(holidays, 2027)
        with self.assertRaises(daily.Error):
            daily.calendar_days([], 2026)

    def test_collect_cross_source_conflict_and_missing_session(self):
        rows = self.rows[:7]
        dates = ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09", "2026-01-12"]
        rows = [dict(r, date=day) for r, day in zip(rows, dates)]
        historical = data_for(rows[:6])
        yahoo = yahoo_for(rows)
        calendar = [{"Date": f"2026{m:02d}01", "Name": "休市", "Description": ""} for m in range(1, 13)]
        official = {"stat": "OK", "date": "20260101", "title": "00631L 各日成交資訊",
                    "fields": ["日期", "成交股數", "開盤價", "最高價", "最低價", "收盤價"],
                    "data": [[r["date"], "100", *[str(r[k] * 22) for k in daily.FIELDS]] for r in rows]}
        def fetch(url):
            if url == daily.CALENDAR_URL:
                return calendar
            return yahoo if "yahoo" in url else official
        data, _ = daily.collect(historical, None, self.policy, at("2026-01-12"), fetch)
        self.assertEqual(data["item"]["rows"][-1]["date"], "2026-01-12")
        official["data"][-1][-1] = str(rows[-1]["close"] * 22 + 1)
        with self.assertRaisesRegex(daily.Error, "OHLC_CONFLICT"):
            daily.collect(historical, None, self.policy, at("2026-01-12"), fetch)
        official["data"].pop()
        with self.assertRaisesRegex(daily.Error, "CONTINUITY_FAIL"):
            daily.collect(historical, None, self.policy, at("2026-01-12"), fetch)

    def test_official_schema_symbol_and_month(self):
        payload = {"stat": "OK", "date": "20260801", "title": "00631L 各日成交資訊",
                   "fields": ["日期", "成交股數", "開盤價", "最高價", "最低價", "收盤價"],
                   "data": [["115/08/24", "100", "86.25", "87", "85", "86"]]}
        self.assertEqual(daily.parse_official(payload, "202608")[0]["close"], 86)
        for key, value in (("title", "0050"), ("date", "20260701"), ("stat", "ERROR"), ("fields", [])):
            bad = copy.deepcopy(payload)
            bad[key] = value
            with self.assertRaises(daily.Error):
                daily.parse_official(bad, "202608")

    def test_run_dry_run_never_writes(self):
        now = at("2026-08-24")
        with patch.object(shadow, "load_context", return_value=(self.policy, self.historical)), patch.object(daily, "collect", return_value=(data_for(self.rows[:6], now), set())):
            result = daily.run(self.root, now=now, dry_run=True)
        self.assertEqual(result["status"], "APPENDED")
        self.assertEqual(list(self.root.rglob("*")), [])

    def test_failure_leaves_official_ledgers_and_data_unchanged(self):
        now = at("2026-08-24")
        with patch.object(shadow, "load_context", return_value=(self.policy, self.historical)), patch.object(daily, "collect", return_value=(data_for(self.rows[:6], now), set())):
            daily.run(self.root, now=now)
        before = {p: p.read_bytes() for p in (self.ledger, self.outcomes, self.root / daily.SNAPSHOT)}
        with patch.object(shadow, "load_context", return_value=(self.policy, self.historical)), patch.object(daily, "collect", side_effect=daily.Error("CORPORATE_ACTION_REVIEW_REQUIRED")):
            result = daily.run(self.root, now=at("2026-08-25"))
        self.assertEqual(result["status"], "FAIL_CLOSED")
        self.assertEqual(before, {p: p.read_bytes() for p in before})
        self.assertEqual(shadow.validate_hash_chain(self.root / daily.INCIDENTS)["status"], "PASS")

    def test_strategy_and_research_artifacts_unchanged(self):
        self.assertEqual(self.policy["threshold"]["threshold_value"], 2.033335)
        for path, expected in self.policy["protected_hashes"].items():
            self.assertEqual(shadow.sha(shadow.ROOT / path), expected)

    def test_integrity_incident_cannot_silently_reenable(self):
        with patch.object(shadow, "load_context", return_value=(self.policy, self.historical)), patch.object(daily, "collect", side_effect=daily.Error("CORPORATE_ACTION_REVIEW_REQUIRED")):
            daily.run(self.root, now=at("2026-08-24"))
        with patch.object(shadow, "load_context", return_value=(self.policy, self.historical)), patch.object(daily, "collect", return_value=(data_for(self.rows[:7]), set())) as collect:
            result = daily.run(self.root, now=at("2026-08-25"))
        collect.assert_called_once()  # A read-only probe is required even with a latch.
        self.assertEqual(result["workflow_classification"], "RECOVERY_EVIDENCE_AVAILABLE")
        self.assertTrue(result["requires_integrity_review"])
        self.assertEqual(len(shadow.read_jsonl(self.root / daily.INCIDENTS)), 2)
        self.assertFalse(self.ledger.exists())

    def test_transient_transport_failure_retries_without_fake_evaluation(self):
        with patch.object(shadow, "load_context", return_value=(self.policy, self.historical)), patch.object(daily, "collect", side_effect=OSError("source transport unavailable")):
            result = daily.run(self.root, now=at("2026-08-24"))
        self.assertFalse(result["requires_integrity_review"])
        now = at("2026-08-25")
        with patch.object(shadow, "load_context", return_value=(self.policy, self.historical)), patch.object(daily, "collect", return_value=(data_for(self.rows[:7], now), set())):
            result = daily.run(self.root, now=now)
        self.assertEqual(result["forward_observations"], 1)
        self.assertEqual(shadow.read_jsonl(self.ledger)[-1]["evaluation_date"], "2026-08-25")


if __name__ == "__main__":
    unittest.main()
