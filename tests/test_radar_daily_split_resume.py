"""Verify the bounded split exception through the Python and Node publishers."""
import copy
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

from scripts import update_radar_daily as u, radar_split_gate as gate
from scripts.collect_radar_twse import FIELDS, digest
from scripts.audit_radar_calendar import FIELDS as CALENDAR_FIELDS

GAPS = ["2026-11-11", "2026-11-12", "2026-11-13", "2026-11-16"]
RESUME = dict(date=gate.RESUME, stock_id=gate.SYMBOL, open=24, max=25, min=23, close=24.5, Trading_Volume=9000)
BASE = json.loads(u.path_for(u.ROOT, gate.SYMBOL).read_text(encoding="utf-8"))
BASE["price"] = [r for r in BASE["price"] if r["date"] <= gate.LAST]
BASE["dividends"] = [r for r in BASE["dividends"] if r["date"] <= gate.LAST]
BASE["requested_end"] = BASE["action_coverage"]["end"] = gate.LAST
BASE.pop("reviewed_split_20261117", None)
BASE.pop("content_sha256")
BASE["content_sha256"] = digest(BASE)
HISTORY = [r for r in BASE["price"] if "2026-11-01" <= r["date"] <= gate.LAST]
SESSIONS = [r["date"] for r in HISTORY] + GAPS + [gate.RESUME]
def roc(date): return "115/" + date[5:].replace("-", "/")

class Fixture:
    def __init__(self, fault=""): self.fault = fault
    def get(self, url, *, html=False):
        q = parse_qs(urlsplit(url).query)
        if url == gate.SCHEDULE:
            resume = "18" if self.fault == "delay" else "17"
            p = f"00662 受益憑證最後交易日期：115年11月10日<br>受益憑證停止交易期間：115年11月11日至115年11月16日<br>新受益憑證上市買賣日：115年11月{resume}日"
        elif url == gate.REFERENCE:
            p = dict(stat="OK",fields=["恢復買賣日期","ETF代號","名稱","分割(反分割)","停止買賣前收盤價格","恢復買賣參考價"],
                     data=[["115/11/17","00662","fixture","分割","117.80","23.57" if self.fault=="ratio" else "23.56","1","1","1"]])
            if self.fault == "duplicate": p["data"] *= 2
        elif "FMTQIK" in url:
            p = dict(stat="OK",date="20261101",fields=CALENDAR_FIELDS,data=[[roc(d),"100","100","1","1","0"] for d in SESSIONS])
        elif "STOCK_DAY" in url:
            rows = HISTORY + ([] if self.fault == "no_trade" else [RESUME])
            p = dict(stat="OK",date="20261101",fields=FIELDS,title=q["stockNo"][0]+" fixture",total=len(rows),
                     data=[[roc(r["date"]),str(r["Trading_Volume"]),"1",*[str(r[k]) for k in u.FIELDS[:4]],"0","1","**" if r is RESUME else ""] for r in rows])
        elif "MI_INDEX" in url:
            date = q["date"][0]
            rows = [["0050","100","102","99","101","1000"]]
            if date == "20261117" or (self.fault == "halt_trade" and date == "20261111"):
                rows.append(["00662","24","25","23","24.6" if self.fault=="ohlc" else "24.5","9000"])
            p = dict(stat="OK",date="20261110" if self.fault=="gap_report" else date,
                     tables=[dict(fields=["證券代號","開盤價","最高價","最低價","收盤價","成交股數"],data=rows)])
        elif "TWT49U" in url:
            p = dict(stat="OK",strDate=q["startDate"][0],endDate=q["endDate"][0],fields=["資料日期","股票代號","股票名稱","除權息前收盤價","除權息參考價","權值+息值","權/息"],data=[])
        else: raise AssertionError(url)
        return dict(url=url, payload=p, sha256=digest(p), fetched_at="2026-11-17T10:15:00+00:00")

class SplitRecovery(unittest.TestCase):
    def test_no_fake_bars_and_actual_pipeline_to_final(self):
        with tempfile.TemporaryDirectory() as d, patch.object(u,"verify_archive",return_value=copy.deepcopy(BASE)):
            root = Path(d)
            for day in GAPS:
                archive, changed, state = u.update_symbol(root,Fixture(),gate.SYMBOL,day,{})
                self.assertEqual((archive["requested_end"],changed,state),(gate.LAST,False,"OFFICIAL_SUSPENSION"))
                self.assertFalse(u.path_for(root,gate.SYMBOL).exists())
            archive, changed, state = u.update_symbol(root,Fixture(),gate.SYMBOL,gate.RESUME,BASE["evidence"][0])
            self.assertEqual((changed,state),(True,"UPDATED"))
            self.assertEqual(archive["price"], BASE["price"]+[RESUME])
            proof = archive["reviewed_split_20261117"]
            self.assertEqual(proof["excluded_sessions"],GAPS)
            self.assertTrue(u.path_for(root,gate.SYMBOL).exists())
            node = shutil.which("node")
            self.assertIsNotNone(node, "node is required for end-to-end coverage")
            proc = subprocess.run([node,"tests/c4_split_resume_eod.cjs","--proof-stdin"],input=json.dumps(proof),text=True,
                                  cwd=u.ROOT,capture_output=True)
            self.assertEqual(proc.returncode,0,proc.stderr)
            self.assertIn("FINAL_SPLIT_E2E_PASS",proc.stdout)

    def test_unsafe_cases_fail_without_writes(self):
        with tempfile.TemporaryDirectory() as d, patch.object(u,"verify_archive",return_value=copy.deepcopy(BASE)):
            root=Path(d)
            for fault, error in {"delay":"SCHEDULE","no_trade":"SESSION_MISSING","ohlc":"OHLC_CONFLICT",
                                 "duplicate":"REFERENCE_UNVERIFIED","ratio":"REFERENCE_CONFLICT",
                                 "halt_trade":"SUSPENSION_CONFLICT","gap_report":"DAILY_REPORT_UNVERIFIED"}.items():
                with self.subTest(fault=fault), self.assertRaisesRegex(ValueError,error):
                    u.update_symbol(root,Fixture(fault),gate.SYMBOL,gate.RESUME,{})
                self.assertFalse(u.path_for(root,gate.SYMBOL).exists())
            with self.assertRaisesRegex(ValueError,"OFFICIAL_SESSION_MISSING"):
                u.update_symbol(root,Fixture("no_trade"),"0050",gate.RESUME,{})
