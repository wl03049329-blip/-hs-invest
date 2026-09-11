"""Sanitized Fugle last-trade adapter for the Railway shadow backend only."""

from __future__ import annotations

import json
import math
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from typing import Any, Callable
from zoneinfo import ZoneInfo

TAIPEI = ZoneInfo("Asia/Taipei")
FUGLE_QUOTE_URL = "https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/{symbol}"
FRESH_LIMIT = timedelta(minutes=7)
PUBLISH_LIMIT = timedelta(minutes=10)
SESSION_START = time(9, 0)
SESSION_END = time(13, 30, 59)
SYMBOL_RE = re.compile(r"\d{4,6}")


def _taipei_now() -> datetime:
    return datetime.now(TAIPEI)


class FugleUnavailable(RuntimeError):
    """A safe, credential-free Fugle failure classification."""


@dataclass(frozen=True)
class FugleObservation:
    symbol: str
    trading_date: str
    price: float
    trade_at: datetime
    freshness: str
    last_updated: int | None = None
    source: str = "FUGLE_LAST_TRADE"


def _positive_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number > 0 else None


def _epoch_microseconds(value: Any) -> datetime | None:
    if isinstance(value, bool):
        return None
    try:
        epoch = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    # Fugle documents trade timestamps as epoch microseconds.  Reject other
    # units rather than guessing and accidentally accepting an invalid time.
    if epoch < 100_000_000_000_000 or epoch > 99_999_999_999_999_999:
        return None
    try:
        return datetime.fromtimestamp(epoch / 1_000_000, tz=timezone.utc).astimezone(TAIPEI)
    except (OSError, OverflowError, ValueError):
        return None


def validate_fugle_payload(payload: Any, expected_symbol: str, now: datetime) -> FugleObservation:
    local_now = now.astimezone(TAIPEI)
    symbol = str(expected_symbol or "").strip().upper()
    if not SYMBOL_RE.fullmatch(symbol):
        raise FugleUnavailable("INVALID_EXPECTED_SYMBOL")
    if not isinstance(payload, dict):
        raise FugleUnavailable("MALFORMED_JSON")
    if str(payload.get("symbol") or "").strip().upper() != symbol:
        raise FugleUnavailable("SYMBOL_MISMATCH")

    trading_date = str(payload.get("date") or "")
    if trading_date != local_now.date().isoformat():
        raise FugleUnavailable("TRADING_DATE_MISMATCH")
    last_trade = payload.get("lastTrade")
    if not isinstance(last_trade, dict):
        raise FugleUnavailable("LAST_TRADE_MISSING")
    price = _positive_number(last_trade.get("price"))
    if price is None:
        raise FugleUnavailable("LAST_TRADE_PRICE_INVALID")
    trade_at = _epoch_microseconds(last_trade.get("time"))
    if trade_at is None:
        raise FugleUnavailable("LAST_TRADE_TIME_INVALID")
    if trade_at.date().isoformat() != trading_date:
        raise FugleUnavailable("LAST_TRADE_DATE_MISMATCH")
    if not SESSION_START <= trade_at.time() <= SESSION_END:
        raise FugleUnavailable("LAST_TRADE_OUTSIDE_SESSION")
    if trade_at > local_now:
        raise FugleUnavailable("LAST_TRADE_FUTURE")
    age = local_now - trade_at
    if age <= FRESH_LIMIT:
        freshness = "FRESH"
    elif age <= PUBLISH_LIMIT:
        freshness = "DELAYED"
    else:
        raise FugleUnavailable("LAST_TRADE_STALE")

    last_updated = payload.get("lastUpdated")
    if isinstance(last_updated, bool) or not isinstance(last_updated, (int, float)):
        last_updated = None
    else:
        last_updated = int(last_updated)
    return FugleObservation(symbol, trading_date, price, trade_at, freshness, last_updated)


def fetch_fugle_quote(
    symbol: str,
    now: datetime,
    *,
    api_key: str | None = None,
    opener: Callable[..., Any] = urllib.request.urlopen,
    timeout: float = 5.0,
    clock: Callable[[], datetime] = _taipei_now,
) -> FugleObservation:
    key = api_key if api_key is not None else os.getenv("FUGLE_API_KEY")
    if not key:
        raise FugleUnavailable("FUGLE_API_KEY_MISSING")
    normalized_symbol = str(symbol or "").strip().upper()
    if not SYMBOL_RE.fullmatch(normalized_symbol):
        raise FugleUnavailable("INVALID_EXPECTED_SYMBOL")
    request = urllib.request.Request(
        FUGLE_QUOTE_URL.format(symbol=normalized_symbol),
        headers={
            "Accept": "application/json",
            "User-Agent": "HS-Live-Shadow/1.0",
            "X-API-KEY": key,
        },
    )
    try:
        with opener(request, timeout=timeout) as response:
            status_value = getattr(response, "status", None)
            status = int(status_value if status_value is not None else response.getcode())
            if status != 200:
                raise FugleUnavailable(f"HTTP_{status}")
            body = response.read()
    except urllib.error.HTTPError as exc:
        raise FugleUnavailable(f"HTTP_{exc.code}") from exc
    except TimeoutError as exc:
        raise FugleUnavailable("TIMEOUT") from exc
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", None)
        code = "TIMEOUT" if isinstance(reason, TimeoutError) else "NETWORK_ERROR"
        raise FugleUnavailable(code) from exc
    except OSError as exc:
        raise FugleUnavailable("NETWORK_ERROR") from exc
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise FugleUnavailable("MALFORMED_JSON") from exc
    # A trade may legitimately occur after the scheduler captured its cycle
    # timestamp but before this HTTP response arrived.  Validate against the
    # response-time clock so that only timestamps beyond observation time are
    # classified as future.
    response_received_at = clock().astimezone(TAIPEI)
    return validate_fugle_payload(payload, normalized_symbol, response_received_at)
