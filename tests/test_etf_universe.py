import json
import unittest
from datetime import date, datetime
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

from scripts.update_etf_universe import classify_etf, roc_date
from scripts.update_market_events import (
    bea_release_url,
    parse_fomc_statement,
    update_bea_event,
    update_bls_event,
)

ROOT = Path(__file__).resolve().parents[1]


class EtfUniverseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.payload = json.loads((ROOT / "etf-universe.json").read_text(encoding="utf-8"))
        cls.items = cls.payload["items"]
        cls.by_code = {item["code"]: item for item in cls.items}

    def test_counts_and_featured(self):
        self.assertGreaterEqual(self.payload["total"], 300)
        self.assertEqual(self.payload["total"], len(self.items))
        self.assertEqual(sum(self.payload["counts"].values()), len(self.items))
        self.assertIn("00935", self.by_code)
        self.assertEqual(self.by_code["00935"]["strategy_category"], "equity_sector")

    def test_codes_and_exclusions(self):
        self.assertTrue(any(code.endswith("A") for code in self.by_code))
        self.assertTrue(any(code.endswith("D") for code in self.by_code))
        self.assertTrue(any(code.endswith("L") for code in self.by_code))
        self.assertTrue(any(code.endswith("R") for code in self.by_code))
        self.assertTrue(any(code.endswith("U") for code in self.by_code))
        for item in self.items:
            text = f"{item['name']} {item['official_type']}"
            self.assertNotRegex(text, r"ETN|指數投資證券|權證|封閉式")
            if item["listed_date"]:
                self.assertLessEqual(item["listed_date"], date.today().isoformat())

    def test_priority_classification(self):
        self.assertEqual(classify_etf("00631L", "元大台灣50正2", "槓桿/反向指數股票型基金", "")["strategy_category"], "leveraged")
        self.assertEqual(classify_etf("00632R", "元大台灣50反1", "槓桿/反向指數股票型基金", "")["strategy_category"], "inverse")
        self.assertEqual(classify_etf("00990B", "國泰收益非投等債", "", "")["strategy_category"], "bond_high_yield")
        self.assertEqual(classify_etf("00999D", "主動測試債", "", "")["strategy_category"], "active_bond")

    def test_date_validation(self):
        self.assertEqual(roc_date("1150730"), "2026-07-30")
        self.assertEqual(roc_date("19208157"), "")

    def test_one_market_timeout_cannot_be_hidden_by_other_market_count(self):
        import scripts.update_etf_universe as u
        def isin(exchange, url, at):
            if exchange == "TPEx":
                raise TimeoutError("SYNTHETIC source outage")
            return [{}] * 300
        with patch.object(u, "fetch_json", return_value=[]), patch.object(u, "parse_isin", side_effect=isin):
            with self.assertRaisesRegex(ValueError, "Incomplete official ETF coverage: TPEx"):
                u.build_universe()

    def test_complete_market_coverage_and_traceable_catalog(self):
        self.assertGreater(self.payload["counts"]["TPEx"], 0)
        self.assertEqual(self.by_code["009815"]["exchange"], "TPEx")
        self.assertTrue(self.payload["source_status"]["isin_tpex"].startswith("ok:"))
        evidence = self.payload["source_evidence"]
        self.assertTrue(any("strMode=4" in x["url"] for x in evidence))
        for row in evidence:
            self.assertRegex(row["sha256"], r"^[a-f0-9]{64}$")

    def test_raw_response_receipt_is_computed_not_asserted_by_source(self):
        import hashlib
        import scripts.update_etf_universe as u
        from unittest.mock import MagicMock
        response = MagicMock()
        response.read.return_value = b"SYNTHETIC official response"
        response.status = 200
        response.headers.get_content_charset.return_value = "utf-8"
        response.__enter__.return_value = response
        u.SOURCE_EVIDENCE.clear()
        with patch.object(u, "urlopen", return_value=response):
            body, charset = u.fetch_bytes("https://isin.twse.com.tw/isin/C_public.jsp?strMode=4")
        receipt = u.SOURCE_EVIDENCE[-1]
        self.assertEqual(receipt["sha256"], hashlib.sha256(body).hexdigest())
        self.assertEqual(receipt["bytes"], len(body))
        self.assertEqual(receipt["http_status"], 200)
        self.assertIsNotNone(datetime.fromisoformat(receipt["at"]).tzinfo)
        self.assertEqual(charset, "utf-8")

    def test_fomc_parser(self):
        html = "<p>The Committee decided to maintain the target range for the federal funds rate at 3-1/2 to 3-3/4 percent.</p>"
        self.assertEqual(parse_fomc_statement(html), (3.5, 3.75))

    @patch("scripts.update_market_events.fetch_text")
    def test_bea_release_discovery(self, fetch):
        fetch.return_value = """
        <tr class="scheduled-releases-type-press">
          <td><div class="release-date">July 30</div></td>
          <td class="release-title">Personal Income and Outlays, June 2026</td>
          <td class="release-url"><a href="/news/2026/personal-income-and-outlays-june-2026">View</a></td>
        </tr>
        """
        url = bea_release_url({"date": "2026-07-30", "type": "PCE"})
        self.assertEqual(url, "https://www.bea.gov/news/2026/personal-income-and-outlays-june-2026")

    @patch("scripts.update_market_events.fetch_text")
    @patch("scripts.update_market_events.bea_release_url")
    def test_pce_result_parser(self, release_url, fetch):
        release_url.return_value = "https://www.bea.gov/news/2026/personal-income-and-outlays-june-2026"
        fetch.return_value = """
        July 30, 2026. From the same month one year ago, the PCE price index increased 3.2 percent.
        """
        event = {"date": "2026-07-30", "title": "美國 PCE", "type": "PCE", "status": "scheduled", "previous": "", "unit": "%"}
        changed = update_bea_event(event, [], datetime(2026, 7, 30, 21, tzinfo=ZoneInfo("Asia/Taipei")))
        self.assertTrue(changed)
        self.assertEqual(event["actual"], "3.2")
        self.assertEqual(event["status"], "announced")
        self.assertIn("bea.gov", event["official_source_url"])

    @patch("scripts.update_market_events.fetch_text")
    def test_cpi_result_parser(self, fetch):
        fetch.return_value = """
        July 30, 2026. Over the last 12 months, the all items index increased 2.8 percent
        before seasonal adjustment.
        """
        event = {"date": "2026-07-30", "title": "美國 CPI", "type": "CPI", "status": "scheduled", "previous": "2.6", "unit": "%"}
        changed = update_bls_event(event, [], datetime(2026, 7, 30, 21, tzinfo=ZoneInfo("Asia/Taipei")))
        self.assertTrue(changed)
        self.assertEqual(event["actual"], "2.8")
        self.assertEqual(event["previous"], "2.6")
        self.assertIn("bls.gov", event["official_source_url"])


if __name__ == "__main__":
    unittest.main()
