from decimal import Decimal
import unittest
from unittest.mock import patch

from scripts import audit_portfolio_close_evidence as a
from scripts.update_radar_daily import HOLIDAY_URL, next_trading_session


class Fixture:
    def __init__(self, payloads):
        self.payloads = payloads

    def get(self, url):
        path = url.split("?")[0].split("/")[-1]
        p = self.payloads[path]
        return dict(url=url, payload=p, sha256=a.digest(p), fetched_at="2026-11-24T10:30:00+00:00")


class PortfolioCloseEvidenceTests(unittest.TestCase):
    def test_genuine_trades_only_and_exact_date(self):
        payload = dict(stat="OK", date="20261124", tables=[dict(
            fields=["證券代號", "收盤價", "成交股數"],
            data=[["00631L", "27.00", "1,234"], ["00685L", "8.61", "0"], ["00830", "--", "1"]])])
        self.assertEqual(a.traded_rows(payload, "TWSE", "2026-11-24"), {"00631L": Decimal("27")})
        with self.assertRaisesRegex(ValueError, "WRONG_SESSION"):
            a.traded_rows(payload, "TWSE", "2026-11-23")
        payload["tables"][0]["data"].append(["00631L", "27.01", "2"])
        with self.assertRaisesRegex(ValueError, "DUPLICATE"):
            a.traded_rows(payload, "TWSE", "2026-11-24")

    def test_action_windows_exact_and_pause_on_dividend_split_or_capital_change(self):
        payloads = {}
        for path, start_key, date_key, code_key in a.TWSE_ACTIONS:
            payloads[path.split("/")[-1]] = dict(stat="OK", **{start_key:"20261123", "endDate":"20261124"},
                fields=[date_key, code_key], data=[])
        payloads["TWT49U"]["data"] = [["115年11月24日", "00631L"]]
        payloads["TWTCAU"]["data"] = [["115/11/24", "00685L"]]
        payloads["TWTAUU"]["data"] = [["115/11/24", "00830"]]
        hits, refs = a.actions(Fixture(payloads), "TWSE", "2026-11-23", "2026-11-24")
        self.assertEqual(set(hits), {"00631L", "00685L", "00830"})
        self.assertEqual(len(refs), 3)
        del payloads["TWTCAU"]["data"]
        with self.assertRaisesRegex(ValueError, "SCHEMA"):
            a.actions(Fixture(payloads), "TWSE", "2026-11-23", "2026-11-24")

    def test_tpex_empty_requires_explicit_schema_date_and_row_count(self):
        payloads = {tag:dict(stat="ok",date="20261123~20261124",
                     tables=[dict(fields=[day,code],data=[],totalCount=0)]) for tag,day,code in a.TPEX_ACTIONS}
        hits, refs = a.actions(Fixture(payloads), "TPEx", "2026-11-23", "2026-11-24")
        self.assertEqual(hits, {})
        self.assertEqual(len(refs),5)
        payloads["etfSplitRslt"]["tables"][0]["totalCount"] = 1
        with self.assertRaisesRegex(ValueError, "SCHEMA_OR_COUNT"):
            a.actions(Fixture(payloads), "TPEx", "2026-11-23", "2026-11-24")

    def test_cross_year_forward_calendar_does_not_assume_january_1(self):
        class YearFixture:
            def get(self, url):
                if url == HOLIDAY_URL:
                    data = [{"Date":"1160101", "Name":"元旦", "Description":"休市"}]
                elif "date=20260101" in url:
                    data = dict(stat="ok",queryYear=2026,total=1,fields=["日期","名稱","說明"],
                                data=[["2026-01-01","元旦","休市"]])
                else:
                    raise AssertionError("unexpected request")
                return dict(url=url, payload=data, sha256=a.digest(data), fetched_at="2026-12-31T10:00:00+00:00")
        self.assertEqual(next_trading_session(YearFixture(), "2026-12-31"), "2027-01-04")

    def test_cross_month_calendar_requires_pair_consecutive_independent_of_weekend(self):
        with patch.object(a, "official_sessions", side_effect=[
            (["2026-10-29","2026-10-30"],{}), (["2026-11-02","2026-11-03"],{})]) as check:
            with self.assertRaisesRegex(ValueError, "NOT_CONSECUTIVE"):
                a.gather_market(None, "TWSE", "2026-10-30", "2026-11-03")
            self.assertEqual([x.args[2] for x in check.call_args_list], ["202610", "202611"])

    def test_generic_audit_never_falls_back_to_previous_reference_or_zero(self):
        rows = [{"market":"TWSE", "code":k, "quote_mode":"close", "date":"2026-11-24",
                 "price":10, "previous_close":9} for k in ["0050", "00631L", "00830", "9999"]]
        rows[3]["previous_close"] = 0
        cache = dict(version=2, items=rows, source_dates={"TWSE":"2026-11-24"}, official_source_dates={"TWSE":"2026-11-24"},
                     source_status={"TWSE":"official_closing_data_daily_report"})
        prev = {k:Decimal(9) for k in ["0050","00830","9999"]}
        cur = {k:Decimal(10) for k in prev}
        with patch.object(a,"expected_day",side_effect=[("2026-11-24",None,None),("2026-11-23",None,None)]), \
             patch.object(a,"next_trading_session",return_value="2026-11-25"), \
             patch.object(a,"gather_market",return_value=([prev,cur],{"00830":["TWTCAU"]},{})):
            r=a.audit(None,cache,"2026-11-24",{"0050","00631L","00830","9999"})
        self.assertEqual(r["rows"]["0050"]["status"],"VERIFIED_FOR_READ_ONLY_AUDIT")
        self.assertEqual(r["rows"]["00631L"]["reason"],"MISSING_ACTUAL_TRADE_CLOSE")
        self.assertEqual(r["rows"]["00830"]["reason"],"ACTION_REVIEW_REQUIRED:TWTCAU")
        self.assertEqual(r["rows"]["9999"]["reason"],"PRICE_OR_COMPARISON_CONFLICT")

    def test_a_holiday_is_not_a_target_close(self):
        with patch.object(a,"expected_day",return_value=("2026-11-20",None,None)):
            with self.assertRaisesRegex(ValueError,"NOT_TRADING_SESSION"):
                a.audit(None,{},"2026-11-22",{"0050"})


if __name__ == "__main__":
    unittest.main()
