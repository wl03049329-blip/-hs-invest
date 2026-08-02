#!/usr/bin/env python3
"""Update validated delayed gold and Brent crude futures quote cache."""
from __future__ import annotations

import datetime as dt
import json
import math
import os
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "commodity-quotes.json"
API = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=5m&range=1d"
SOURCE_PAGE = "https://finance.yahoo.com/markets/commodities/"
TAIPEI = dt.timezone(dt.timedelta(hours=8))
INSTRUMENTS = {
    "gold": {"symbol": "GC=F", "name": "黃金期貨", "unit": "美元／盎司"},
    "brent": {"symbol": "BZ=F", "name": "布蘭特原油", "unit": "美元／桶"},
}


def finite(value: object, *, positive: bool = False) -> float:
    if isinstance(value, bool):
        raise ValueError("boolean is not a quote")
    number = float(value)
    if not math.isfinite(number) or abs(number) > 1_000_000 or (positive and number <= 0):
        raise ValueError("invalid quote number")
    return number


def fetch_json(url: str, timeout: int = 25) -> object:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "Mozilla/5.0 HS-ETF-Radar/6.2"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status != 200:
            raise RuntimeError(f"HTTP {response.status}")
        return json.loads(response.read().decode("utf-8"))


def parse_chart(payload: object, key: str, now: dt.datetime) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("chart payload is not an object")
    chart = payload.get("chart")
    results = chart.get("result") if isinstance(chart, dict) else None
    if not isinstance(results, list) or len(results) != 1 or not isinstance(results[0], dict):
        raise ValueError("chart result is missing")
    meta = results[0].get("meta")
    if not isinstance(meta, dict):
        raise ValueError("chart meta is missing")
    definition = INSTRUMENTS[key]
    if meta.get("symbol") != definition["symbol"]:
        raise ValueError("chart symbol mismatch")
    price = finite(meta.get("regularMarketPrice"), positive=True)
    previous = finite(meta.get("previousClose") or meta.get("chartPreviousClose"), positive=True)
    try:
        quote_epoch = int(meta.get("regularMarketTime"))
    except (TypeError, ValueError) as exc:
        raise ValueError("commodity quote timestamp is invalid") from exc
    if quote_epoch < 1_500_000_000 or quote_epoch > 4_000_000_000:
        raise ValueError("commodity quote timestamp is outside the supported range")
    quote_time = dt.datetime.fromtimestamp(quote_epoch, dt.timezone.utc)
    if quote_time > now + dt.timedelta(hours=2) or now - quote_time > dt.timedelta(days=5):
        raise ValueError("commodity quote timestamp is unreasonable or stale")
    change = price - previous
    change_pct = change / previous * 100
    if abs(change_pct) > 30:
        raise ValueError("commodity daily change is unreasonable")
    return {
        "key": key,
        "symbol": definition["symbol"],
        "name": definition["name"],
        "value": round(price, 4),
        "previous_close": round(previous, 4),
        "change": round(change, 4),
        "change_pct": round(change_pct, 4),
        "data_time": quote_time.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "unit": definition["unit"],
        "quote_mode": "delayed",
        "delay_note": "免費延遲行情｜通常延遲 15 分鐘以上｜僅供參考",
        "source_name": "Yahoo Finance chart JSON",
        "source_url": SOURCE_PAGE,
        "source_endpoint": API.format(symbol=urllib.parse.quote(definition["symbol"], safe="")),
    }


def valid_item(item: object, key: str) -> bool:
    try:
        if not isinstance(item, dict) or item.get("key") != key:
            return False
        finite(item.get("value"), positive=True)
        finite(item.get("previous_close"), positive=True)
        finite(item.get("change"))
        finite(item.get("change_pct"))
        dt.datetime.fromisoformat(str(item.get("data_time", "")).replace("Z", "+00:00"))
        return item.get("quote_mode") == "delayed"
    except (TypeError, ValueError):
        return False


def previous_payload() -> dict[str, Any]:
    try:
        payload = json.loads(OUT.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def build_payload(now: dt.datetime | None = None) -> dict[str, Any]:
    now = (now or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone.utc)
    old = previous_payload()
    old_items = old.get("items") if isinstance(old.get("items"), dict) else {}
    items: dict[str, Any] = {}
    status: dict[str, str] = {}
    for key, definition in INSTRUMENTS.items():
        try:
            endpoint = API.format(symbol=urllib.parse.quote(definition["symbol"], safe=""))
            item = parse_chart(fetch_json(endpoint), key, now)
            items[key] = item
            status[key] = "ok"
        except Exception as exc:  # noqa: BLE001
            previous = old_items.get(key)
            if not valid_item(previous, key):
                raise RuntimeError(f"{key} quote failed without valid cache: {exc}") from exc
            items[key] = previous
            status[key] = "cached_after_error"
    quote_version = "|".join(f"{key}:{items[key]['data_time']}:{items[key]['value']}" for key in sorted(items))
    if old.get("quote_version") == quote_version:
        updated_at = old.get("updated_at")
    else:
        updated_at = now.isoformat(timespec="seconds").replace("+00:00", "Z")
    payload = {
        "version": 1,
        "updated_at": updated_at,
        "quote_version": quote_version,
        "label": "免費延遲行情｜通常延遲 15 分鐘以上｜僅供參考",
        "items": items,
        "source_status": status,
    }
    json.dumps(payload, ensure_ascii=False, allow_nan=False)
    return payload


def atomic_write(payload: dict[str, Any]) -> None:
    handle, temp_name = tempfile.mkstemp(prefix="commodity-quotes-", suffix=".json", dir=ROOT)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
        os.replace(temp_name, OUT)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def main() -> int:
    payload = build_payload()
    atomic_write(payload)
    print(f"commodity cache: {payload['quote_version']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
