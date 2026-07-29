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
