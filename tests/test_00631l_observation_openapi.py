import datetime as dt
import json
import tempfile
import unittest
from unittest.mock import patch

from scripts import update_00631l_observation as m


class OpenApiTests(unittest.TestCase):
    def setUp(self):
        self.day = "2026-11-17"
        self.row = dict(Date="1151117", Code="00631L", OpeningPrice="27.06", HighestPrice="29.09",
                        LowestPrice="26.35", ClosingPrice="26.86", TradeVolume="688053277", Change="-1.0900")

    def parse(self, **changes):
        return m.parse_openapi(json.dumps([{**self.row, **changes}]), self.day, 26.86, 27.95)

    def test_verified_bar(self):
        self.assertEqual(self.parse(), [27.06, 29.09, 26.35, 26.86, 688053277])

    def test_stale_or_wrong_day(self):
        with self.assertRaisesRegex(Exception, "SESSION_DATE_MISMATCH"):
            self.parse(Date="1151116")

    def test_split_like_reset_and_flag(self):
        for change in ("+0.01", "X0.00"):
            with self.subTest(change=change), self.assertRaisesRegex(Exception, "REFERENCE_RESET"):
                self.parse(Change=change)

    def test_invalid_range_missing_volume_and_close_conflict(self):
        for fields in ({"HighestPrice":"26.00"}, {"TradeVolume":"0"}, {"ClosingPrice":"26.85"}):
            with self.subTest(fields=fields), self.assertRaisesRegex(Exception, "OHLCV"):
                self.parse(**fields)

    def test_missing_and_duplicate_symbol(self):
        for rows in ([{**self.row, "Code":"0050"}], [self.row, self.row]):
            with self.assertRaisesRegex(Exception, "SYMBOL_NOT_UNIQUE"):
                m.parse_openapi(json.dumps(rows), self.day, 26.86, 27.95)

    def test_archive_integrity_and_license(self):
        a = dict(schema=1, kind="price_twse", trade_date=self.day, source="twse_openapi_stock_day_all",
                 license="open", license_url=m.LICENSE, revision=1, previous_checksum=None,
                 fields=["open","high","low","close","volume_shares"],
                 rows={m.SYMBOL:["27.06","29.09","26.35","26.86",688053277]})
        a["checksum"] = m.sha(json.dumps({k:a[k] for k in ("rows","source","license")},
                                         sort_keys=True, separators=(",",":")).encode())
        raw = json.dumps(a).encode()
        self.assertEqual(m.verify_archive(raw, self.day, 26.86, m.sha(raw)), self.parse())
        with self.assertRaisesRegex(Exception, "ARCHIVE_FILE_HASH"):
            m.verify_archive(raw+b" ", self.day, 26.86, m.sha(raw))
        with self.assertRaisesRegex(Exception, "ARCHIVE_DATE_SOURCE_OR_LICENSE"):
            m.verify_archive(raw, "2026-11-16", 26.86, m.sha(raw))
        a["rows"][m.SYMBOL][0] = "27.01"
        altered = json.dumps(a).encode()
        with self.assertRaisesRegex(Exception, "ARCHIVE_DATA_CHECKSUM"):
            m.verify_archive(altered, self.day, 26.86, m.sha(altered))

    def test_missing_seed_never_queries_source(self):
        with tempfile.TemporaryDirectory() as root, patch.object(m, "read", return_value={
            "content_sha256":m.digest({"expected_completed_bar":self.day}), "expected_completed_bar":self.day
        }), patch.object(m, "load_history", return_value={"asof":"2026-11-05","histories":{m.SYMBOL:[]}}):
            with self.assertRaisesRegex(Exception, "AUTHORIZED_CONTINUOUS_BACKFILL_REQUIRED"):
                m.build(root, lambda: self.fail("source queried"), dt.datetime.now(m.TZ))


if __name__ == "__main__":
    unittest.main()
