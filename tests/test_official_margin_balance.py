import datetime as dt
import unittest

from scripts.update_official_margin_balance import board_pairs, tpex_row, trade_dates, twse_row


class OfficialMargin(unittest.TestCase):
    def test_twse_real_unit_conversion_and_reconciliation(self):
        rows = {"date":"20261105","stat":"OK","tables":[
            {"fields":["項目","今日餘額"],"data":[["融資金額(仟元)","576,409,039"],["融資(交易單位)","2"]]},
            {"fields":["代號","名稱","今日餘額"],"data":[["0050","ETF","2"]]}]}
        self.assertEqual(twse_row(rows,"2026-11-05","a"*64)["amount_ntd"],576409039000)
        with self.assertRaisesRegex(ValueError,"date/status"):
            twse_row(rows,"2026-11-04","a"*64)
        rows["tables"][1]["data"].append(["0050","ETF","1"])
        with self.assertRaisesRegex(ValueError,"duplicate"):
            twse_row(rows,"2026-11-05","a"*64)

    def test_tpex_board_requires_aligned_exchange_sessions_and_dated_lots(self):
        days = [dt.date(2026,11,4),dt.date(2026,11,5)]
        board = {"marginPurchaseValue":[{"date":"11/4","count":"190919219"},{"date":"11/5","count":"184037303"}],
                 "marginPurchaseShares":[{"date":"11/4","count":"3"},{"date":"11/5","count":"2"}]}
        pairs = board_pairs(board,days)
        rows = {"date":"20261105","stat":"ok","tables":[{"fields":["代號","名稱","資餘額"],"data":[["0050","ETF","2"]]}]}
        self.assertEqual(tpex_row(rows,"2026-11-05","a"*64,pairs,"b"*64)["amount_ntd"],184037303000)
        with self.assertRaisesRegex(ValueError,"lots mismatch"):
            tpex_row(rows,"2026-11-05","a"*64,{"2026-11-05":(1,3)},"b"*64)
        with self.assertRaisesRegex(ValueError,"window"):
            board_pairs(board,days[1:])

    def test_calendar_rejects_wrong_month(self):
        rows = {"date":"20261101","stat":"ok","tables":[{"totalCount":1,"data":[["2026/10/30"]]}]}
        with self.assertRaisesRegex(ValueError,"calendar invalid"):
            trade_dates(rows,"2026/11")


if __name__ == "__main__":
    unittest.main()
