"""One request budget, one source payload; no cross-request price repairs."""
import copy
import unittest
from unittest.mock import patch

import phase_l7_daily as daily
import test_phase_l7_sources as sources


class YahooSelectionTests(unittest.TestCase):
    def setUp(self):
        self.source = sources.SourceTests()
        self.source.setUpClass()
        self.source.setUp()
        self.complete = copy.deepcopy(self.source.yahoo)
        self.url = "https://query1.finance.yahoo.com/v8/finance/chart/00631L.TW?interval=1d"

    def select(self, payloads):
        calls = []
        def fetch(url):
            calls.append(url)
            value = payloads[len(calls) - 1]
            if isinstance(value, Exception):
                raise value
            return value
        result = daily.select_yahoo_payload(self.url, "2026-09-30", fetch)
        self.assertEqual(calls, [self.url] * 3)
        return result

    def missing(self, index=-1, field="adjclose"):
        value = copy.deepcopy(self.complete)
        result = value["chart"]["result"][0]
        array = (result["indicators"]["adjclose"][0]["adjclose"] if field == "adjclose"
                 else result["indicators"]["quote"][0][field])
        array[index] = None
        return value

    def test_complete_in_each_position_wins(self):
        for index in range(3):
            with self.subTest(index=index):
                payloads = [self.missing(), self.missing(-2), self.missing()]
                payloads[index] = self.complete
                self.assertIs(self.select(payloads), self.complete)

    def test_transport_then_semantic_missing_then_complete(self):
        self.assertIs(self.select([OSError("secret"), self.missing(), self.complete]), self.complete)

    def test_never_stitches_complementary_incomplete_payloads(self):
        payloads = [self.missing(-2), self.missing(-3), self.missing(-4)]
        before = copy.deepcopy(payloads)
        chosen = self.select(payloads)
        self.assertTrue(any(chosen is p for p in payloads))
        self.assertEqual(payloads, before)
        with self.assertRaises(daily.Error):
            daily.parse_yahoo(chosen, self.source.historical, "2026-09-30")

    def test_all_incomplete_collection_stays_closed(self):
        payloads = iter([self.missing(-2), self.missing(-3), self.missing(-4)])
        def fetch(url):
            return next(payloads) if "yahoo" in url else self.source.fetch(url)
        with self.assertRaises(daily.Error):
            daily.collect(self.source.historical, self.source.prior, self.source.policy,
                          self.source.now, fetch)

    def test_latest_completeness_then_row_count_then_coverage(self):
        self.assertIs(self.select([self.missing(), self.missing(-2), self.complete]), self.complete)
        fewer = copy.deepcopy(self.complete)
        result = fewer["chart"]["result"][0]
        result["timestamp"].pop(0)
        for array in result["indicators"]["quote"][0].values():
            array.pop(0)
        result["indicators"]["adjclose"][0]["adjclose"].pop(0)
        self.assertIs(self.select([fewer, self.complete, fewer]), self.complete)

    def test_identity_or_unreviewed_event_is_not_hidden_by_good_payload(self):
        for change in ("identity", "event"):
            wrong = copy.deepcopy(self.complete)
            result = wrong["chart"]["result"][0]
            if change == "identity":
                result["meta"]["symbol"] = "0050.TW"
            else:
                result["events"] = {"splits": {"new": {"date": result["timestamp"][-1],
                                                       "numerator": 2, "denominator": 1}}}
            with self.assertRaises(daily.Error):
                self.select([self.complete, wrong, self.complete])

    def test_all_transport_failures_are_sanitized(self):
        with self.assertRaisesRegex(daily.Error, "^YAHOO_SOURCE_UNAVAILABLE$"):
            self.select([OSError("credential"), OSError("token"), OSError("payload")])

    def test_real_transport_retry_budget_is_three_not_nine(self):
        with patch.object(daily.urllib.request, "urlopen", side_effect=OSError("secret")) as request:
            with self.assertRaisesRegex(daily.Error, "YAHOO_SOURCE_UNAVAILABLE"):
                daily.select_yahoo_payload(self.url, "2026-09-30")
            self.assertEqual(request.call_count, 3)

    def test_collection_uses_complete_third_response_without_modifying_inputs(self):
        payloads = [self.missing(-2), self.missing(-3), self.complete]
        before = copy.deepcopy(payloads)
        calls = []
        def fetch(url):
            if "yahoo" in url:
                calls.append(url)
                return payloads[len(calls) - 1]
            return self.source.fetch(url)
        data, _ = daily.collect(self.source.historical, self.source.prior, self.source.policy,
                                self.source.now, fetch)
        self.assertEqual(len(calls), 3)
        self.assertEqual(data["metadata"]["source_receipts_sha256"]["yahoo"], daily.digest(self.complete))
        self.assertEqual(data["item"]["rows"][-1]["date"], "2026-09-30")
        self.assertEqual(payloads, before)


if __name__ == "__main__":
    unittest.main()
