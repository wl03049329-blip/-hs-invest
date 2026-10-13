"""Deterministic rejection tests; synthetic records never become public data."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import scripts.collect_radar_twse as collector
from scripts.collect_radar_twse import FIELDS, parse_month, overlap, number, months


class RadarTwseTests(unittest.TestCase):
    def setUp(self):
        self.payload = dict(stat="OK", date="20260901", title="115年09月 0050 元大台灣50", fields=FIELDS, total=1, data=[["115/09/18", "100,000", "1,000,000", "10", "11", "9", "10.5", "+0.5", "20", ""]])

    def test_raw_ohlc_and_share_units(self):
        r = parse_month(self.payload, "0050", "202609", "2026-09-18")[0]
        self.assertEqual([r[k] for k in ("open", "max", "min", "close", "Trading_Volume")], [10, 11, 9, 10.5, 100000])

    def test_wrong_month_symbol_schema_rejected(self):
        for key, value in (("date", "20261001"), ("title", "00662"), ("fields", []), ("total", 2), ("stat", "quota")):
            p = {**self.payload, key: value}
            with self.assertRaises(ValueError): parse_month(p, "0050", "202609", "2026-09-18")

    def test_missing_price_no_zero_or_fill(self):
        for v in (None, "--", "NaN", "Infinity", "0", "-1"):
            p = copy.deepcopy(self.payload); p["data"][0][6] = v
            with self.assertRaises(ValueError): parse_month(p, "0050", "202609", "2026-09-18")

    def test_bad_volume(self):
        for v in (None, "--", "0", "1.1"):
            with self.assertRaises(ValueError): number(v, True)

    def test_split_annotation_stops_promotion(self):
        p = copy.deepcopy(self.payload); p["data"][0][9] = "**"
        with self.assertRaisesRegex(ValueError, "UNREVIEWED_SPLIT"): parse_month(p, "0050", "202609", "2026-09-18")

    def test_duplicate_date_bounds_and_cutoff(self):
        p = copy.deepcopy(self.payload); p["data"] *= 2; p["total"] = 2
        with self.assertRaises(ValueError): parse_month(p, "0050", "202609", "2026-09-18")
        with self.assertRaisesRegex(ValueError, "EMPTY_MONTH"): parse_month(self.payload, "0050", "202609", "2026-09-17")
        p = copy.deepcopy(self.payload); p["data"][0][5] = "12"
        with self.assertRaisesRegex(ValueError, "OHLC_BOUNDS"): parse_month(p, "0050", "202609", "2026-09-18")

    def test_overlap_no_overwrite_volume_provenance(self):
        rows = parse_month(self.payload, "0050", "202609", "2026-09-18")
        seed = {"price": copy.deepcopy(rows)}; seed["price"][0]["Trading_Volume"] = 99999
        before = copy.deepcopy(seed)
        result = overlap(seed, rows)
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["volume_differences"][0]["twse_volume"], 100000)
        self.assertEqual(seed, before)
        rows[0]["close"] = 10.6
        with self.assertRaisesRegex(ValueError, "PRICE_CONFLICT"): overlap(seed, rows)
        with self.assertRaisesRegex(ValueError, "OVERLAP_ANCHOR_MISSING"): overlap(seed, [])

    def test_months_bounded(self):
        self.assertEqual(list(months("2025-12-01", "2026-02-13")), ["202512", "202601", "202602"])

    def test_closed_month_reuses_verified_evidence_without_network(self):
        # Cache behavior must be reproducible without packaging the private audit
        # directory. These synthetic rows stay in a disposable test directory.
        payload=copy.deepcopy(self.payload)
        payload.update(date="20181201",title="107年12月 00757 TEST_ONLY")
        payload["data"][0][0]="107/12/06"
        evidence=dict(url="https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=20181201&stockNo=00757",fetched_at="2026-10-13T15:00:00+00:00",payload=payload,sha256=collector.digest(payload))
        with tempfile.TemporaryDirectory() as directory:
            cache=Path(directory);(cache/"evidence").mkdir()
            (cache/"evidence/00757-201812-2026-10-13.json").write_text(json.dumps(evidence),encoding="utf-8")
            with patch.object(collector,"DATA",cache),patch.object(collector, "urlopen", side_effect=AssertionError("NO_REDOWLOAD")) as network:
                key, entry = collector.month_evidence("00757", "201812", "2026-10-14", False)
                network.assert_not_called()
        self.assertEqual(key, "00757-201812-2026-10-13")
        self.assertEqual(entry["payload"]["date"], "20181201")
        self.assertEqual(collector.digest(entry["payload"]), entry["sha256"])


if __name__ == "__main__": unittest.main()
