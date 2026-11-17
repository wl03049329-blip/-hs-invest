import json
import unittest
from datetime import date
from unittest.mock import patch

from backend.trading_calendar import TradingCalendar, fetch_year_schedule


class CalendarRollover(unittest.TestCase):
    def test_no_matching_year_is_not_a_trading_day(self):
        calendar = TradingCalendar(lambda: [{"Date":"1160101"}])
        self.assertEqual(calendar.check(date(2026,11,16)).status,"UNKNOWN")

    def test_year_bound_endpoint_preserves_holidays_and_caches_valid_result(self):
        payload = dict(stat="ok",queryYear=2026,total=1,fields=["日期","名稱","說明"],
                       data=[["2026-12-25","行憲紀念日","放假"]])
        calendar = TradingCalendar(lambda: [{"Date":"1160101"}],year_fetcher=fetch_year_schedule)
        with patch("backend.trading_calendar.fetch_bytes",return_value=json.dumps(payload).encode()) as get:
            for _ in range(2):
                self.assertEqual(calendar.check(date(2026,11,16)).status,"TRADING_DAY")
            get.assert_called_once()
            self.assertIn("date=20260101",get.call_args.args[0])
            self.assertEqual(calendar.check(date(2026,12,25)).status,"HOLIDAY")

    def test_wrong_year_and_truncated_response_do_not_pass(self):
        for year,total in ((2027,1),(2026,2)):
            payload = dict(stat="ok",queryYear=year,total=total,fields=["日期","名稱","說明"],
                           data=[["2026-12-25","行憲紀念日","放假"]])
            calendar = TradingCalendar(lambda: [{"Date":"1160101"}],year_fetcher=fetch_year_schedule)
            with patch("backend.trading_calendar.fetch_bytes",return_value=json.dumps(payload).encode()):
                self.assertEqual(calendar.check(date(2026,11,16)).status,"UNKNOWN")
