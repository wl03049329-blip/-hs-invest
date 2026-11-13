import datetime as dt
import io
import json
import unittest
from unittest.mock import patch
from urllib.error import URLError, HTTPError
from scripts import update_radar_daily as daily
from scripts import fetch_official_eod_market as eod
from scripts import update_market_quotes as quotes

class CalendarClient:
    def get(self, url):
        return {'url':url,'fetched_at':'2026-11-04T06:00:00Z','sha256':'a'*64,'payload':[
            {'Date':'20260101','Name':'元旦','Description':'休市'},
            {'Date':'20261009','Name':'國慶補假','Description':'休市'}]}

class SourceReady(unittest.TestCase):
    def test_rolled_calendar_requires_positive_exact_session(self):
        fixture = {'url':'holiday','fetched_at':'2026-11-13T01:00:00Z','sha256':'a'*64,
                   'payload':[{'Date':'1160101','Description':'放假'}]}
        client = CalendarClient()
        with patch.object(client,'get',return_value=fixture):
            stamp = dt.datetime.fromisoformat('2026-11-13T09:33:00+08:00')
            with patch.object(daily,'official_sessions',return_value=(['2026-11-11','2026-11-12'],{'url':'FMTQIK'})) as market:
                self.assertEqual(daily.expected_day(client,stamp),('2026-11-12','2026-11-12',{'url':'FMTQIK'}))
                market.assert_called_once_with(client,'twse','202611','2026-11-12')
            with patch.object(daily,'official_sessions',return_value=(['2026-11-11'],{})):
                with self.assertRaisesRegex(ValueError,'HOLIDAY_CALENDAR_COVERAGE'):
                    daily.expected_day(client,stamp)
    def day(self, stamp, **kwargs):
        return daily.expected_day(CalendarClient(),dt.datetime.fromisoformat(stamp),**kwargs)[0]
    def test_early_final_does_not_change_raw_1800_policy(self):
        self.assertEqual(self.day('2026-11-04T15:00:00+08:00'),'2026-11-03')
        self.assertEqual(self.day('2026-11-04T15:00:00+08:00',minimum_time=(13,30)),'2026-11-04')
    def test_close_boundary_is_candidate_not_ready(self):
        self.assertEqual(self.day('2026-11-04T13:29:59+08:00',minimum_time=(13,30)),'2026-11-03')
        d=self.day('2026-11-04T13:30:00+08:00',minimum_time=(13,30))
        self.assertEqual(d,'2026-11-04')
        r=eod.resolve(d,eod.source_state(eod.PRIMARY_PROVIDER,{}),eod.source_state(eod.FALLBACK_PROVIDER,{}),False,'2026-11-04T05:30:01Z')
        self.assertEqual(r['status'],'SOURCE_NOT_READY');self.assertEqual(r['items'],{})
    def test_midnight_preopen_no_nonexistent_close(self):
        for stamp in ['2026-11-04T00:53:00+08:00','2026-11-04T08:59:00+08:00','2026-11-04T10:00:00+08:00']:
            self.assertEqual(self.day(stamp,minimum_time=(13,30)),'2026-11-03')
    def test_weekend_holiday_from_official_calendar(self):
        self.assertEqual(self.day('2026-11-08T17:00:00+08:00',minimum_time=(13,30)),'2026-11-06')
        self.assertEqual(self.day('2026-10-09T17:00:00+08:00',minimum_time=(13,30)),'2026-10-08')
    def test_calendar_unavailable_fails_closed(self):
        with patch.object(CalendarClient,'get',side_effect=URLError('offline')):
            with self.assertRaises(URLError):self.day('2026-11-04T15:00:00+08:00',minimum_time=(13,30))
    def test_unsupported_gate_not_accepted(self):
        with self.assertRaises(ValueError):self.day('2026-11-04T15:00:00+08:00',minimum_time=(9,0))
    def test_official_whole_response_retried_not_semantics(self):
        class Response(io.BytesIO):
            status=200
        with patch.object(eod.urllib.request,'urlopen',side_effect=[URLError('offline'),Response(b'[]')]) as get,patch.object(eod.time,'sleep'):
            self.assertEqual(eod.fetch_bytes('https://www.twse.com.tw/'),b'[]');self.assertEqual(get.call_count,2)
    def test_official_retry_bounded(self):
        with patch.object(eod.urllib.request,'urlopen',side_effect=URLError('offline')) as get,patch.object(eod.time,'sleep'):
            with self.assertRaises(URLError):eod.fetch_bytes('https://www.twse.com.tw/')
            self.assertEqual(get.call_count,3)
    def test_permanent_http_error_no_retry(self):
        with patch.object(eod.urllib.request,'urlopen',side_effect=HTTPError('https://x',403,'forbidden',None,None)) as get:
            with self.assertRaises(HTTPError):eod.fetch_bytes('https://www.twse.com.tw/')
            self.assertEqual(get.call_count,1)
    def report(self, count=100):
        return {'stat':'OK','date':'20261104','tables':[{'fields':['證券代號','證券名稱','收盤價','漲跌(+/-)','漲跌價差'],
               'data':[[str(1000+i),'SYNTHETIC_ONLY','100','+','1'] for i in range(count)]}]}
    def test_verified_complete_official_close_can_arrive_before_1600(self):
        with patch.object(quotes,'fetch_official_json',return_value=self.report()) as get:
            rows,date=quotes.latest_twse_daily_report(dt.datetime.fromisoformat('2026-11-04T15:00:00+08:00'),'2026-11-03',100)
            self.assertEqual(date,'2026-11-04');self.assertEqual(len(rows),100)
            self.assertIn('date=20261104',get.call_args_list[0].args[0])
    def test_incomplete_official_report_still_rejected_before_1600(self):
        with patch.object(quotes,'fetch_official_json',return_value=self.report(99)):
            self.assertIsNone(quotes.latest_twse_daily_report(dt.datetime.fromisoformat('2026-11-04T15:00:00+08:00'),'2026-11-03',100))
    def test_before_close_report_does_not_request_today(self):
        with patch.object(quotes,'fetch_official_json',return_value=self.report()) as get:
            quotes.latest_twse_daily_report(dt.datetime.fromisoformat('2026-11-04T13:29:59+08:00'),'2026-11-03',100)
            self.assertNotIn('date=20261104',get.call_args_list[0].args[0])

if __name__=='__main__':unittest.main()
