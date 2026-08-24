import importlib.util
import unittest
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("futures_source_v2", ROOT / "scripts" / "update_futures_position.py")
FUTURES = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(FUTURES)


def source_rows(data_date: str, *, foreign_short: int = 250, tmf_total: int = 1500):
    institutions = []
    for product in ("臺股期貨", "小型臺指期貨", "微型臺指期貨"):
        for item, long_value, short_value in (("自營商", 100, 120), ("投信", 20, 10), ("外資及陸資", 300, foreign_short if product == "臺股期貨" else 250)):
            institutions.append({
                "Date": data_date.replace("-", ""), "ContractCode": product, "Item": item,
                "OpenInterest(Long)": str(long_value), "OpenInterest(Short)": str(short_value),
                "OpenInterest(Net)": str(long_value - short_value),
            })
    daily = []
    for contract, total in (("MTX", 1500), ("TMF", tmf_total)):
        daily.append({"Date": data_date.replace("-", ""), "Contract": contract, "ContractMonth(Week)": "202609", "TradingSession": "一般", "OpenInterest": str(total)})
    return institutions, daily


class FuturesSourceV2Tests(unittest.TestCase):
    def test_primary_current(self):
        result, status, _ = FUTURES.resolve_official_candidate("2026-08-21", [("TAIFEX_PRIMARY", lambda: source_rows("2026-08-21"))])
        self.assertEqual(status, FUTURES.SOURCE_CURRENT)
        self.assertEqual(result["data_date"], "2026-08-21")

    def test_official_csv_fallback_when_primary_not_ready(self):
        result, status, _ = FUTURES.resolve_official_candidate("2026-08-21", [
            ("TAIFEX_PRIMARY", lambda: source_rows("2026-08-20")),
            ("TAIFEX_OFFICIAL_CSV", lambda: source_rows("2026-08-21")),
        ])
        self.assertEqual(status, FUTURES.SOURCE_FALLBACK)
        self.assertEqual(result["provider"], "TAIFEX_OFFICIAL_CSV")

    def test_timeout_uses_official_fallback(self):
        def timed_out():
            raise TimeoutError("fixture")
        result, status, _ = FUTURES.resolve_official_candidate("2026-08-21", [
            ("TAIFEX_PRIMARY", timed_out), ("TAIFEX_OFFICIAL_CSV", lambda: source_rows("2026-08-21")),
        ])
        self.assertEqual(status, FUTURES.SOURCE_FALLBACK)
        self.assertEqual(result["data_date"], "2026-08-21")

    def test_all_official_source_failures_are_update_failed(self):
        def unavailable():
            raise TimeoutError("fixture")

        result, status, _ = FUTURES.resolve_official_candidate("2026-08-21", [
            ("TAIFEX_PRIMARY", unavailable),
            ("TAIFEX_OFFICIAL_CSV", unavailable),
            ("DATA_GOV_OFFICIAL", unavailable),
        ])
        self.assertIsNone(result)
        self.assertEqual(status, FUTURES.UPDATE_FAILED)

    def test_all_official_sources_not_ready_preserves_old_candidate(self):
        result, status, _ = FUTURES.resolve_official_candidate("2026-08-21", [
            ("TAIFEX_PRIMARY", lambda: source_rows("2026-08-19")),
            ("TAIFEX_OFFICIAL_CSV", lambda: source_rows("2026-08-19")),
            ("DATA_GOV_OFFICIAL", lambda: source_rows("2026-08-19")),
        ])
        self.assertEqual(status, FUTURES.SOURCE_NOT_READY)
        self.assertEqual(result["data_date"], "2026-08-19")

    def test_same_date_official_conflict_is_fail_closed(self):
        result, status, _ = FUTURES.resolve_official_candidate("2026-08-21", [
            ("TAIFEX_PRIMARY", lambda: source_rows("2026-08-20", foreign_short=250)),
            ("TAIFEX_OFFICIAL_CSV", lambda: source_rows("2026-08-20", foreign_short=251)),
        ])
        self.assertIsNone(result)
        self.assertEqual(status, FUTURES.SOURCE_CONFLICT)

    def test_mixed_dates_never_form_an_observation(self):
        institutional, _ = source_rows("2026-08-21")
        _, daily = source_rows("2026-08-20")
        with self.assertRaisesRegex(ValueError, "aligned trading date"):
            FUTURES.candidate_from_rows(institutional, daily, "fixture")

    def test_same_observation_signature_is_idempotent(self):
        a = FUTURES.candidate_from_rows(*source_rows("2026-08-21"), "TAIFEX_PRIMARY")
        b = FUTURES.candidate_from_rows(*source_rows("2026-08-21"), "TAIFEX_PRIMARY")
        self.assertEqual(FUTURES.candidate_signature(a), FUTURES.candidate_signature(b))

    def test_weekend_and_known_holiday_use_prior_trading_day(self):
        self.assertEqual(FUTURES.expected_trading_date(datetime.fromisoformat("2026-08-23T12:00:00+00:00")), "2026-08-21")
        self.assertEqual(FUTURES.expected_trading_date(datetime.fromisoformat("2026-02-23T01:00:00+00:00")), "2026-02-11")

    def test_official_csv_mappers_keep_required_contract_fields(self):
        institution = FUTURES.csv_institution_rows([{"日期": "20260821", "商品名稱": "臺股期貨", "身份別": "外資及陸資", "多方未平倉口數": "1", "空方未平倉口數": "2", "多空未平倉口數淨額": "-1"}])[0]
        daily = FUTURES.csv_daily_rows([{"日期": "20260821", "契約代號": "TMF", "到期月份(週別)": "202609", "未沖銷契約數": "10", "交易時段": "一般"}])[0]
        self.assertEqual(institution["OpenInterest(Net)"], "-1")
        self.assertEqual(daily["TradingSession"], "一般")

    def test_frontend_has_distinct_official_freshness_labels(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        for label in ("官方待更新", "官方備援來源", "更新異常", "futuresFreshnessLabel"):
            self.assertIn(label, html)


if __name__ == "__main__":
    unittest.main(verbosity=2)
