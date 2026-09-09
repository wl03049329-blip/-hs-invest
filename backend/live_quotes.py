"""Reuse the production TWSE MIS contract and apply the Phase A freshness policy."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Callable

from .fugle_quotes import FUGLE_QUOTE_URL, FugleObservation, FugleUnavailable, fetch_fugle_quote
from scripts import update_market_quotes as production_mis

TAIPEI = production_mis.TAIPEI
REQUIRED_SYMBOLS = production_mis.RADAR_REQUIRED_LIVE_SYMBOLS
WAIT_NATIVE_SYMBOL = "009815"
FRESH_LIMIT = timedelta(minutes=7)
PUBLISH_LIMIT = timedelta(minutes=10)

# These aliases deliberately are the production functions, not copied variants.
parse_mis_row = production_mis.parse_mis_row
inspect_mis_batch = production_mis.inspect_mis_batch


class QuoteUnavailable(RuntimeError):
    """The required MIS batch is not safe to publish."""


@dataclass(frozen=True)
class QuoteBatch:
    trading_date: str
    slot: str
    captured_at: str
    items: dict[str, dict[str, Any]]
    quote_timestamps: dict[str, str]
    freshness: dict[str, str]
    sources: dict[str, str] = field(default_factory=dict)
    completeness: str = "5/5"


def _quote_source(row: dict[str, Any]) -> str:
    explicit = str(row.get("quote_source") or "")
    if explicit in {"MIS_Z", "MIS_PZ", "FUGLE_LAST_TRADE"}:
        return explicit
    if row.get("source") == production_mis.TWSE_MIS_URL and row.get("price_field") in {"z", "pz"}:
        return f"MIS_{str(row['price_field']).upper()}"
    return ""


def _validate_shadow_mixed_rows(rows: list[dict[str, Any]], local_now: datetime) -> tuple[dict[str, Any], dict[str, str], dict[str, str], dict[str, str]]:
    trading_date = local_now.date().isoformat()
    slot = local_now.strftime("%H:%M")
    if not production_mis.valid_rolling_slot(slot):
        raise QuoteUnavailable(f"MIXED_VALIDATION:unsupported radar slot: {slot}")
    session_start, session_end = production_mis.radar_slot_window(trading_date, slot)
    if not session_start <= local_now <= session_end:
        raise QuoteUnavailable(f"MIXED_VALIDATION:radar market session is not open: {slot}")
    by_code = {str(row.get("code", "")): dict(row) for row in rows}
    if set(REQUIRED_SYMBOLS) - set(by_code):
        raise QuoteUnavailable("INCOMPLETE_REQUIRED_QUOTES")

    timestamps: dict[str, str] = {}
    freshness: dict[str, str] = {}
    sources: dict[str, str] = {}
    for symbol in REQUIRED_SYMBOLS:
        row = by_code[symbol]
        source = _quote_source(row)
        if source not in {"MIS_Z", "MIS_PZ", "FUGLE_LAST_TRADE"}:
            raise QuoteUnavailable(f"INVALID_QUOTE_SOURCE:{symbol}")
        if source.startswith("MIS_"):
            expected_price_field = {"MIS_Z": "z", "MIS_PZ": "pz"}[source]
            if row.get("source") != production_mis.TWSE_MIS_URL or row.get("price_field") != expected_price_field:
                raise QuoteUnavailable(f"MIS_SOURCE_MISMATCH:{symbol}")
        elif row.get("source") != FUGLE_QUOTE_URL.rsplit("/", 1)[0] or row.get("price_field") != "lastTrade.price":
            raise QuoteUnavailable(f"FUGLE_SOURCE_MISMATCH:{symbol}")
        if row.get("date") != trading_date:
            raise QuoteUnavailable(f"QUOTE_DATE_MISMATCH:{symbol}")
        price = production_mis.finite_number(row.get("price"), positive=True)
        open_price = production_mis.finite_number(row.get("open"), positive=True)
        high = production_mis.finite_number(row.get("high"), positive=True)
        low = production_mis.finite_number(row.get("low"), positive=True)
        if None in (price, open_price, high, low) or high < low:
            raise QuoteUnavailable(f"QUOTE_OHLC_INVALID:{symbol}")
        if price < low * 0.999 or price > high * 1.001:
            raise QuoteUnavailable(f"QUOTE_PRICE_OUTSIDE_HIGH_LOW:{symbol}")
        quote_at = production_mis.quote_datetime(trading_date, str(row.get("quote_time", "")))
        if quote_at is None or quote_at < session_start or quote_at > session_end:
            raise QuoteUnavailable(f"QUOTE_TIME_OUTSIDE_SESSION:{symbol}")
        if quote_at > local_now:
            raise QuoteUnavailable(f"INVALID_QUOTE_TIME:{symbol}")
        age = local_now - quote_at
        if age <= FRESH_LIMIT:
            freshness[symbol] = "FRESH"
        elif age <= PUBLISH_LIMIT:
            freshness[symbol] = "DELAYED"
        else:
            raise QuoteUnavailable(f"STALE_OVER_10_MINUTES:{symbol}")
        timestamps[symbol] = quote_at.isoformat()
        sources[symbol] = source
    return by_code, timestamps, freshness, sources


def _fugle_row(symbol: str, raw: dict[str, Any], observation: FugleObservation, local_now: datetime) -> dict[str, Any]:
    if str(raw.get("c") or "").strip().upper() != symbol:
        raise FugleUnavailable("MIS_CONTEXT_SYMBOL_MISMATCH")
    data_date = production_mis.iso_date(raw.get("d") or raw.get("^"))
    if data_date != local_now.date().isoformat() or data_date != observation.trading_date:
        raise FugleUnavailable("MIS_CONTEXT_DATE_MISMATCH")
    context_at = production_mis.quote_datetime(data_date, str(raw.get("t") or raw.get("%") or ""))
    if context_at is None or context_at > local_now or local_now - context_at > PUBLISH_LIMIT:
        raise FugleUnavailable("MIS_CONTEXT_TIME_INVALID")
    if not production_mis.RADAR_MARKET_OPEN <= context_at.time() <= production_mis.RADAR_MARKET_CLOSE:
        raise FugleUnavailable("MIS_CONTEXT_OUTSIDE_SESSION")
    open_price = production_mis.finite_number(raw.get("o"), positive=True)
    high = production_mis.finite_number(raw.get("h"), positive=True)
    low = production_mis.finite_number(raw.get("l"), positive=True)
    reference = production_mis.finite_number(raw.get("y"), positive=True)
    volume_lots = production_mis.finite_number(raw.get("v"))
    if None in (open_price, high, low, reference) or high < low or volume_lots is None or volume_lots < 0:
        raise FugleUnavailable("MIS_CONTEXT_OHLC_INVALID")
    return {
        "code": symbol,
        "name": symbol,
        "price": observation.price,
        "price_field": "lastTrade.price",
        "previous_close": reference,
        "date": observation.trading_date,
        "quote_time": observation.trade_at.strftime("%H:%M:%S"),
        "market": "TPEx" if raw.get("ex") == "otc" else "TWSE",
        "high": high,
        "low": low,
        "open": open_price,
        "volume": volume_lots * 1000,
        "source": FUGLE_QUOTE_URL.rsplit("/", 1)[0],
        "quote_source": "FUGLE_LAST_TRADE",
        "provider_last_updated": observation.last_updated,
    }


def validate_rows(
    rows: list[dict[str, Any]],
    now: datetime,
    *,
    diagnostics: dict[str, Any] | None = None,
) -> QuoteBatch:
    local_now = now.astimezone(TAIPEI)
    trading_date = local_now.date().isoformat()
    slot = local_now.strftime("%H:%M")
    all_mis = all(row.get("source") == production_mis.TWSE_MIS_URL for row in rows if str(row.get("code", "")) in REQUIRED_SYMBOLS)
    if all_mis:
        try:
            verified = production_mis.validate_radar_refresh(rows, trading_date, slot, local_now, diagnostics)
        except Exception as exc:  # noqa: BLE001
            raise QuoteUnavailable(f"MIS_VALIDATION:{exc}") from exc
        # The production MIS guard currently allows a wider quote window for
        # its own publisher.  The shadow API keeps its established 10-minute
        # publication boundary for both primary and secondary sources.
        by_code, timestamps, freshness, sources = _validate_shadow_mixed_rows(rows, local_now)
        captured_at = str(verified["captured_at"])
    else:
        by_code, timestamps, freshness, sources = _validate_shadow_mixed_rows(rows, local_now)
        captured_at = local_now.isoformat()
    return QuoteBatch(
        trading_date=trading_date,
        slot=slot,
        captured_at=captured_at,
        items={symbol: by_code[symbol] for symbol in REQUIRED_SYMBOLS},
        quote_timestamps=timestamps,
        freshness=freshness,
        sources=sources,
    )


def fetch_live_batch(
    now: datetime,
    *,
    fetcher: Callable[..., list[dict[str, Any]]] = production_mis.fetch_mis_snapshot,
    fugle_fetcher: Callable[[str, datetime], FugleObservation] = fetch_fugle_quote,
) -> QuoteBatch:
    local_now = now.astimezone(TAIPEI)
    deadline = local_now + timedelta(seconds=25)
    try:
        result = fetcher(deadline=deadline)
    except Exception as exc:  # noqa: BLE001
        raise QuoteUnavailable(f"MIS_FETCH:{type(exc).__name__}:{exc}") from exc
    diagnostics = getattr(result, "diagnostics", None)
    rows = [dict(row) for row in result]
    for row in rows:
        if row.get("source") == production_mis.TWSE_MIS_URL and row.get("price_field") in {"z", "pz"}:
            row["quote_source"] = f"MIS_{str(row['price_field']).upper()}"
    by_code = {str(row.get("code") or ""): row for row in rows}
    rejected = diagnostics.get("final_parse_rejected", {}) if isinstance(diagnostics, dict) else {}
    failures: list[str] = []
    for symbol in REQUIRED_SYMBOLS:
        if symbol in by_code:
            continue
        detail = rejected.get(symbol) if isinstance(rejected, dict) else None
        reason = str(detail.get("reason") or "") if isinstance(detail, dict) else ""
        raw = detail.get("raw_fields") if isinstance(detail, dict) else None
        if reason not in {"missing_price", "invalid_price"} or not isinstance(raw, dict):
            failures.append(f"{symbol}:MIS_{reason.upper() or 'UNAVAILABLE'}")
            continue
        try:
            observation = fugle_fetcher(symbol, local_now)
            row = _fugle_row(symbol, raw, observation, local_now)
            rows.append(row)
            by_code[symbol] = row
        except FugleUnavailable as exc:
            failures.append(f"{symbol}:{exc}")
        except Exception as exc:  # noqa: BLE001
            failures.append(f"{symbol}:FUGLE_{type(exc).__name__.upper()}")
    if failures:
        raise QuoteUnavailable("SECONDARY_UNAVAILABLE:" + ",".join(failures))
    return validate_rows(rows, local_now, diagnostics=diagnostics)
