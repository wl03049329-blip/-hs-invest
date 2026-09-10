from __future__ import annotations

import asyncio
import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path
from unittest import mock

from backend.live_quotes import (
    REQUIRED_SYMBOLS,
    TAIPEI,
    QuoteBatch,
    QuoteUnavailable,
    parse_mis_row,
    validate_rows,
)
from scripts import update_market_quotes as production_mis
from backend.scheduler import C4_VERSION, ShadowScheduler, bucket_run_id, five_minute_bucket
from backend.state_store import StateStore
from backend.trading_calendar import CalendarResult, TradingCalendar

ROOT = Path(__file__).resolve().parents[1]


def raw_row(symbol: str, *, day: str = "20260907", quote_time: str = "10:16:30", z: str = "100", pz: str = "99") -> dict:
    return {
        "c": symbol, "n": symbol, "ex": "tse", "d": day, "t": quote_time,
        "z": z, "pz": pz, "y": "98", "o": "99", "h": "102", "l": "97", "v": "1000",
    }


def parsed_rows(now: datetime, count: int = 5, *, minutes_old: int = 0, use_pz: bool = False) -> list[dict]:
    quote_at = now.replace(second=0, microsecond=0)
    quote_at = quote_at.replace(minute=quote_at.minute - minutes_old)
    output = []
    for symbol in REQUIRED_SYMBOLS[:count]:
        parsed, reason = parse_mis_row(raw_row(
            symbol, day=now.strftime("%Y%m%d"), quote_time=quote_at.strftime("%H:%M:%S"),
            z="-" if use_pz else "100", pz="100",
        ), required=True)
        assert reason is None and parsed
        output.append(parsed)
    return output


class AlwaysTrading:
    def check(self, _: date) -> CalendarResult:
        return CalendarResult("TRADING_DAY", "test-calendar")


class Holiday:
    def check(self, _: date) -> CalendarResult:
        return CalendarResult("HOLIDAY", "test-calendar", "TWSE_HOLIDAY_SCHEDULE")


class FakeScorer:
    def __init__(self, *, fail: bool = False, version: str = C4_VERSION) -> None:
        self.calls = 0
        self.fail = fail
        self.version = version

    def score(self, batch: QuoteBatch, calculated_at: str) -> dict:
        self.calls += 1
        if self.fail:
            raise RuntimeError("synthetic C4 failure")
        items = {
            symbol: {
                "status": "SUCCESS", "score": 40.125 + index, "display_score": str(40 + index),
                "delta_vs_previous_close": 0.125 + index,
            }
            for index, symbol in enumerate(REQUIRED_SYMBOLS)
        }
        return {
            "status": "SUCCESS", "score_version": self.version, "input_fingerprint": "a" * 64,
            "snapshot": {"score_version": self.version, "items": items},
        }


def batch_for(now: datetime) -> QuoteBatch:
    timestamps = {symbol: now.isoformat() for symbol in REQUIRED_SYMBOLS}
    return QuoteBatch(
        trading_date=now.date().isoformat(), slot=now.strftime("%H:%M"), captured_at=now.isoformat(),
        items={symbol: {"code": symbol} for symbol in REQUIRED_SYMBOLS}, quote_timestamps=timestamps,
        freshness={symbol: "FRESH" for symbol in REQUIRED_SYMBOLS},
    )


class LiveQuoteContractTests(unittest.TestCase):
    def test_a_z_valid_wins(self) -> None:
        self.assertIs(parse_mis_row, production_mis.parse_mis_row)
        parsed, reason = parse_mis_row(raw_row("0050", z="101", pz="99"), required=True)
        self.assertIsNone(reason)
        self.assertEqual((parsed["price"], parsed["price_field"]), (101.0, "z"))

    def test_b_pz_valid_fallback(self) -> None:
        parsed, reason = parse_mis_row(raw_row("0050", z="-", pz="99"), required=True)
        self.assertIsNone(reason)
        self.assertEqual((parsed["price"], parsed["price_field"]), (99.0, "pz"))
        now = datetime(2026, 9, 7, 10, 17, tzinfo=TAIPEI)
        self.assertEqual(validate_rows(parsed_rows(now, use_pz=True), now).completeness, "5/5")

    def test_c_invalid_stale_previous_and_future_pz_rejected(self) -> None:
        invalid, reason = parse_mis_row(raw_row("0050", z="-", pz="--"), required=True)
        self.assertIsNone(invalid)
        self.assertIn(reason, {"missing_price", "invalid_price"})
        now = datetime(2026, 9, 7, 10, 17, tzinfo=TAIPEI)
        with self.assertRaises(QuoteUnavailable):
            validate_rows(parsed_rows(now, minutes_old=11, use_pz=True), now)
        previous = parsed_rows(now, use_pz=True)
        previous[0]["date"] = "2026-09-06"
        with self.assertRaises(QuoteUnavailable):
            validate_rows(previous, now)
        future = parsed_rows(now, use_pz=True)
        future[0]["quote_time"] = "10:18:00"
        with self.assertRaises(QuoteUnavailable):
            validate_rows(future, now)

    def test_d_five_of_five_publishable_and_freshness_thresholds(self) -> None:
        now = datetime(2026, 9, 7, 10, 17, tzinfo=TAIPEI)
        self.assertEqual(validate_rows(parsed_rows(now), now).completeness, "5/5")
        delayed = validate_rows(parsed_rows(now, minutes_old=8), now)
        self.assertEqual(set(delayed.freshness.values()), {"DELAYED"})

    def test_e_four_of_five_unavailable(self) -> None:
        now = datetime(2026, 9, 7, 10, 17, tzinfo=TAIPEI)
        with self.assertRaises(QuoteUnavailable):
            validate_rows(parsed_rows(now, count=4), now)


class CalendarAndSchedulerTests(unittest.TestCase):
    def test_f_g_floor_scheduler_buckets(self) -> None:
        for hour, minute, expected in ((10, 17, "10:15"), (11, 43, "11:40")):
            now = datetime(2026, 9, 7, hour, minute, tzinfo=TAIPEI)
            self.assertEqual(five_minute_bucket(now).strftime("%H:%M"), expected)
            self.assertTrue(bucket_run_id(now).endswith(expected + "+08:00"))

    def test_calendar_uses_official_rows_and_fails_closed(self) -> None:
        holiday = TradingCalendar(lambda: [{"Date": "20260907", "Name": "市場無交易", "Description": "休市"}])
        self.assertEqual(holiday.check(date(2026, 9, 7)).status, "HOLIDAY")
        unavailable = TradingCalendar(lambda: (_ for _ in ()).throw(OSError("offline")))
        self.assertEqual(unavailable.check(date(2026, 9, 7)).status, "UNKNOWN")

    def test_h_duplicate_and_i_restart_current_bucket(self) -> None:
        now = datetime(2026, 9, 7, 10, 17, tzinfo=TAIPEI)
        with tempfile.TemporaryDirectory() as temporary:
            store = StateStore(temporary)
            scorer = FakeScorer()
            scheduler = ShadowScheduler(store, calendar=AlwaysTrading(), quote_fetcher=batch_for, scorer=scorer)
            self.assertEqual(asyncio.run(scheduler.tick(now)), "SUCCESS")
            public = store.snapshot()["current_public_state"]
            self.assertEqual(set(public["tickers"]), {*REQUIRED_SYMBOLS, "009815"})
            self.assertEqual(public["tickers"]["009815"]["status"], "WAIT_NATIVE")
            self.assertNotIn("00631L", public["tickers"])
            self.assertEqual(asyncio.run(scheduler.tick(now.replace(minute=19))), "DUPLICATE")
            self.assertEqual(scorer.calls, 1)
            restarted_scorer = FakeScorer()
            restarted = ShadowScheduler(StateStore(temporary), calendar=AlwaysTrading(), quote_fetcher=batch_for, scorer=restarted_scorer)
            self.assertEqual(asyncio.run(restarted.tick(now.replace(minute=22))), "SUCCESS")
            self.assertEqual(restarted_scorer.calls, 1)

    def test_j_closed_and_k_holiday_do_not_publish(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            scorer = FakeScorer()
            closed = ShadowScheduler(StateStore(temporary), calendar=AlwaysTrading(), quote_fetcher=batch_for, scorer=scorer)
            self.assertEqual(asyncio.run(closed.tick(datetime(2026, 9, 7, 14, 0, tzinfo=TAIPEI))), "CLOSED")
            self.assertEqual(scorer.calls, 0)
        with tempfile.TemporaryDirectory() as temporary:
            scorer = FakeScorer()
            holiday = ShadowScheduler(StateStore(temporary), calendar=Holiday(), quote_fetcher=batch_for, scorer=scorer)
            self.assertEqual(asyncio.run(holiday.tick(datetime(2026, 9, 7, 10, 0, tzinfo=TAIPEI))), "HOLIDAY")
            self.assertEqual(scorer.calls, 0)

    def test_invalid_c4_version_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            scheduler = ShadowScheduler(StateStore(temporary), calendar=AlwaysTrading(), quote_fetcher=batch_for, scorer=FakeScorer(version="WRONG"))
            self.assertEqual(asyncio.run(scheduler.tick(datetime(2026, 9, 7, 10, 17, tzinfo=TAIPEI))), "UNAVAILABLE")
            self.assertEqual(scheduler.store.snapshot()["current_public_state"]["status"], "UNAVAILABLE")

    def test_m_to_q_failure_cannot_touch_protected_artifacts(self) -> None:
        tracked = subprocess.check_output(["git", "ls-files"], cwd=ROOT, text=True).splitlines()
        tokens = ("finalized", "forward", "00631l", "ad-hoc", "ad_hoc", "adhoc")
        protected = [ROOT / item for item in tracked if any(token in item.lower() for token in tokens) or item in {"canonical-score-resolver.js", "index.html"}]
        before = {item: hashlib.sha256(item.read_bytes()).hexdigest() for item in protected}
        with tempfile.TemporaryDirectory() as temporary:
            scheduler = ShadowScheduler(StateStore(temporary), calendar=AlwaysTrading(), quote_fetcher=batch_for, scorer=FakeScorer(fail=True))
            result = asyncio.run(scheduler.tick(datetime(2026, 9, 7, 10, 17, tzinfo=TAIPEI)))
            self.assertEqual(result, "UNAVAILABLE")
            public = scheduler.store.snapshot()["current_public_state"]
            self.assertEqual(public["status"], "UNAVAILABLE")
            self.assertEqual(public["completeness"], "5/5")
            self.assertTrue(all(public["tickers"][symbol]["score"] is None for symbol in REQUIRED_SYMBOLS))
        after = {item: hashlib.sha256(item.read_bytes()).hexdigest() for item in protected}
        self.assertEqual(before, after)
        homepage = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn("hs-live-source-adapter.js", homepage)
        self.assertIn('name="hs-live-source" content="legacy"', homepage)


class ApiSurfaceTests(unittest.TestCase):
    def test_read_only_routes_and_fail_closed_response(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with mock.patch.dict(os.environ, {"HS_LIVE_VOLUME_PATH": temporary, "HS_LIVE_DISABLE_SCHEDULER": "1"}):
                from backend.app import create_app

                store = StateStore(temporary)
                instance = create_app(store, ShadowScheduler(store, calendar=AlwaysTrading(), quote_fetcher=batch_for, scorer=FakeScorer()))
            routes = {route.path: set(route.methods or ()) for route in instance.routes}
            self.assertEqual(set(routes), {"/api/live-scores", "/healthz"})
            self.assertEqual(routes["/api/live-scores"], {"GET"})
            self.assertEqual(routes["/healthz"], {"GET"})
            live_endpoint = next(route.endpoint for route in instance.routes if route.path == "/api/live-scores")
            response = live_endpoint()
            self.assertEqual(response["status"], "UNAVAILABLE")
            self.assertEqual(response["completeness"], "0/5")
            self.assertTrue(all(response["tickers"][symbol]["score"] is None for symbol in REQUIRED_SYMBOLS))


class DeploymentConfigTests(unittest.TestCase):
    def test_railway_is_single_replica_singapore_single_worker(self) -> None:
        config = json.loads((ROOT / "railway.json").read_text(encoding="utf-8"))
        self.assertEqual(config["deploy"]["multiRegionConfig"], {"asia-southeast1-eqsg3a": {"numReplicas": 1}})
        dockerfile = (ROOT / "backend" / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn("HS_LIVE_VOLUME_PATH=/data/hs-live", dockerfile)
        self.assertIn("--workers 1", dockerfile)
        self.assertNotRegex(dockerfile, r"(?i)(FINMIND_TOKEN|api[_-]?key)\s*=")

    def test_volume_lock_and_railway_mount_guard(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = StateStore(temporary)
            with store.volume_lock() as first:
                self.assertTrue(first)
                with store.volume_lock() as second:
                    self.assertFalse(second)
        with tempfile.TemporaryDirectory() as temporary:
            environment = {"RAILWAY_ENVIRONMENT_ID": "test", "HS_LIVE_VOLUME_PATH": temporary}
            with mock.patch.dict(os.environ, environment, clear=True):
                with self.assertRaises(RuntimeError):
                    StateStore()


if __name__ == "__main__":
    unittest.main(verbosity=2)
