from __future__ import annotations

import asyncio
import io
import json
import math
import os
import tempfile
import unittest
import urllib.error
from datetime import datetime, timedelta
from unittest import mock

from backend.fugle_quotes import FugleUnavailable, fetch_fugle_quote, validate_fugle_payload
from backend.live_quotes import REQUIRED_SYMBOLS, TAIPEI, QuoteUnavailable, fetch_live_batch
from backend.scheduler import C4_VERSION, ShadowScheduler
from backend.state_store import StateStore
from scripts import update_market_quotes as production_mis


NOW = datetime(2026, 9, 9, 12, 36, tzinfo=TAIPEI)


def epoch_microseconds(value: datetime) -> int:
    return int(value.timestamp() * 1_000_000)


def fugle_payload(
    symbol: str,
    *,
    now: datetime = NOW,
    age_minutes: int = 1,
    price: object = 100.0,
    date: str | None = None,
    trade_at: datetime | None = None,
) -> dict:
    observed_at = trade_at or (now - timedelta(minutes=age_minutes))
    return {
        "symbol": symbol,
        "date": date or now.date().isoformat(),
        "lastTrade": {"price": price, "time": epoch_microseconds(observed_at)},
        "lastUpdated": epoch_microseconds(now),
    }


def raw_mis(symbol: str, *, z: str = "-", pz: str = "-", now: datetime = NOW) -> dict:
    return {
        "c": symbol,
        "n": symbol,
        "ex": "tse",
        "d": now.strftime("%Y%m%d"),
        "t": (now - timedelta(seconds=20)).strftime("%H:%M:%S"),
        "z": z,
        "pz": pz,
        "y": "98",
        "o": "99",
        "h": "102",
        "l": "97",
        "v": "1000",
    }


def mis_result(*, modes: dict[str, tuple[str, str]]) -> production_mis.MisSnapshotRows:
    parsed: list[dict] = []
    rejected: dict[str, dict] = {}
    for symbol in REQUIRED_SYMBOLS:
        z, pz = modes.get(symbol, ("100", "99"))
        raw = raw_mis(symbol, z=z, pz=pz)
        row, reason = production_mis.parse_mis_row(raw, required=True)
        if row:
            parsed.append(row)
        else:
            rejected[symbol] = {
                "reason": reason,
                "raw_fields": production_mis.required_raw_fields(raw),
            }
    return production_mis.MisSnapshotRows(parsed, {"final_parse_rejected": rejected})


def valid_observation(symbol: str, now: datetime = NOW):
    return validate_fugle_payload(fugle_payload(symbol, now=now), symbol, now)


class FakeResponse:
    def __init__(self, payload: bytes, status: int = 200) -> None:
        self.payload = payload
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self) -> bytes:
        return self.payload


class AlwaysTrading:
    def check(self, _):
        from backend.trading_calendar import CalendarResult

        return CalendarResult("TRADING_DAY", "test-calendar")


class FakeScorer:
    def score(self, batch, calculated_at: str) -> dict:
        items = {
            symbol: {
                "status": "SUCCESS",
                "score": 40.0 + index,
                "display_score": str(40 + index),
                "delta_vs_previous_close": 0.0,
            }
            for index, symbol in enumerate(REQUIRED_SYMBOLS)
        }
        return {
            "status": "SUCCESS",
            "score_version": C4_VERSION,
            "input_fingerprint": "a" * 64,
            "snapshot": {"score_version": C4_VERSION, "items": items},
        }


class FugleValidationTests(unittest.TestCase):
    def test_wrong_symbol_rejected(self) -> None:
        with self.assertRaisesRegex(FugleUnavailable, "SYMBOL_MISMATCH"):
            validate_fugle_payload(fugle_payload("00662"), "0050", NOW)

    def test_wrong_date_rejected(self) -> None:
        with self.assertRaisesRegex(FugleUnavailable, "TRADING_DATE_MISMATCH"):
            validate_fugle_payload(fugle_payload("0050", date="2026-09-08"), "0050", NOW)

    def test_stale_over_ten_minutes_rejected(self) -> None:
        with self.assertRaisesRegex(FugleUnavailable, "LAST_TRADE_STALE"):
            validate_fugle_payload(fugle_payload("0050", age_minutes=11), "0050", NOW)

    def test_fresh_and_delayed_boundaries(self) -> None:
        fresh = validate_fugle_payload(fugle_payload("0050", age_minutes=7), "0050", NOW)
        delayed = validate_fugle_payload(fugle_payload("0050", age_minutes=10), "0050", NOW)
        self.assertEqual((fresh.freshness, delayed.freshness), ("FRESH", "DELAYED"))

    def test_future_timestamp_rejected(self) -> None:
        with self.assertRaisesRegex(FugleUnavailable, "LAST_TRADE_FUTURE"):
            validate_fugle_payload(
                fugle_payload("0050", trade_at=NOW + timedelta(seconds=1)), "0050", NOW
            )

    def test_invalid_prices_rejected(self) -> None:
        for price in (0, -1, math.nan, None):
            with self.subTest(price=price), self.assertRaisesRegex(FugleUnavailable, "LAST_TRADE_PRICE_INVALID"):
                validate_fugle_payload(fugle_payload("0050", price=price), "0050", NOW)


class FugleTransportTests(unittest.TestCase):
    def test_http_401_and_429_fail_closed(self) -> None:
        for status in (401, 429):
            def opener(request, timeout, status=status):
                raise urllib.error.HTTPError(request.full_url, status, "blocked", {}, io.BytesIO())

            with self.subTest(status=status), self.assertRaisesRegex(FugleUnavailable, f"HTTP_{status}"):
                fetch_fugle_quote("0050", NOW, api_key="test-secret", opener=opener, clock=lambda: NOW)

    def test_timeout_fails_closed(self) -> None:
        def opener(*_, **__):
            raise TimeoutError("slow")

        with self.assertRaisesRegex(FugleUnavailable, "TIMEOUT"):
            fetch_fugle_quote("0050", NOW, api_key="test-secret", opener=opener, clock=lambda: NOW)

    def test_missing_key_is_unavailable_and_secret_is_not_in_error(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(FugleUnavailable, "FUGLE_API_KEY_MISSING") as caught:
                fetch_fugle_quote("0050", NOW, clock=lambda: NOW)
        self.assertNotIn("test-secret", str(caught.exception))

    def test_trade_after_cycle_start_but_before_response_is_not_future(self) -> None:
        trade_at = NOW + timedelta(seconds=3)
        response_at = NOW + timedelta(seconds=5)
        payload = json.dumps(fugle_payload("0050", trade_at=trade_at)).encode("utf-8")
        quote = fetch_fugle_quote(
            "0050",
            NOW,
            api_key="test-secret",
            opener=lambda *_args, **_kwargs: FakeResponse(payload),
            clock=lambda: response_at,
        )
        self.assertEqual(quote.trade_at, trade_at)

    def test_trade_after_response_time_remains_rejected(self) -> None:
        trade_at = NOW + timedelta(seconds=6)
        response_at = NOW + timedelta(seconds=5)
        payload = json.dumps(fugle_payload("0050", trade_at=trade_at)).encode("utf-8")
        with self.assertRaisesRegex(FugleUnavailable, "LAST_TRADE_FUTURE"):
            fetch_fugle_quote(
                "0050",
                NOW,
                api_key="test-secret",
                opener=lambda *_args, **_kwargs: FakeResponse(payload),
                clock=lambda: response_at,
            )


class MixedSourceContractTests(unittest.TestCase):
    def test_mis_valid_z_has_priority_and_skips_fugle(self) -> None:
        calls: list[str] = []
        batch = fetch_live_batch(
            NOW,
            fetcher=lambda **_: mis_result(modes={}),
            fugle_fetcher=lambda symbol, now: calls.append(symbol),
            clock=lambda: NOW,
        )
        self.assertEqual(calls, [])
        self.assertEqual(set(batch.sources.values()), {"MIS_Z"})

    def test_mis_valid_pz_has_priority_and_skips_fugle(self) -> None:
        calls: list[str] = []
        modes = {symbol: ("-", "100") for symbol in REQUIRED_SYMBOLS}
        batch = fetch_live_batch(
            NOW,
            fetcher=lambda **_: mis_result(modes=modes),
            fugle_fetcher=lambda symbol, now: calls.append(symbol),
            clock=lambda: NOW,
        )
        self.assertEqual(calls, [])
        self.assertEqual(set(batch.sources.values()), {"MIS_PZ"})

    def test_invalid_mis_uses_fugle_last_trade_and_mixed_batch_is_five_of_five(self) -> None:
        fallback_symbols = set(REQUIRED_SYMBOLS) - {"0050"}
        modes = {symbol: ("-", "-") for symbol in fallback_symbols}
        calls: list[str] = []

        def fugle(symbol: str, now: datetime):
            calls.append(symbol)
            return valid_observation(symbol, now)

        batch = fetch_live_batch(
            NOW,
            fetcher=lambda **_: mis_result(modes=modes),
            fugle_fetcher=fugle,
            clock=lambda: NOW,
        )
        self.assertEqual(set(calls), fallback_symbols)
        self.assertEqual(batch.completeness, "5/5")
        self.assertEqual(batch.sources["0050"], "MIS_Z")
        for symbol in fallback_symbols:
            self.assertEqual(batch.sources[symbol], "FUGLE_LAST_TRADE")
            self.assertEqual(batch.items[symbol]["price_field"], "lastTrade.price")

    def test_one_required_fallback_failure_makes_batch_unavailable(self) -> None:
        modes = {symbol: ("-", "-") for symbol in REQUIRED_SYMBOLS}

        def fugle(symbol: str, now: datetime):
            if symbol == "00935":
                raise FugleUnavailable("HTTP_429")
            return valid_observation(symbol, now)

        with self.assertRaisesRegex(QuoteUnavailable, "00935:HTTP_429"):
            fetch_live_batch(
                NOW,
                fetcher=lambda **_: mis_result(modes=modes),
                fugle_fetcher=fugle,
                clock=lambda: NOW,
            )

    def test_wait_native_and_quote_provenance_survive_scheduler_publication(self) -> None:
        fallback_symbols = set(REQUIRED_SYMBOLS) - {"0050"}
        modes = {symbol: ("-", "-") for symbol in fallback_symbols}
        batch = fetch_live_batch(
            NOW,
            fetcher=lambda **_: mis_result(modes=modes),
            fugle_fetcher=lambda symbol, now: valid_observation(symbol, now),
            clock=lambda: NOW,
        )
        with tempfile.TemporaryDirectory() as temporary:
            store = StateStore(temporary)
            scheduler = ShadowScheduler(
                store,
                calendar=AlwaysTrading(),
                quote_fetcher=lambda _: batch,
                scorer=FakeScorer(),
            )
            self.assertEqual(asyncio.run(scheduler.tick(NOW)), "SUCCESS")
            public = store.snapshot()["current_public_state"]
        self.assertEqual(public["tickers"]["009815"]["status"], "WAIT_NATIVE")
        self.assertIsNone(public["tickers"]["009815"]["quote_source"])
        self.assertEqual(public["tickers"]["0050"]["quote_source"], "MIS_Z")
        self.assertEqual(public["tickers"]["00662"]["quote_source"], "FUGLE_LAST_TRADE")

    def test_frozen_c4_contract_and_mis_parser_alias_are_unchanged(self) -> None:
        from backend.live_quotes import parse_mis_row

        self.assertIs(parse_mis_row, production_mis.parse_mis_row)
        self.assertEqual(C4_VERSION, "FINAL_CORE_WEIGHT_V1")


if __name__ == "__main__":
    unittest.main(verbosity=2)
