#!/usr/bin/env python3
"""Fetch a validated, official-only TWSE EOD envelope for Core finalization."""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import tempfile
import urllib.request
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

TAIPEI = ZoneInfo("Asia/Taipei")
REQUIRED_SYMBOLS = ("0050", "00662", "00757", "00830", "00935")
PRIMARY_PROVIDER = "TWSE_OPENAPI_STOCK_DAY_ALL"
FALLBACK_PROVIDER = "TWSE_EXCHANGE_REPORT_OPEN_DATA"
PRIMARY_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"
FALLBACK_URL = "https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=open_data"
HOLIDAY_URL = "https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule"
SOURCE_TYPE = "TWSE_OFFICIAL_RAW_DAILY_OHLC"


class SourceConflict(RuntimeError):
    pass


class LookAheadRejected(RuntimeError):
    pass


def iso_date(value: Any) -> str:
    digits = re.sub(r"\D", "", str(value or ""))
    if len(digits) == 7:
        digits = f"{int(digits[:3]) + 1911:04d}{digits[3:]}"
    if len(digits) != 8:
        return ""
    parsed = f"{digits[:4]}-{digits[4:6]}-{digits[6:8]}"
    try:
        datetime.strptime(parsed, "%Y-%m-%d")
    except ValueError:
        return ""
    return parsed


def decimal_value(value: Any, *, positive: bool = False) -> Decimal | None:
    try:
        parsed = Decimal(str(value).replace(",", "").strip())
    except (InvalidOperation, AttributeError):
        return None
    if not parsed.is_finite() or (positive and parsed <= 0):
        return None
    return parsed


def normalize_rows(rows: list[dict[str, Any]], provider: str) -> dict[str, dict[str, Any]]:
    mapping = {
        PRIMARY_PROVIDER: {
            "symbol": "Code", "date": "Date", "open": "OpeningPrice",
            "high": "HighestPrice", "low": "LowestPrice", "close": "ClosingPrice",
            "volume": "TradeVolume",
        },
        FALLBACK_PROVIDER: {
            "symbol": "證券代號", "date": "日期", "open": "開盤價",
            "high": "最高價", "low": "最低價", "close": "收盤價",
            "volume": "成交股數",
        },
    }[provider]
    output: dict[str, dict[str, Any]] = {}
    for row in rows:
        symbol = str(row.get(mapping["symbol"], "")).strip().upper()
        if symbol not in REQUIRED_SYMBOLS:
            continue
        trading_date = iso_date(row.get(mapping["date"]))
        values = {key: decimal_value(row.get(mapping[key]), positive=True) for key in ("open", "high", "low", "close")}
        if not trading_date or any(value is None for value in values.values()):
            continue
        if values["high"] < max(values["open"], values["low"], values["close"]) or values["low"] > min(values["open"], values["high"], values["close"]):
            continue
        volume = decimal_value(row.get(mapping["volume"]))
        output[symbol] = {
            "symbol": symbol,
            "date": trading_date,
            **{key: float(value) for key, value in values.items()},
            "volume": float(volume) if volume is not None else None,
        }
    return output


def fetch_bytes(url: str, timeout: int = 30) -> bytes:
    request = urllib.request.Request(url, headers={"Accept": "application/json,text/csv", "User-Agent": "HS-ETF-Radar/2.0"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status != 200:
            raise RuntimeError(f"HTTP_{response.status}")
        return response.read()


def fetch_primary() -> dict[str, dict[str, Any]]:
    payload = json.loads(fetch_bytes(PRIMARY_URL).decode("utf-8-sig"))
    if not isinstance(payload, list):
        raise ValueError("primary_not_array")
    return normalize_rows(payload, PRIMARY_PROVIDER)


def fetch_fallback() -> dict[str, dict[str, Any]]:
    text = fetch_bytes(FALLBACK_URL).decode("utf-8-sig")
    return normalize_rows(list(csv.DictReader(io.StringIO(text))), FALLBACK_PROVIDER)


def fetch_holidays() -> list[dict[str, Any]]:
    payload = json.loads(fetch_bytes(HOLIDAY_URL).decode("utf-8-sig"))
    if not isinstance(payload, list):
        raise ValueError("holiday_not_array")
    return payload


def is_no_trading_day(expected: str, holiday_rows: list[dict[str, Any]]) -> bool:
    target = datetime.strptime(expected, "%Y-%m-%d").date()
    if target.weekday() >= 5:
        return True
    for row in holiday_rows:
        if iso_date(row.get("Date")) != expected:
            continue
        text = f"{row.get('Name', '')} {row.get('Description', '')}"
        if any(token in text for token in ("市場無交易", "休市", "放假")) and not any(token in text for token in ("開始交易", "最後交易")):
            return True
    return False


def source_state(provider: str, items: dict[str, dict[str, Any]], error: str = "") -> dict[str, Any]:
    dates = sorted({item["date"] for item in items.values()})
    complete = all(symbol in items for symbol in REQUIRED_SYMBOLS) and len(dates) == 1
    return {
        "provider": provider,
        "status": "VALID" if complete else ("ERROR" if error else "INCOMPLETE"),
        "source_date": dates[0] if complete else None,
        "complete": complete,
        "symbols": sorted(items),
        "error": error or None,
        "items": items,
    }


def equivalent(left: dict[str, dict[str, Any]], right: dict[str, dict[str, Any]]) -> bool:
    for symbol in REQUIRED_SYMBOLS:
        if symbol not in left or symbol not in right:
            return False
        for field in ("date", "open", "high", "low", "close"):
            if field == "date":
                if left[symbol][field] != right[symbol][field]:
                    return False
            elif Decimal(str(left[symbol][field])) != Decimal(str(right[symbol][field])):
                return False
    return True


def resolve(expected: str, primary: dict[str, Any], fallback: dict[str, Any], no_trading_day: bool, fetched_at: str) -> dict[str, Any]:
    for source in (primary, fallback):
        if source.get("complete") and str(source.get("source_date")) > expected:
            raise LookAheadRejected(f"future_source_{source['provider']}_{source['source_date']}_after_{expected}")
    ready = [source for source in (primary, fallback) if source.get("complete") and source.get("source_date") == expected]
    diagnostics = [{key: source.get(key) for key in ("provider", "status", "source_date", "complete", "symbols", "error")} for source in (primary, fallback)]
    if no_trading_day:
        if ready:
            raise SourceConflict(f"calendar_marks_no_trading_but_source_ready_{expected}")
        return {"schema_version": 1, "snapshot_type": "OFFICIAL_EOD_MARKET", "status": "NO_TRADING_DAY", "expected_date": expected, "source_date": None, "provider": None, "source_type": SOURCE_TYPE, "fetched_at": fetched_at, "fallback_used": False, "items": {}, "sources": diagnostics}
    if len(ready) == 2 and not equivalent(ready[0]["items"], ready[1]["items"]):
        raise SourceConflict(f"same_date_ohlc_conflict_{expected}")
    selected = ready[0] if ready and ready[0]["provider"] == PRIMARY_PROVIDER else (ready[-1] if ready else None)
    if not selected:
        return {"schema_version": 1, "snapshot_type": "OFFICIAL_EOD_MARKET", "status": "SOURCE_NOT_READY", "expected_date": expected, "source_date": None, "provider": None, "source_type": SOURCE_TYPE, "fetched_at": fetched_at, "fallback_used": False, "items": {}, "sources": diagnostics}
    return {"schema_version": 1, "snapshot_type": "OFFICIAL_EOD_MARKET", "status": "READY", "expected_date": expected, "source_date": expected, "provider": selected["provider"], "source_type": SOURCE_TYPE, "fetched_at": fetched_at, "fallback_used": selected["provider"] != PRIMARY_PROVIDER, "items": selected["items"], "sources": diagnostics}


def collect(expected: str, now: datetime | None = None, primary_fetch: Callable[[], dict[str, dict[str, Any]]] = fetch_primary, fallback_fetch: Callable[[], dict[str, dict[str, Any]]] = fetch_fallback, holiday_fetch: Callable[[], list[dict[str, Any]]] = fetch_holidays) -> dict[str, Any]:
    now = now or datetime.now(TAIPEI)
    fetched_at = now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    states: list[dict[str, Any]] = []
    for provider, fetcher in ((PRIMARY_PROVIDER, primary_fetch), (FALLBACK_PROVIDER, fallback_fetch)):
        try:
            states.append(source_state(provider, fetcher()))
        except Exception as exc:  # noqa: BLE001
            states.append(source_state(provider, {}, f"{type(exc).__name__}:{exc}"))
    try:
        no_trading = is_no_trading_day(expected, holiday_fetch())
    except Exception:  # The price sources remain fail-closed if calendar transport is unavailable.
        no_trading = datetime.strptime(expected, "%Y-%m-%d").date().weekday() >= 5
    return resolve(expected, states[0], states[1], no_trading, fetched_at)


def write_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(prefix=f"{path.stem}-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected-date", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    expected = iso_date(args.expected_date)
    if not expected:
        raise SystemExit("OFFICIAL_EOD_REJECTED invalid_expected_date")
    payload = collect(expected)
    write_atomic(Path(args.output).resolve(), payload)
    print(f"OFFICIAL_EOD_{payload['status']} expected={expected} provider={payload.get('provider')} source_date={payload.get('source_date')} fallback_used={payload.get('fallback_used')}")


if __name__ == "__main__":
    try:
        main()
    except (SourceConflict, LookAheadRejected) as exc:
        raise SystemExit(f"OFFICIAL_EOD_REJECTED {exc}") from exc
