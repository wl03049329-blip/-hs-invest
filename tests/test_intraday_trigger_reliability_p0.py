from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path
from unittest import mock

from backend.artifact_publisher import GitHubArtifactPublisher
from backend.live_quotes import REQUIRED_SYMBOLS, TAIPEI, QuoteBatch
from backend.scheduler import C4_VERSION, ShadowScheduler
from backend.state_store import StateStore
from backend.trading_calendar import CalendarResult
from scripts import run_intraday_radar_session as runner
from scripts import update_market_quotes

ROOT = Path(__file__).resolve().parents[1]
NOW = datetime(2026, 9, 14, 10, 17, tzinfo=TAIPEI)


class TradingDay:
    def check(self, _: date) -> CalendarResult:
        return CalendarResult("TRADING_DAY", "trigger-test")


def batch(_: datetime = NOW) -> QuoteBatch:
    rows = {
        symbol: {
            "code": symbol, "name": symbol, "price": 100.0, "price_field": "z",
            "previous_close": 99.0, "date": NOW.date().isoformat(), "quote_time": "10:16:00",
            "market": "TWSE", "open": 99.0, "high": 101.0, "low": 98.0,
            "volume": 1000.0, "source": "https://mis.twse.com.tw/stock/api/getStockInfo.jsp",
            "quote_source": "MIS_Z",
        }
        for symbol in REQUIRED_SYMBOLS
    }
    return QuoteBatch(NOW.date().isoformat(), "10:17", NOW.isoformat(), rows,
                      {symbol: NOW.replace(minute=16).isoformat() for symbol in REQUIRED_SYMBOLS},
                      {symbol: "FRESH" for symbol in REQUIRED_SYMBOLS},
                      {symbol: "MIS_Z" for symbol in REQUIRED_SYMBOLS})


class Scorer:
    def score(self, quote_batch: QuoteBatch, calculated_at: str) -> dict:
        items = {symbol: {"status": "SUCCESS", "score": 50.0, "display_score": 50,
                          "delta_vs_previous_close": 0.0, "score_version": C4_VERSION,
                          "market_as_of": quote_batch.quote_timestamps[symbol]}
                 for symbol in REQUIRED_SYMBOLS}
        return {"status": "SUCCESS", "score_version": C4_VERSION, "input_fingerprint": "a" * 64,
                "snapshot": {"status": "SUCCESS", "score_version": C4_VERSION, "items": items}}


class PublisherSpy:
    def __init__(self) -> None:
        self.calls = 0

    def publish(self, **_):
        from backend.artifact_publisher import PublicationResult
        self.calls += 1
        return PublicationResult("DISPATCH_ACCEPTED")


class Response:
    status = 204
    def __enter__(self): return self
    def __exit__(self, *_): return False


class TriggerReliabilityTests(unittest.TestCase):
    def test_railway_primary_runs_without_github_schedule_delivery(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            publisher = PublisherSpy()
            scheduler = ShadowScheduler(StateStore(temporary), calendar=TradingDay(), quote_fetcher=batch,
                                        scorer=Scorer(), publisher=publisher, mode="production")
            self.assertEqual(asyncio.run(scheduler.tick(NOW)), "SUCCESS")
            self.assertEqual(publisher.calls, 1)
            self.assertEqual(scheduler.store.snapshot()["publication_status"], "DISPATCH_ACCEPTED")

    def test_dispatch_is_sanitized_and_missing_secret_is_non_crashing(self) -> None:
        quote_batch = batch()
        result = Scorer().score(quote_batch, NOW.isoformat())
        self.assertEqual(GitHubArtifactPublisher(token="").publish(batch=quote_batch, score_result=result, run_id="r", mode="production").status, "SECRET_MISSING")
        captured = {}
        def opener(request, timeout):
            captured["body"] = request.data.decode("utf-8")
            captured["authorization"] = request.headers.get("Authorization")
            return Response()
        status = GitHubArtifactPublisher(token="test-secret", opener=opener).publish(
            batch=quote_batch, score_result=result, run_id="r", mode="production")
        self.assertEqual(status.status, "DISPATCH_ACCEPTED")
        self.assertNotIn("test-secret", captured["body"])
        self.assertEqual(json.loads(captured["body"])["client_payload"]["trigger_source"], "RAILWAY_PRIMARY")

    def test_late_github_fallback_skips_existing_primary_slot(self) -> None:
        with mock.patch.object(runner, "canonical_slot_exists", return_value=True):
            called = []
            code = runner.run_scheduled_once(lambda: NOW, lambda *_: called.append(True), git_sync=False)
        self.assertEqual(code, 0)
        self.assertEqual(called, [])

    def test_github_fallback_can_fill_when_primary_is_absent(self) -> None:
        attempt = {"verified": True, "status": "success", "trading_date": "2026-09-14",
                   "slot": "10:17", "market_as_of": NOW.isoformat()}
        with mock.patch.object(runner, "canonical_slot_exists", return_value=False):
            code = runner.run_scheduled_once(lambda: NOW, lambda *_: (True, attempt), git_sync=False)
        self.assertEqual(code, 0)

    def test_workflow_contracts_keep_fallback_and_receiver_separate(self) -> None:
        fallback = (ROOT / ".github/workflows/update-market-quotes.yml").read_text(encoding="utf-8")
        receiver = (ROOT / ".github/workflows/publish-railway-live-artifacts.yml").read_text(encoding="utf-8")
        self.assertIn("schedule:", fallback)
        self.assertIn("HS_INTRADAY_TRIGGER: ${{ github.event_name }}", fallback)
        self.assertIn("repository_dispatch:", receiver)
        self.assertIn("hs_live_snapshot_ready", receiver)
        self.assertIn("cancel-in-progress: false", receiver)
        self.assertNotIn("update_market_quotes.py", receiver)

    def test_legacy_producer_reuses_shared_fugle_adapter(self) -> None:
        source = (ROOT / "scripts/update_market_quotes.py").read_text(encoding="utf-8")
        self.assertIn("from backend.live_quotes import apply_fugle_fallback", source)
        self.assertIn("FUGLE_API_KEY: ${{ secrets.FUGLE_API_KEY }}", (ROOT / ".github/workflows/update-market-quotes.yml").read_text(encoding="utf-8"))
        self.assertEqual(update_market_quotes.RADAR_REQUIRED_LIVE_SYMBOLS, REQUIRED_SYMBOLS)


if __name__ == "__main__":
    unittest.main(verbosity=2)
