"""Forward-only service recovery across the 10/9 holiday; no price/scoring edits."""
from __future__ import annotations

import asyncio
import tempfile
import unittest
from datetime import date, datetime

from backend.live_quotes import TAIPEI, validate_rows, production_mis
from backend.scheduler import ShadowScheduler
from backend.state_store import StateStore
from backend.trading_calendar import CalendarResult
from test_live_backend_production_cutover import batch, Scorer
from test_intraday_trigger_reliability_p0 import PublisherSpy


class HolidayCalendar:
    def check(self, target: date) -> CalendarResult:
        return CalendarResult("HOLIDAY" if target.isoformat() == "2026-10-09" else "TRADING_DAY", "fixture-calendar")


def at(day: str, hour: int = 10) -> datetime:
    return datetime.fromisoformat(day).replace(hour=hour, minute=5, tzinfo=TAIPEI)


class IntradayServiceResumeTests(unittest.TestCase):
    def test_holiday_then_current_session_never_backfills_missed_buckets(self):
        with tempfile.TemporaryDirectory() as temporary:
            captures = []
            def quotes(now):
                captures.append(now.isoformat())
                return batch(now)
            publisher = PublisherSpy()
            store = StateStore(temporary)
            scheduler = ShadowScheduler(store, calendar=HolidayCalendar(), quote_fetcher=quotes,
                                        scorer=Scorer(), publisher=publisher, mode="production")
            self.assertEqual(asyncio.run(scheduler.tick(at("2026-10-08"))), "SUCCESS")
            self.assertEqual(asyncio.run(scheduler.tick(at("2026-10-09"))), "HOLIDAY")
            self.assertEqual(asyncio.run(scheduler.tick(at("2026-10-12"))), "SUCCESS")
            self.assertEqual(captures, [at("2026-10-08").isoformat(), at("2026-10-12").isoformat()])
            self.assertEqual(publisher.calls, 2)
            self.assertEqual(store.snapshot()["last_successful_run"]["run_id"], "2026-10-12T10:05+08:00")
            self.assertEqual(asyncio.run(scheduler.tick(at("2026-10-12"))), "DUPLICATE")
            self.assertEqual(publisher.calls, 2)

    def test_resumed_service_after_close_never_collects_or_replays(self):
        with tempfile.TemporaryDirectory() as temporary:
            captures = []
            scheduler = ShadowScheduler(StateStore(temporary), calendar=HolidayCalendar(),
                quote_fetcher=lambda now: captures.append(now) or batch(now), scorer=Scorer(), mode="production")
            self.assertEqual(asyncio.run(scheduler.tick(at("2026-10-12", 19))), "CLOSED")
            self.assertEqual(captures, [])

    def test_missing_scheduler_leaves_old_success_unavailable_on_reopen(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = StateStore(temporary)
            scheduler = ShadowScheduler(store, calendar=HolidayCalendar(), quote_fetcher=batch,
                                        scorer=Scorer(), publisher=PublisherSpy(), mode="production")
            self.assertEqual(asyncio.run(scheduler.tick(at("2026-10-08"))), "SUCCESS")
            public = store.public_state(at("2026-10-12"), expected_mode="production")
            self.assertEqual(public["status"], "UNAVAILABLE")
            self.assertTrue(all(row["score"] is None for row in public["tickers"].values()))

    def test_old_or_incomplete_source_cannot_publish_today(self):
        for quote_batch in [batch(at("2026-10-08")), batch(at("2026-10-12"), count=4),
                            batch(at("2026-10-12"), age_minutes=11)]:
            with self.subTest(date=quote_batch.trading_date, completeness=quote_batch.completeness), tempfile.TemporaryDirectory() as temporary:
                publisher = PublisherSpy()
                # Exercise the real collector boundary, not a mock that bypasses
                # validation and hands an already-typed QuoteBatch to the scorer.
                def quotes(now):
                    rows = [{"code": symbol, "date": quote_batch.trading_date,
                        "quote_time": datetime.fromisoformat(quote_batch.quote_timestamps[symbol]).strftime("%H:%M:%S"),
                        "price": 100, "previous_close": 100, "open": 100, "high": 101, "low": 99,
                        "volume": 1000, "market": "TWSE", "quote_mode": "delayed",
                        "source": production_mis.TWSE_MIS_URL, "price_field": "z", "quote_source": "MIS_Z"}
                        for symbol in quote_batch.items]
                    return validate_rows(rows, now)
                scheduler = ShadowScheduler(StateStore(temporary), calendar=HolidayCalendar(),
                    quote_fetcher=quotes, scorer=Scorer(), publisher=publisher, mode="production")
                self.assertEqual(asyncio.run(scheduler.tick(at("2026-10-12"))), "UNAVAILABLE")
                self.assertEqual(publisher.calls, 0)


if __name__ == "__main__":
    unittest.main()
