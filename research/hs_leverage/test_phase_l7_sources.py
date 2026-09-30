"""Latest-session fallback contract; all prices/events are isolated fixtures."""
import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import phase_l7_daily as daily
import phase_l7_shadow as shadow
from test_phase_l7_daily import at, data_for, yahoo_for


class SourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.policy, _ = shadow.load_context()

    def setUp(self):
        dates = [f"2026-{m:02d}-02" for m in range(1, 9)]
        dates += ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-29", "2026-09-30"]
        self.rows = [{"date": day, "open": 40, "high": 41, "low": 39, "close": 40,
                      "volume": 100, "adjustment_factor": 1} for day in dates]
        self.historical = data_for(self.rows[:-2])
        self.prior = data_for(self.rows[:-1])
        self.yahoo = yahoo_for(self.rows)
        self.actions = {k: {"status": 200, "msg": "success", "data": []}
                        for k in ("TaiwanStockDividendResult", "TaiwanStockSplitPrice")}
        self.official = {}
        for month in daily.months_between("2026-01-01", "2026-09-30"):
            rows = [r for r in self.rows if r["date"].replace("-", "")[:6] == month]
            self.official[month] = {"stat": "OK", "date": month + "01", "title": "00631L 各日成交資訊",
                "fields": ["日期", "成交股數", "開盤價", "最高價", "最低價", "收盤價"],
                "data": [[r["date"], "100", *[str(r[k] * (22 if r["date"] < "2026-03-31" else 1))
                          for k in daily.FIELDS]] for r in rows]}
        self.now = at("2026-10-01", "01:00:00")

    def fetch(self, url):
        if url == daily.CALENDAR_URL:
            return [{"Date": f"2026{m:02d}01", "Name": "休市", "Description": ""} for m in range(1, 13)]
        if "yahoo" in url:
            return copy.deepcopy(self.yahoo)
        if "dataset=" in url:
            return copy.deepcopy(next(v for k, v in self.actions.items() if k in url))
        return copy.deepcopy(self.official[url.split("date=")[1][:6]])

    def collect(self, prior=None):
        return daily.collect(self.historical, prior or self.prior, self.policy, self.now, self.fetch)[0]

    def null_latest(self):
        self.yahoo["chart"]["result"][0]["indicators"]["quote"][0]["close"][-1] = None
        self.yahoo["chart"]["result"][0]["indicators"]["adjclose"][0]["adjclose"][-1] = None

    def test_a_primary_complete_no_fallback(self):
        result = self.collect()
        self.assertTrue(all(r["source_provenance"]["effective_source"] == "YAHOO" for r in result["item"]["rows"]))
        self.assertNotIn("TaiwanStockSplitPrice", result["metadata"]["source_receipts_sha256"])

    def test_b_missing_latest_official_factor_one(self):
        result = self.yahoo["chart"]["result"][0]
        result["timestamp"].pop()
        for values in result["indicators"]["quote"][0].values():
            values.pop()
        result["indicators"]["adjclose"][0]["adjclose"].pop()
        row = self.collect()["item"]["rows"][-1]
        self.assertEqual(row["source_provenance"]["primary_source_status"], "MISSING")
        self.assertEqual(row["date"], "2026-09-30")
        self.assertEqual(row["close"], 40)
        self.assertEqual(row["adjustment_factor"], 1)

    def test_c_null_latest_official_provenance(self):
        self.null_latest()
        data = self.collect()
        row = data["item"]["rows"][-1]
        self.assertEqual(row["source_provenance"]["effective_source"], "TWSE_FALLBACK")
        self.assertEqual(row["source_provenance"]["primary_source_status"], "NULL")
        self.assertEqual(set(k for k in data["metadata"]["source_receipts_sha256"] if k.startswith("Taiwan")), set(self.actions))

    def test_d_nonunit_adjustment_and_event_fail_closed(self):
        self.null_latest()
        self.prior["item"]["rows"][-1]["adjustment_factor"] = .5
        with self.assertRaisesRegex(daily.Error, "ADJUSTMENT_FACTOR_UNPROVEN"):
            self.collect()
        self.prior["item"]["rows"][-1]["adjustment_factor"] = 1
        self.actions["TaiwanStockSplitPrice"]["data"] = [{"date": "2026-09-30", "stock_id": "00631L"}]
        with self.assertRaisesRegex(daily.Error, "CORPORATE_ACTION_REVIEW_REQUIRED"):
            self.collect()

    def test_e_g_official_missing_or_wrong_trading_day(self):
        self.null_latest()
        self.official["202609"]["data"].pop()
        with self.assertRaisesRegex(daily.Error, "LATEST_OFFICIAL_BAR_UNAVAILABLE"):
            self.collect()

    def test_f_malformed_ohlc_or_volume(self):
        self.null_latest()
        row = self.official["202609"]["data"][-1]
        row[-2] = "42"  # low above open/close/high
        with self.assertRaises(daily.Error):
            self.collect()
        row[-2] = "39"
        row[1] = "0"
        with self.assertRaisesRegex(daily.Error, "INVALID_OFFICIAL_VOLUME"):
            self.collect()

    def test_h_i_no_backfill_and_rerun_no_ledger_write(self):
        self.null_latest()
        data = self.collect()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ledger = root / self.policy["paths"]["forward_ledger"]
            record = shadow.evaluate(self.rows, len(self.rows) - 2, self.policy)
            record["calculated_at"] = at("2026-09-29").isoformat()
            shadow.append_record(ledger, record)
            before = ledger.read_bytes()
            for _ in range(2):
                result = daily.update_ledgers(root, self.policy, data, self.now, set())
                self.assertEqual(result["status"], "NO_CURRENT_COMPLETED_SESSION_NO_BACKFILL")
                self.assertEqual(result["forward_observations"], 1)
                self.assertEqual(ledger.read_bytes(), before)
            self.assertFalse((root / self.policy["paths"]["outcomes_ledger"]).exists())
        second = self.collect(prior=data)
        self.assertEqual(data["item"]["rows"], second["item"]["rows"])
        self.assertEqual(data["metadata"]["data_version"], second["metadata"]["data_version"])

    def test_j_recovered_yahoo_reconciliation(self):
        self.null_latest()
        data = self.collect()
        self.yahoo = yahoo_for(self.rows)
        row = self.collect(prior=data)["item"]["rows"][-1]
        self.assertEqual(row["source_provenance"]["reconciliation_status"], "MATCHED_FACTOR_ONE")
        self.assertTrue(row["source_provenance"]["previous_source"]["fallback_used"])
        reconciled = self.collect(prior=data)
        again = self.collect(prior=reconciled)
        self.assertEqual(again["item"]["rows"][-1]["source_provenance"]["previous_source"],
                         row["source_provenance"]["previous_source"])

    def test_k_recovery_mismatch_incident_review_preserves_data(self):
        self.null_latest()
        data = self.collect()
        self.yahoo = yahoo_for(self.rows)
        self.yahoo["chart"]["result"][0]["indicators"]["quote"][0]["close"][-1] = 40.5
        self.yahoo["chart"]["result"][0]["indicators"]["adjclose"][0]["adjclose"][-1] = 40.5
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            daily.atomic_json(root / daily.SNAPSHOT, data)
            before = (root / daily.SNAPSHOT).read_bytes()
            with patch.object(shadow, "load_context", return_value=(self.policy, self.historical)):
                result = daily.run(root, now=self.now, fetcher=self.fetch)
            self.assertEqual(result["status"], "FAIL_CLOSED")
            self.assertTrue(result["requires_integrity_review"])
            self.assertEqual(before, (root / daily.SNAPSHOT).read_bytes())
            self.assertEqual(len(shadow.read_jsonl(root / daily.INCIDENTS)), 1)

    def test_unknown_actions_not_negative_proof(self):
        self.null_latest()
        self.actions["TaiwanStockDividendResult"]["status"] = 400
        with self.assertRaisesRegex(daily.Error, "CORPORATE_ACTION_SOURCE_UNAVAILABLE"):
            self.collect()

    def test_historical_hole_not_filled(self):
        self.null_latest()
        result = self.yahoo["chart"]["result"][0]
        result["indicators"]["quote"][0]["close"][-2] = None
        with self.assertRaisesRegex(daily.Error, "MISSING_SOURCE_OHLC:2026-09-29"):
            self.collect()

    def test_current_anchor_missing_fail_closed(self):
        self.null_latest()
        result = self.yahoo["chart"]["result"][0]
        del result["timestamp"][-2]
        for values in result["indicators"]["quote"][0].values():
            del values[-2]
        del result["indicators"]["adjclose"][0]["adjclose"][-2]
        with self.assertRaisesRegex(daily.Error, "FALLBACK_CURRENT_SOURCE_EVIDENCE_MISSING"):
            self.collect()

    def test_existing_primary_field_conflict_rejected(self):
        self.null_latest()
        self.yahoo["chart"]["result"][0]["indicators"]["quote"][0]["open"][-1] = 40.5
        with self.assertRaisesRegex(daily.Error, "OFFICIAL_OHLC_CONFLICT"):
            self.collect()

    def test_latest_invalid_not_treated_as_null(self):
        self.null_latest()
        self.yahoo["chart"]["result"][0]["indicators"]["quote"][0]["open"][-1] = -1
        with self.assertRaisesRegex(daily.Error, "INVALID_PRIMARY_FALLBACK_VALUE"):
            self.collect()

    def test_fallback_discontinuous_return_rejected(self):
        self.null_latest()
        self.yahoo["chart"]["result"][0]["indicators"]["quote"][0]["open"][-1] = None
        self.yahoo["chart"]["result"][0]["indicators"]["quote"][0]["high"][-1] = None
        self.yahoo["chart"]["result"][0]["indicators"]["quote"][0]["low"][-1] = None
        self.official["202609"]["data"][-1][2:] = ["80", "81", "79", "80"]
        with self.assertRaisesRegex(daily.Error, "PRICE_DISCONTINUITY_REVIEW_REQUIRED"):
            self.collect()


if __name__ == "__main__":
    unittest.main()
