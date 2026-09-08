"""Fail-closed Taiwan trading calendar backed by the production TWSE source."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import date
from typing import Any, Callable

from scripts.fetch_official_eod_market import fetch_holidays, is_no_trading_day


@dataclass(frozen=True)
class CalendarResult:
    status: str
    revision: str | None
    reason: str | None = None


class TradingCalendar:
    def __init__(self, fetcher: Callable[[], list[dict[str, Any]]] = fetch_holidays) -> None:
        self._fetcher = fetcher
        self._cache: tuple[date, list[dict[str, Any]], str] | None = None

    def check(self, target: date) -> CalendarResult:
        if target.weekday() >= 5:
            return CalendarResult("HOLIDAY", f"WEEKEND-{target.isoformat()}", "WEEKEND")
        try:
            if self._cache is None or self._cache[0] != target:
                rows = self._fetcher()
                if not isinstance(rows, list) or not rows:
                    raise ValueError("empty_holiday_schedule")
                canonical = json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                self._cache = (target, rows, hashlib.sha256(canonical.encode("utf-8")).hexdigest())
            _, rows, revision = self._cache
            if is_no_trading_day(target.isoformat(), rows):
                return CalendarResult("HOLIDAY", revision, "TWSE_HOLIDAY_SCHEDULE")
            return CalendarResult("TRADING_DAY", revision)
        except Exception as exc:  # noqa: BLE001
            return CalendarResult("UNKNOWN", None, f"CALENDAR_UNAVAILABLE:{type(exc).__name__}:{exc}")
