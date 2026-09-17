"""Focused same-bucket retry and sanitized Volume telemetry guards."""

from __future__ import annotations

import asyncio
import contextlib
import io
import json
import tempfile
import unittest
from datetime import timedelta
from unittest import mock

from backend.artifact_publisher import PublicationResult
from backend.live_quotes import QuoteUnavailable, REQUIRED_SYMBOLS
from backend.scheduler import ShadowScheduler
from backend.state_store import StateStore
from tests.test_live_backend_production_cutover import NOW, Scorer, TradingDay, batch


class Publisher:
    def __init__(self, *statuses: str) -> None:
        self.statuses = list(statuses)
        self.calls = 0

    def publish(self, **_) -> PublicationResult:
        self.calls += 1
        return PublicationResult(self.statuses.pop(0) if self.statuses else "DISPATCH_ACCEPTED")


def attempt_rows(store: StateStore) -> list[dict]:
    return [json.loads(line) for line in store.attempt_path.read_text(encoding="utf-8").splitlines()]


class BucketRetryTests(unittest.TestCase):
    def test_a_first_success_locks_bucket_without_republication(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store, publisher, scorer = StateStore(temporary), Publisher(), Scorer()
            scheduler = ShadowScheduler(store, calendar=TradingDay(), quote_fetcher=batch,
                                        scorer=scorer, publisher=publisher, mode="production")
            self.assertEqual(asyncio.run(scheduler.tick(NOW)), "SUCCESS")
            self.assertEqual(asyncio.run(scheduler.tick(NOW + timedelta(seconds=30))), "DUPLICATE")
            self.assertEqual((publisher.calls, scorer.calls), (1, 1))
            self.assertEqual(sum(row["stage"] == "SUCCESS" for row in attempt_rows(store)), 1)

    def test_b_failed_quote_retries_then_only_one_success(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store, publisher, scorer = StateStore(temporary), Publisher(), Scorer()
            calls = 0
            def fetch(now):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise QuoteUnavailable("SECONDARY_UNAVAILABLE:00830:secret=never-log-me")
                return batch(now)
            scheduler = ShadowScheduler(store, calendar=TradingDay(), quote_fetcher=fetch,
                                        scorer=scorer, publisher=publisher, mode="production")
            self.assertEqual(asyncio.run(scheduler.tick(NOW)), "UNAVAILABLE")
            self.assertEqual(asyncio.run(scheduler.tick(NOW + timedelta(seconds=30))), "SUCCESS")
            self.assertEqual(asyncio.run(scheduler.tick(NOW + timedelta(minutes=1))), "DUPLICATE")
            self.assertEqual((calls, scorer.calls, publisher.calls), (2, 1, 1))
            self.assertEqual(len(store.parity_path.read_text(encoding="utf-8").splitlines()), 1)
            rows = attempt_rows(store)
            self.assertEqual([row["attempt"] for row in rows if row["stage"] == "STARTED" and row["status"] == "STARTED"], [1, 2])
            failed = next(row for row in rows if row["status"] == "FAILED")
            self.assertEqual((failed["error_class"], failed["symbol"], failed["dispatch_status"]),
                             ("SECONDARY_UNAVAILABLE", "00830", "NOT_ATTEMPTED"))
            self.assertNotIn("never-log-me", store.attempt_path.read_text(encoding="utf-8"))

    def test_c_two_retries_only_and_restart_keeps_limit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = StateStore(temporary)
            calls = 0
            def fail(_):
                nonlocal calls
                calls += 1
                raise QuoteUnavailable("INCOMPLETE_REQUIRED_QUOTES")
            scheduler = ShadowScheduler(store, calendar=TradingDay(), quote_fetcher=fail,
                                        scorer=Scorer(), publisher=Publisher(), mode="production")
            for seconds in (0, 30, 60):
                self.assertEqual(asyncio.run(scheduler.tick(NOW + timedelta(seconds=seconds))), "UNAVAILABLE")
            restarted = ShadowScheduler(StateStore(temporary), calendar=TradingDay(), quote_fetcher=fail,
                                        scorer=Scorer(), publisher=Publisher(), mode="production")
            self.assertEqual(asyncio.run(restarted.tick(NOW + timedelta(seconds=90))), "RETRY_EXHAUSTED")
            self.assertEqual(calls, 3)
            self.assertEqual(len([row for row in attempt_rows(store) if row["stage"] == "STARTED" and row["status"] == "STARTED"]), 3)

    def test_d_no_cross_bucket_backfill(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store, publisher = StateStore(temporary), Publisher()
            calls = 0
            def fetch(now):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise QuoteUnavailable("INCOMPLETE_REQUIRED_QUOTES")
                return batch(now)
            scheduler = ShadowScheduler(store, calendar=TradingDay(), quote_fetcher=fetch,
                                        scorer=Scorer(), publisher=publisher, mode="production")
            self.assertEqual(asyncio.run(scheduler.tick(NOW)), "UNAVAILABLE")
            self.assertEqual(asyncio.run(scheduler.tick(NOW + timedelta(minutes=5))), "SUCCESS")
            self.assertEqual(publisher.calls, 1)
            self.assertEqual(store.snapshot()["last_successful_run"]["run_id"], "2026-09-10T10:20+08:00")

    def test_e_f_wait_native_and_five_of_five_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store, publisher = StateStore(temporary), Publisher()
            scheduler = ShadowScheduler(store, calendar=TradingDay(), quote_fetcher=lambda now: batch(now, count=4),
                                        scorer=Scorer(), publisher=publisher, mode="production")
            self.assertEqual(asyncio.run(scheduler.tick(NOW)), "UNAVAILABLE")
            self.assertEqual(publisher.calls, 0)
            self.assertEqual(store.public_state(NOW)["tickers"]["009815"]["status"], "WAIT_NATIVE")
            self.assertTrue(all(store.public_state(NOW)["tickers"][symbol]["score"] is None for symbol in REQUIRED_SYMBOLS))

    def test_g_dispatch_failure_retries_without_duplicate_success(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store, publisher = StateStore(temporary), Publisher("DISPATCH_FAILED", "DISPATCH_ACCEPTED")
            scheduler = ShadowScheduler(store, calendar=TradingDay(), quote_fetcher=batch,
                                        scorer=Scorer(), publisher=publisher, mode="production")
            self.assertEqual(asyncio.run(scheduler.tick(NOW)), "UNAVAILABLE")
            self.assertEqual(store.public_state(NOW)["status"], "UNAVAILABLE")
            self.assertEqual(asyncio.run(scheduler.tick(NOW + timedelta(seconds=30))), "SUCCESS")
            self.assertEqual(asyncio.run(scheduler.tick(NOW + timedelta(seconds=60))), "DUPLICATE")
            self.assertEqual(publisher.calls, 2)
            self.assertEqual(len(store.parity_path.read_text(encoding="utf-8").splitlines()), 1)
            self.assertEqual([row["dispatch_status"] for row in attempt_rows(store) if row["status"] == "FAILED"],
                             ["DISPATCH_FAILED"])

    def test_h_telemetry_is_allowlisted_and_runtime_only(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = StateStore(temporary)
            store.append_attempt({"bucket": "x", "mode": "production", "attempt": 1, "stage": "STARTED", "status": "STARTED",
                                  "secret": "secret-never-log", "raw_provider_payload": {"price": 1},
                                  "auth_header": "Bearer secret-never-log"})
            serialized = store.attempt_path.read_text(encoding="utf-8")
            self.assertNotIn("secret-never-log", serialized)
            self.assertNotIn("raw_provider_payload", serialized)
            self.assertEqual(store.attempt_count("x", "production"), 1)

    def test_i_telemetry_io_failure_does_not_block_success_and_is_sanitized(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store, publisher = StateStore(temporary), Publisher()
            store.append_attempt = lambda _: (_ for _ in ()).throw(OSError("secret raw payload"))
            scheduler = ShadowScheduler(store, calendar=TradingDay(), quote_fetcher=batch,
                                        scorer=Scorer(), publisher=publisher, mode="production")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                self.assertEqual(asyncio.run(scheduler.tick(NOW)), "SUCCESS")
            self.assertEqual(store.snapshot()["last_successful_run"]["run_id"], "2026-09-10T10:15+08:00")
            self.assertEqual(publisher.calls, 1)
            self.assertIn("SCHEDULER_ATTEMPT_TELEMETRY_FAILED error_class=OSError", stderr.getvalue())
            self.assertNotIn("secret", stderr.getvalue())
            self.assertNotIn("payload", stderr.getvalue())

    def test_j_telemetry_io_failure_preserves_formal_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = StateStore(temporary)
            store.append_attempt = lambda _: (_ for _ in ()).throw(OSError("do not expose"))
            scheduler = ShadowScheduler(
                store, calendar=TradingDay(),
                quote_fetcher=lambda _: (_ for _ in ()).throw(QuoteUnavailable("INCOMPLETE_REQUIRED_QUOTES")),
                scorer=Scorer(), publisher=Publisher(), mode="production",
            )
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(asyncio.run(scheduler.tick(NOW)), "UNAVAILABLE")
            self.assertIsNone(store.snapshot().get("last_successful_run"))
            self.assertEqual(store.public_state(NOW)["status"], "UNAVAILABLE")

    def test_k_run_forever_continues_after_telemetry_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store, publisher = StateStore(temporary), Publisher()
            store.append_attempt = lambda _: (_ for _ in ()).throw(OSError("telemetry unavailable"))
            fetch_calls = 0
            def fetch(now):
                nonlocal fetch_calls
                fetch_calls += 1
                if fetch_calls == 1:
                    raise QuoteUnavailable("INCOMPLETE_REQUIRED_QUOTES")
                return batch(now)
            class FixedScheduler(ShadowScheduler):
                tick_calls = 0
                async def tick(self, now=None):
                    fixed_now = NOW + timedelta(seconds=30 * self.tick_calls)
                    self.tick_calls += 1
                    return await super().tick(fixed_now)
            scheduler = FixedScheduler(store, calendar=TradingDay(), quote_fetcher=fetch,
                                       scorer=Scorer(), publisher=publisher, mode="production")
            sleep_calls = 0
            class StopLoop(Exception):
                pass
            async def controlled_sleep(_):
                nonlocal sleep_calls
                sleep_calls += 1
                if sleep_calls == 2:
                    raise StopLoop
            async def exercise():
                with mock.patch("backend.scheduler.asyncio.sleep", new=controlled_sleep), contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaises(StopLoop):
                        await scheduler.run_forever()
            asyncio.run(exercise())
            self.assertEqual(fetch_calls, 2)
            self.assertEqual(publisher.calls, 1)
            self.assertEqual(store.snapshot()["last_successful_run"]["run_id"], "2026-09-10T10:15+08:00")

    def test_l_telemetry_failure_keeps_restart_attempt_limit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            calls = 0
            def fail(_):
                nonlocal calls
                calls += 1
                raise QuoteUnavailable("INCOMPLETE_REQUIRED_QUOTES")
            for expected_attempt in (1, 2, 3):
                store = StateStore(temporary)
                store.append_attempt = lambda _: (_ for _ in ()).throw(OSError("telemetry unavailable"))
                scheduler = ShadowScheduler(store, calendar=TradingDay(), quote_fetcher=fail,
                                            scorer=Scorer(), publisher=Publisher(), mode="production")
                with contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(asyncio.run(scheduler.tick(NOW + timedelta(seconds=expected_attempt))), "UNAVAILABLE")
                self.assertEqual(store.snapshot()["attempt_control"]["count"], expected_attempt)
            store = StateStore(temporary)
            store.append_attempt = lambda _: (_ for _ in ()).throw(OSError("telemetry unavailable"))
            scheduler = ShadowScheduler(store, calendar=TradingDay(), quote_fetcher=fail,
                                        scorer=Scorer(), publisher=Publisher(), mode="production")
            self.assertEqual(asyncio.run(scheduler.tick(NOW + timedelta(seconds=4))), "RETRY_EXHAUSTED")
            self.assertEqual(calls, 3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
