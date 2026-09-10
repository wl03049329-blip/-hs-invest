from __future__ import annotations

import asyncio
import hashlib
import os
import subprocess
import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path
from unittest import mock

from backend.live_quotes import REQUIRED_SYMBOLS, TAIPEI, QuoteBatch
from backend.runtime_mode import resolve_backend_mode
from backend.scheduler import C4_VERSION, ShadowScheduler
from backend.state_store import StateStore
from backend.trading_calendar import CalendarResult

ROOT = Path(__file__).resolve().parents[1]
NOW = datetime(2026, 9, 10, 10, 17, tzinfo=TAIPEI)


class TradingDay:
    def check(self, _: date) -> CalendarResult:
        return CalendarResult("TRADING_DAY", "cutover-test")


class Holiday:
    def check(self, _: date) -> CalendarResult:
        return CalendarResult("HOLIDAY", "cutover-test", "HOLIDAY")


def batch(now: datetime = NOW, *, count: int = 5, age_minutes: int = 0, date_value: str | None = None) -> QuoteBatch:
    quote_at = now - timedelta(minutes=age_minutes)
    symbols = REQUIRED_SYMBOLS[:count]
    return QuoteBatch(
        trading_date=date_value or now.date().isoformat(), slot=now.strftime("%H:%M"), captured_at=now.isoformat(),
        items={symbol: {"code": symbol} for symbol in symbols},
        quote_timestamps={symbol: quote_at.isoformat() for symbol in symbols},
        freshness={symbol: "FRESH" for symbol in symbols},
        sources={symbol: "MIS_Z" for symbol in symbols},
    )


class Scorer:
    def __init__(self, *, version: str = C4_VERSION, missing: str | None = None) -> None:
        self.version = version
        self.missing = missing
        self.calls = 0

    def score(self, quote_batch: QuoteBatch, calculated_at: str) -> dict:
        self.calls += 1
        items = {
            symbol: {"status": "SUCCESS", "score": 40.25 + index, "display_score": 40 + index, "delta_vs_previous_close": index / 10}
            for index, symbol in enumerate(REQUIRED_SYMBOLS) if symbol != self.missing
        }
        return {"status": "SUCCESS", "score_version": self.version, "input_fingerprint": "b" * 64, "snapshot": {"score_version": self.version, "items": items}}


def successful_public(now: datetime = NOW) -> dict:
    tickers = {
        symbol: {"score": 40, "display_score": 40, "delta_vs_official": 1, "quote_as_of": now.isoformat(), "freshness": "FRESH", "quote_source": "MIS_Z", "status": "AVAILABLE"}
        for symbol in REQUIRED_SYMBOLS
    }
    tickers["009815"] = {"score": None, "display_score": None, "delta_vs_official": None, "quote_as_of": None, "freshness": "WAIT_NATIVE", "quote_source": None, "status": "WAIT_NATIVE"}
    return {"schema_version": 1, "status": "AVAILABLE", "market_state": "OPEN", "trading_date": now.date().isoformat(), "as_of": now.isoformat(), "calculated_at": now.isoformat(), "last_success_at": now.isoformat(), "completeness": "5/5", "diagnostic_reason": None, "c4_version": C4_VERSION, "tickers": tickers}


class ProductionModeTests(unittest.TestCase):
    def test_01_shadow_mode_starts_and_is_default(self) -> None:
        self.assertEqual(resolve_backend_mode("shadow"), "shadow")
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(resolve_backend_mode(), "shadow")

    def test_02_production_mode_starts_with_same_scheduler(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            scheduler = ShadowScheduler(StateStore(temporary), calendar=TradingDay(), quote_fetcher=batch, scorer=Scorer(), mode="production")
            self.assertEqual(asyncio.run(scheduler.tick(NOW)), "SUCCESS")
            state = scheduler.store.snapshot()
            self.assertEqual(state["mode"], "production")
            self.assertEqual(state["c4_version"], C4_VERSION)

    def test_03_illegal_mode_fails_startup(self) -> None:
        with self.assertRaises(RuntimeError):
            resolve_backend_mode("unsafe")

    def test_04_bucket_dedupe_and_05_gap_detection(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            scorer = Scorer()
            scheduler = ShadowScheduler(StateStore(temporary), calendar=TradingDay(), quote_fetcher=batch, scorer=scorer)
            self.assertEqual(asyncio.run(scheduler.tick(NOW)), "SUCCESS")
            self.assertEqual(asyncio.run(scheduler.tick(NOW.replace(minute=19))), "DUPLICATE")
            self.assertEqual(asyncio.run(scheduler.tick(NOW.replace(minute=32))), "SUCCESS")
            self.assertEqual(scheduler.store.snapshot()["scheduler_gap"]["missed_buckets"], 2)

    def test_06_five_of_five_success_and_wait_native(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            scheduler = ShadowScheduler(StateStore(temporary), calendar=TradingDay(), quote_fetcher=batch, scorer=Scorer(), mode="production")
            self.assertEqual(asyncio.run(scheduler.tick(NOW)), "SUCCESS")
            public = scheduler.store.public_state(NOW)
            self.assertEqual(public["completeness"], "5/5")
            self.assertTrue(all(public["tickers"][symbol]["status"] == "AVAILABLE" for symbol in REQUIRED_SYMBOLS))
            self.assertEqual(public["tickers"]["009815"]["status"], "WAIT_NATIVE")

    def test_07_four_of_five_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            scheduler = ShadowScheduler(StateStore(temporary), calendar=TradingDay(), quote_fetcher=lambda _: batch(count=4), scorer=Scorer())
            self.assertEqual(asyncio.run(scheduler.tick(NOW)), "UNAVAILABLE")
            self.assertEqual(scheduler.store.public_state(NOW)["status"], "UNAVAILABLE")

    def test_08_stale_09_future_and_10_wrong_date_fail_closed(self) -> None:
        for label in ("stale", "future", "wrong-date"):
            with self.subTest(label=label), tempfile.TemporaryDirectory() as temporary:
                store = StateStore(temporary)
                public = successful_public()
                if label == "wrong-date":
                    public["trading_date"] = "2026-09-09"
                else:
                    quote_at = (NOW - timedelta(minutes=11)).isoformat() if label == "stale" else (NOW + timedelta(seconds=1)).isoformat()
                    for symbol in REQUIRED_SYMBOLS:
                        public["tickers"][symbol]["quote_as_of"] = quote_at
                store.save({"schema_version": 1, "mode": "production", "current_public_state": public})
                self.assertEqual(store.public_state(NOW)["status"], "UNAVAILABLE")

    def test_11_market_closed_does_not_fetch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            scorer = Scorer()
            scheduler = ShadowScheduler(StateStore(temporary), calendar=TradingDay(), quote_fetcher=batch, scorer=scorer)
            self.assertEqual(asyncio.run(scheduler.tick(NOW.replace(hour=14))), "CLOSED")
            self.assertEqual(scorer.calls, 0)

    def test_12_restart_reloads_last_successful_run(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = StateStore(temporary)
            scheduler = ShadowScheduler(store, calendar=TradingDay(), quote_fetcher=batch, scorer=Scorer(), mode="production")
            self.assertEqual(asyncio.run(scheduler.tick(NOW)), "SUCCESS")
            self.assertEqual(StateStore(temporary).snapshot()["last_successful_run"], store.snapshot()["last_successful_run"])

    def test_13_railway_without_volume_mount_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temporary, mock.patch.dict(os.environ, {"RAILWAY_ENVIRONMENT_ID": "prod", "HS_LIVE_VOLUME_PATH": temporary}, clear=True):
            with self.assertRaises(RuntimeError):
                StateStore()

    def test_14_version_mismatch_and_15_missing_result_symbol_fail(self) -> None:
        for scorer in (Scorer(version="WRONG"), Scorer(missing="00830")):
            with tempfile.TemporaryDirectory() as temporary:
                scheduler = ShadowScheduler(StateStore(temporary), calendar=TradingDay(), quote_fetcher=batch, scorer=scorer)
                self.assertEqual(asyncio.run(scheduler.tick(NOW)), "UNAVAILABLE")
                self.assertEqual(scheduler.store.public_state(NOW)["status"], "UNAVAILABLE")

    def test_16_readiness_is_sanitized_and_complete(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = StateStore(temporary)
            scheduler = ShadowScheduler(store, calendar=TradingDay(), quote_fetcher=batch, scorer=Scorer(), mode="production")
            self.assertEqual(asyncio.run(scheduler.tick(NOW)), "SUCCESS")
            readiness = store.readiness(NOW, backend_mode="production", current_bucket="2026-09-10T10:15+08:00")
            self.assertEqual(readiness["backend_mode"], "production")
            self.assertEqual(readiness["required_symbols"], list(REQUIRED_SYMBOLS))
            self.assertEqual(readiness["c4_version"], C4_VERSION)
            self.assertEqual(set(readiness["quote_sources"].values()), {"MIS_Z"})
            self.assertNotIn("FUGLE_API_KEY", str(readiness))

    def test_17_production_writes_only_runtime_volume(self) -> None:
        tracked = subprocess.check_output(["git", "ls-files"], cwd=ROOT, text=True).splitlines()
        protected_tokens = ("finalized", "forward", "00631l", "ad-hoc", "ad_hoc", "intraday-core-snapshots", "provenance")
        protected = [ROOT / name for name in tracked if any(token in name.lower() for token in protected_tokens)]
        before = {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in protected}
        with tempfile.TemporaryDirectory() as temporary:
            scheduler = ShadowScheduler(StateStore(temporary), calendar=TradingDay(), quote_fetcher=batch, scorer=Scorer(), mode="production")
            self.assertEqual(asyncio.run(scheduler.tick(NOW)), "SUCCESS")
            names = {path.name for path in Path(temporary).iterdir()}
            self.assertTrue(names <= {"live-state.json", "shadow-parity.jsonl", "history-cache", "scheduler.lock"})
        self.assertEqual(before, {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in protected})

    def test_18_production_health_endpoint_exposes_readiness_without_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as temporary, mock.patch.dict(os.environ, {"HS_LIVE_VOLUME_PATH": temporary, "HS_LIVE_DISABLE_SCHEDULER": "1"}):
            from backend.app import create_app

            store = StateStore(temporary)
            scheduler = ShadowScheduler(store, calendar=TradingDay(), quote_fetcher=batch, scorer=Scorer(), mode="production")
            self.assertEqual(asyncio.run(scheduler.tick(NOW)), "SUCCESS")
            instance = create_app(store, scheduler, backend_mode="production")
            health = next(route.endpoint for route in instance.routes if route.path == "/healthz")()
            required = {"backend_mode", "service_status", "market_state", "trading_date", "current_bucket", "last_attempted_run", "last_successful_run", "completeness", "required_symbols", "quote_timestamps", "quote_freshness", "quote_sources", "input_fingerprint", "c4_version", "scheduler_gap", "age_since_last_success_seconds", "volume_status"}
            self.assertTrue(required <= health.keys())
            self.assertEqual((health["backend_mode"], health["c4_version"]), ("production", C4_VERSION))
            self.assertNotIn("FUGLE_API_KEY", str(health))

    def test_19_production_does_not_publish_persisted_shadow_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = StateStore(temporary)
            store.save({"schema_version": 1, "mode": "shadow", "current_public_state": successful_public(), "last_attempted_run": {"run_id": "2026-09-10T10:15+08:00", "at": NOW.isoformat(), "status": "SUCCESS"}})
            self.assertEqual(store.public_state(NOW, expected_mode="production")["diagnostic_reason"], "BACKEND_MODE_STATE_MISMATCH")
            scheduler = ShadowScheduler(store, calendar=TradingDay(), quote_fetcher=batch, scorer=Scorer(), mode="production")
            self.assertEqual(asyncio.run(scheduler.tick(NOW)), "SUCCESS")
            self.assertEqual(store.public_state(NOW, expected_mode="production")["status"], "AVAILABLE")


if __name__ == "__main__":
    unittest.main(verbosity=2)
