"""Reuse the production TWSE MIS contract and apply the Phase A freshness policy."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Callable

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
    completeness: str = "5/5"


def validate_rows(
    rows: list[dict[str, Any]],
    now: datetime,
    *,
    diagnostics: dict[str, Any] | None = None,
) -> QuoteBatch:
    local_now = now.astimezone(TAIPEI)
    trading_date = local_now.date().isoformat()
    slot = local_now.strftime("%H:%M")
    try:
        verified = production_mis.validate_radar_refresh(rows, trading_date, slot, local_now, diagnostics)
    except Exception as exc:  # noqa: BLE001
        raise QuoteUnavailable(f"MIS_VALIDATION:{exc}") from exc

    by_code = {str(row.get("code", "")): dict(row) for row in rows}
    if set(REQUIRED_SYMBOLS) - set(by_code):
        raise QuoteUnavailable("INCOMPLETE_REQUIRED_QUOTES")
    freshness: dict[str, str] = {}
    timestamps: dict[str, str] = {}
    for symbol in REQUIRED_SYMBOLS:
        quote_at = production_mis.quote_datetime(
            str(by_code[symbol].get("date", "")), str(by_code[symbol].get("quote_time", ""))
        )
        if quote_at is None or quote_at > local_now:
            raise QuoteUnavailable(f"INVALID_QUOTE_TIME:{symbol}")
        age = local_now - quote_at
        if age <= FRESH_LIMIT:
            freshness[symbol] = "FRESH"
        elif age <= PUBLISH_LIMIT:
            freshness[symbol] = "DELAYED"
        else:
            raise QuoteUnavailable(f"STALE_OVER_10_MINUTES:{symbol}")
        timestamps[symbol] = quote_at.isoformat()
    return QuoteBatch(
        trading_date=trading_date,
        slot=slot,
        captured_at=str(verified["captured_at"]),
        items={symbol: by_code[symbol] for symbol in REQUIRED_SYMBOLS},
        quote_timestamps=timestamps,
        freshness=freshness,
    )


def fetch_live_batch(
    now: datetime,
    *,
    fetcher: Callable[..., list[dict[str, Any]]] = production_mis.fetch_mis_snapshot,
) -> QuoteBatch:
    local_now = now.astimezone(TAIPEI)
    deadline = local_now + timedelta(seconds=25)
    try:
        rows = fetcher(deadline=deadline)
    except Exception as exc:  # noqa: BLE001
        raise QuoteUnavailable(f"MIS_FETCH:{type(exc).__name__}:{exc}") from exc
    diagnostics = getattr(rows, "diagnostics", None)
    return validate_rows(rows, local_now, diagnostics=diagnostics)
