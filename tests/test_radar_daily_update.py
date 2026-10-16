"""Deterministic protocol fixtures, temporary checkout only; never publish tests.

The fixed 10/13 -> 10/16 window uses immutable verified raw rows; envelopes are
test doubles. Actual external evidence is separately retained by the workflow.
"""
import copy
import datetime as dt
import json
import io
from http.client import IncompleteRead
from urllib.error import HTTPError
from pathlib import Path
import shutil
import tempfile
import unittest
from urllib.parse import urlsplit, parse_qs
from unittest.mock import patch, Mock
from scripts import update_radar_daily as u
from scripts.collect_radar_twse import FIELDS, digest
from scripts.audit_radar_calendar import FIELDS as CALENDAR_FIELDS
from scripts.audit_radar_tpex import MONTH_FIELDS

ACTUAL = {s:json.loads(u.path_for(u.ROOT,s).read_text(encoding="utf-8")) for s in u.SYMBOLS}
OCTOBER = {s:[r for r in p["price"] if "2026-10-01" <= r["date"] <= "2026-10-16"] for s,p in ACTUAL.items()}

def roc(date): return str(int(date[:4])-1911)+date[4:].replace("-","/")

class FixtureClient:
    def __init__(self, damage=None): self.calls=[];self.damage=damage
    def get(self,url):
        self.calls.append(url);q=parse_qs(urlsplit(url).query);endpoint=urlsplit(url).path.rsplit("/",1)[-1]
        dates=[r["date"] for r in OCTOBER["00830"]]
        if "holidaySchedule" in url: p=[{"Date":"20261009","Name":"國慶休市","Description":"市場無交易"}]
        elif endpoint=="FMTQIK":
            p=dict(stat="OK",date="20261001",fields=CALENDAR_FIELDS,data=[[roc(d),"100","100","1","1","0"] for d in dates])
        elif endpoint=="inx":
            p=dict(stat="ok",date="20261001",tables=[dict(fields=["日期","開市","最高","最低","收市","漲/跌"],totalCount=len(dates),data=[[d.replace("-","/"),"1","1","1","1","0"] for d in dates])])
        elif endpoint=="STOCK_DAY":
            s=q["stockNo"][0];rows=OCTOBER[s]
            p=dict(stat="OK",date="20261001",title="115年10月 "+s+" TEST_ONLY",fields=FIELDS,total=len(rows),data=[[roc(r["date"]),str(r["Trading_Volume"]),"100",str(r["open"]),str(r["max"]),str(r["min"]),str(r["close"]),"0","1",""] for r in rows])
        elif endpoint=="tradingStock":
            rows=OCTOBER["009815"]
            p=dict(stat="ok",date="20261001",tables=[dict(date="20261001",subtitle="009815 TEST_ONLY",fields=MONTH_FIELDS,totalCount=len(rows),data=[[roc(r["date"]),str(round(r["Trading_Volume"]/1000)),"100",str(r["open"]),str(r["max"]),str(r["min"]),str(r["close"]),"0","1"] for r in rows])])
        elif endpoint=="dailyQuotes":
            d=q["date"][0].replace("/","-");r=next(r for r in OCTOBER["009815"] if r["date"]==d)
            p=dict(stat="ok",date=d.replace("-",""),tables=[dict(fields=["代號","開盤","最高","最低","收盤","成交股數"],totalCount=1,data=[["009815",*[str(r[k]) for k in u.FIELDS]]])])
        elif endpoint=="TWT49U":
            p=dict(stat="OK",strDate=q["startDate"][0],endDate=q["endDate"][0],fields=["資料日期","股票代號","股票名稱","除權息前收盤價","除權息參考價","權值+息值","權/息"],data=[])
        elif endpoint in u.ACTIONS:
            p=dict(stat="ok",date=q["startDate"][0].replace("/","")+"~"+q["endDate"][0].replace("/",""),tables=[dict(fields=["代號"],totalCount=0,data=[])])
        else: raise AssertionError("Unexpected or non-official URL: "+url)
        if self.damage: self.damage(endpoint,q,p)
        return dict(url=url,payload=p,sha256=digest(p),fetched_at="2026-10-16T10:20:00+00:00")

class RadarDailyTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        for symbol in u.SYMBOLS:
            p=copy.deepcopy(ACTUAL[symbol]);p["price"]=[r for r in p["price"] if r["date"]<="2026-10-13"];p["requested_end"]="2026-10-13";p["action_coverage"]["end"]="2026-10-13";p.pop("incremental_verification",None)
            p.pop("content_sha256");p["content_sha256"]=digest(p);u.atomic_json(u.path_for(self.root,symbol),p)
            for folder in ("research/c4_historical/source","research/c4_historical"):
                source=u.ROOT/folder/(symbol+".json")
                if source.exists():
                    destination=self.root/folder/(symbol+".json");destination.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,destination)
        self.before={s:u.path_for(self.root,s).read_bytes() for s in u.SYMBOLS}
        self.now=dt.datetime(2026,10,16,11,tzinfo=dt.timezone.utc)
    def tearDown(self): self.temp.cleanup()
    def run_update(self,client=None,**args):
        with patch.object(u,"log"): return u.run(self.root,client or FixtureClient(),args.pop("now",self.now),**args)

    def test_six_symbols_fill_14_15_16_without_changing_old_rows(self):
        client=FixtureClient();status,ok=self.run_update(client)
        self.assertTrue(ok)
        for symbol in u.SYMBOLS:
            p=u.verify_archive(self.root,symbol);old=json.loads(self.before[symbol])
            self.assertEqual(p["requested_end"],"2026-10-16")
            self.assertEqual(p["price"][-3:],OCTOBER[symbol][-3:])
            self.assertEqual(p["price"][:-3],old["price"])
            self.assertEqual(p["base_source_sha256"],old["base_source_sha256"])
            self.assertEqual(status["symbols"][symbol]["latest_verified_date"],"2026-10-16")
        self.assertFalse(any("finmind" in url.lower() for url in client.calls))
        self.assertTrue(all("2018" not in url for url in client.calls))

    def test_rerun_idempotent_no_extra_candles_or_metadata_commits(self):
        self.run_update();before={s:u.path_for(self.root,s).read_bytes() for s in u.SYMBOLS};meta=(self.root/u.PUBLIC_STATUS).read_bytes()
        _,ok=self.run_update();self.assertTrue(ok)
        self.assertEqual(before,{s:u.path_for(self.root,s).read_bytes() for s in u.SYMBOLS})
        self.assertEqual(meta,(self.root/u.PUBLIC_STATUS).read_bytes())

    def test_before_1800_excludes_today_then_after_1800_adds_today(self):
        _,ok=self.run_update(now=dt.datetime(2026,10,16,9,59,tzinfo=dt.timezone.utc));self.assertTrue(ok)
        self.assertTrue(all(u.verify_archive(self.root,s)["requested_end"]=="2026-10-15" for s in u.SYMBOLS))
        self.run_update();self.assertTrue(all(u.verify_archive(self.root,s)["requested_end"]=="2026-10-16" for s in u.SYMBOLS))
        with self.assertRaisesRegex(ValueError,"UNCOMPLETED_DAY"):self.run_update(as_of="2026-10-16",now=dt.datetime(2026,10,16,9,59,tzinfo=dt.timezone.utc))

    def test_holiday_and_weekend_no_fabricated_session(self):
        client=FixtureClient()
        target,_,_=u.expected_day(client,dt.datetime(2026,10,10,11,tzinfo=dt.timezone.utc))
        self.assertEqual(target,"2026-10-08")
        self.run_update();before={s:u.path_for(self.root,s).read_bytes() for s in u.SYMBOLS}
        result,ok=self.run_update(now=dt.datetime(2026,10,17,11,tzinfo=dt.timezone.utc));self.assertTrue(ok)
        self.assertEqual(result["expected_completed_bar"],"2026-10-16");self.assertEqual(result["next_expected_trading_day"],"2026-10-19")
        self.assertEqual(before,{s:u.path_for(self.root,s).read_bytes() for s in u.SYMBOLS})

    def test_official_delay_retains_previous_symbol_bytes(self):
        def damage(endpoint,q,p):
            if endpoint=="STOCK_DAY" and q["stockNo"]==["00830"]:
                p["data"]=[r for r in p["data"] if r[0]!="115/10/16"];p["total"]=len(p["data"])
        status,ok=self.run_update(FixtureClient(damage));self.assertFalse(ok)
        self.assertEqual(u.path_for(self.root,"00830").read_bytes(),self.before["00830"])
        self.assertIn("OFFICIAL_SESSION_MISSING",status["symbols"]["00830"]["reason"])
        self.assertEqual(status["symbols"]["00830"]["status"],"STALE")

    def test_price_or_volume_overlap_conflict_never_overwrites(self):
        for index in (3,6,1):
            with self.subTest(index=index):
                def damage(endpoint,q,p):
                    if endpoint=="STOCK_DAY" and q["stockNo"]==["00830"]:
                        r=next(r for r in p["data"] if r[0]=="115/10/13");r[index]=str(float(r[index])+1)
                _,ok=self.run_update(FixtureClient(damage),repair_from="2026-10-01");self.assertFalse(ok)
                self.assertEqual(u.path_for(self.root,"00830").read_bytes(),self.before["00830"])

    def test_missing_interior_day_repaired_not_only_last_day(self):
        p=json.loads(self.before["00830"]);p["price"]=[r for r in p["price"] if r["date"]!="2026-10-12"];p.pop("content_sha256");p["content_sha256"]=digest(p);u.atomic_json(u.path_for(self.root,"00830"),p)
        self.run_update()
        self.assertIn("2026-10-12",{r["date"] for r in u.verify_archive(self.root,"00830")["price"]})

    def test_tpex_exact_shares_not_rounded_lot_multiplication(self):
        self.run_update();p=u.verify_archive(self.root,"009815")
        self.assertEqual(p["provider"],"TPEx/dailyQuotes");self.assertEqual(p["price"][-1]["Trading_Volume"],OCTOBER["009815"][-1]["Trading_Volume"])
        self.assertEqual(p["price"][-3:],OCTOBER["009815"][-3:])
        def damage(endpoint,q,p):
            if endpoint=="dailyQuotes":p["tables"][0]["data"][0][-1]="1000"
        _,ok=self.run_update(FixtureClient(damage),repair_from="2026-10-01");self.assertFalse(ok)

    def test_corporate_action_fails_closed(self):
        def damage(endpoint,q,p):
            if endpoint=="etfSplitRslt":p["tables"][0].update(totalCount=1,data=[["009815"]])
        _,ok=self.run_update(FixtureClient(damage));self.assertFalse(ok)
        self.assertEqual(u.path_for(self.root,"009815").read_bytes(),self.before["009815"])

    def test_network_failure_retains_all_previous_prices(self):
        class Down(FixtureClient):
            def get(self,url):
                if "STOCK_DAY" in url or "tradingStock" in url:raise OSError("TEST_SOURCE_OUTAGE")
                return super().get(url)
        result,ok=self.run_update(Down());self.assertFalse(ok)
        self.assertEqual(self.before,{s:u.path_for(self.root,s).read_bytes() for s in u.SYMBOLS})
        self.assertTrue(all(r["status"]=="STALE" for r in result["symbols"].values()))

    def test_tampered_seed_or_archive_rejected(self):
        p=self.root/"research/c4_historical/source/00830.json";p.write_text("{}",encoding="utf-8")
        with self.assertRaisesRegex(ValueError,"FINMIND_PROVENANCE"):u.verify_archive(self.root,"00830")
        p=u.path_for(self.root,"0050");p.write_text(p.read_text(encoding="utf-8").replace('"RAW_UNADJUSTED"','"ADJUSTED"'),encoding="utf-8")
        with self.assertRaisesRegex(ValueError,"ARCHIVE_INTEGRITY"):u.verify_archive(self.root,"0050")

    def test_only_seven_allowlisted_public_outputs(self):
        writes=[];original=u.atomic_json
        def record(path,payload):writes.append(str(path.relative_to(self.root)).replace("\\","/"));return original(path,payload)
        with patch.object(u,"atomic_json",record):self.run_update()
        allowed={str(u.path_for(self.root,s).relative_to(self.root)).replace("\\","/") for s in u.SYMBOLS}|{u.PUBLIC_STATUS}
        self.assertEqual(set(writes),allowed)

    def test_calendar_outage_is_unknown_not_a_false_current_status(self):
        class Down(FixtureClient):
            def get(self,url):raise OSError("TEST_CALENDAR_OUTAGE")
        result,ok=self.run_update(Down());self.assertFalse(ok)
        self.assertIsNone(result["expected_completed_bar"])
        self.assertTrue(all(r["status"]=="STALE" and "CALENDAR_GATE_UNAVAILABLE" in r["reason"] for r in result["symbols"].values()))
        self.assertEqual(self.before,{s:u.path_for(self.root,s).read_bytes() for s in u.SYMBOLS})

    def test_atomic_replace_failure_retains_original_file(self):
        path=u.path_for(self.root,"00830")
        with patch.object(u.os,"replace",side_effect=OSError("TEST_ATOMIC_FAILURE")):
            with self.assertRaises(OSError):u.atomic_json(path,{"bad":"TEST_ONLY"})
        self.assertEqual(path.read_bytes(),self.before["00830"]);self.assertFalse(path.with_name(path.name+".tmp").exists())

    def test_publication_requires_actual_pages_and_all_public_files(self):
        self.run_update()
        def fetch(url,timeout):
            relative=urlsplit(url).path.removeprefix("/-hs-invest/")
            return io.BytesIO((self.root/relative).read_bytes())
        with patch.dict(u.os.environ,{"GITHUB_REPOSITORY":"owner/test"}),patch.object(u,"log"),patch.object(u.subprocess,"check_output",return_value='{"status":"built","commit":"TEST_ONLY"}'):
            self.assertTrue(u.verify_publication(self.root,"https://fixture.invalid/-hs-invest/",attempts=1,fetcher=fetch))
        with patch.dict(u.os.environ,{"GITHUB_REPOSITORY":"owner/test"}),patch.object(u,"log"),patch.object(u.subprocess,"check_output",return_value='{"status":"building"}'):
            self.assertFalse(u.verify_publication(self.root,"https://fixture.invalid/-hs-invest/",attempts=1,fetcher=fetch))
        def stale(url,timeout):
            return io.BytesIO(b'{"schema_version":1,"status":"OLD_TEST_ONLY"}')
        with patch.dict(u.os.environ,{"GITHUB_REPOSITORY":"owner/test"}),patch.object(u,"log"),patch.object(u.subprocess,"check_output",return_value='{"status":"built"}'):
            self.assertFalse(u.verify_publication(self.root,"https://fixture.invalid/-hs-invest/",attempts=1,fetcher=stale))

    def test_transport_retry_discards_partial_payload_then_keeps_one_complete_response(self):
        class Response(io.BytesIO): status=200
        with patch.object(u.time,"sleep"),patch.object(u,"log"):
            opener=Mock(side_effect=[IncompleteRead(b"PARTIAL_TEST_ONLY"),TimeoutError("TEST_ONLY"),Response(b'{"complete":true}')])
            client=u.Client(self.root/"evidence",root=self.root/"checkout",opener=opener)
            entry=client.get("https://fixture.invalid/official")
            self.assertEqual(entry["payload"],{"complete":True});self.assertEqual(opener.call_count,3)
            self.assertEqual(len(list((self.root/"evidence").glob("*.json"))),1)
            self.assertEqual(client.get(entry["url"]),entry);self.assertEqual(opener.call_count,3)

    def test_transport_retry_is_bounded_and_never_caches_partial_body(self):
        opener=Mock(side_effect=IncompleteRead(b"PARTIAL_TEST_ONLY"))
        with patch.object(u.time,"sleep"),patch.object(u,"log"):
            client=u.Client(self.root/"evidence",root=self.root/"checkout",opener=opener)
            with self.assertRaises(IncompleteRead):client.get("https://fixture.invalid/official")
        self.assertEqual(opener.call_count,3);self.assertEqual(client.entries,{})
        self.assertEqual(list((self.root/"evidence").glob("*.json")),[])

    def test_semantic_invalid_json_and_quota_error_are_not_retried(self):
        class Response(io.BytesIO): status=200
        for index,error in enumerate([Response(b'{"incomplete":'),HTTPError("https://fixture.invalid",402,"TEST_QUOTA",{},None)]):
            with self.subTest(index=index),patch.object(u.time,"sleep"):
                opener=Mock(return_value=error) if isinstance(error,Response) else Mock(side_effect=error)
                client=u.Client(self.root/("evidence"+str(index)),root=self.root/"checkout",opener=opener)
                with self.assertRaises((json.JSONDecodeError,HTTPError)):client.get("https://fixture.invalid/official")
                self.assertEqual(opener.call_count,1);self.assertEqual(client.entries,{})

if __name__=="__main__":unittest.main()
