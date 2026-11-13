"""Fail-closed Taiwan trading calendar backed by the production TWSE source."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import date
from typing import Any, Callable

from scripts.fetch_official_eod_market import fetch_bytes, fetch_holidays, iso_date, is_no_trading_day


def fetch_year_schedule(year: int) -> list[dict[str, str]]:
    url = f"https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule?response=json&date={year}0101"
    payload = json.loads(fetch_bytes(url).decode("utf-8-sig"))
    rows = payload.get("data") if isinstance(payload, dict) else None
    if (not isinstance(rows, list) or not rows or payload.get("stat") != "ok"
            or payload.get("queryYear") != year or payload.get("total") != len(rows)
            or payload.get("fields") != ["日期", "名稱", "說明"]):
        raise ValueError("YEAR_SCHEDULE_SCHEMA")
    if any(not isinstance(row, list) or len(row) != 3 or not all(isinstance(v, str) for v in row)
           or iso_date(row[0]) != row[0] or not row[0].startswith(f"{year}-") for row in rows):
        raise ValueError("YEAR_SCHEDULE_ROWS")
    # Multiple named entries on the same day are legal in TWSE's report.
    return [dict(zip(("Date","Name","Description"), row)) for row in rows]


@dataclass(frozen=True)
class CalendarResult:
    status: str
    revision: str | None
    reason: str | None = None


class TradingCalendar:
    def __init__(self, fetcher: Callable[[], list[dict[str, Any]]] = fetch_holidays,
                 *, year_fetcher=None) -> None:
        self._fetcher = fetcher
        self._year_fetcher = year_fetcher if year_fetcher is not None else (
            fetch_year_schedule if fetcher is fetch_holidays else None)
        self._cache: tuple[date, list[dict[str, Any]], str] | None = None

    def check(self, target: date) -> CalendarResult:
        if target.weekday() >= 5:
            return CalendarResult("HOLIDAY", f"WEEKEND-{target.isoformat()}", "WEEKEND")
        try:
            if self._cache is None or self._cache[0] != target:
                rows = self._fetcher()
                if not isinstance(rows, list) or not rows:
                    raise ValueError("empty_holiday_schedule")
                if not all(isinstance(row, dict) and iso_date(row.get("Date")) for row in rows):
                    raise ValueError("INVALID_HOLIDAY_ROWS")
                if not any(iso_date(row["Date"]).startswith(f"{target.year}-") for row in rows):
                    if self._year_fetcher is None:
                        return CalendarResult("UNKNOWN", None, "HOLIDAY_CALENDAR_COVERAGE")
                    rows = self._year_fetcher(target.year)
                    if not rows or not all(isinstance(row, dict) and
                                           iso_date(row.get("Date")).startswith(f"{target.year}-") for row in rows):
                        return CalendarResult("UNKNOWN", None, "HOLIDAY_CALENDAR_COVERAGE")
                canonical = json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                self._cache = (target, rows, hashlib.sha256(canonical.encode("utf-8")).hexdigest())
            _, rows, revision = self._cache
            if is_no_trading_day(target.isoformat(), rows):
                return CalendarResult("HOLIDAY", revision, "TWSE_HOLIDAY_SCHEDULE")
            return CalendarResult("TRADING_DAY", revision)
        except Exception as exc:  # noqa: BLE001
            return CalendarResult("UNKNOWN", None, f"CALENDAR_UNAVAILABLE:{type(exc).__name__}")
