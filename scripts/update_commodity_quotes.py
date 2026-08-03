#!/usr/bin/env python3
"""Update gold and Brent quotes from the configured licensed Twelve Data account.

No browser-visible API key is ever written to the repository.  When the secret is
not configured or a request fails, the last validated quote is retained and its
source status is downgraded instead of substituting zero or scraping a private URL.
"""
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
API = "https://api.twelvedata.com/time_series"
SOURCE_PAGE = "https://twelvedata.com/commodities"
INSTRUMENTS = {
    "gold": {"symbol": "XAU/USD", "name": "黃金現貨", "unit": "美元／盎司"},
    "brent": {"symbol": "XBR/USD", "name": "布蘭特原油", "unit": "美元／桶"},
}


def finite(value: object, *, positive: bool = False) -> float:
    if isinstance(value, bool):
        raise ValueError("boolean is not a quote")
    number = float(value)
    if not math.isfinite(number) or abs(number) > 1_000_000 or (positive and number <= 0):
        raise ValueError("invalid quote number")
    return number


def fetch_json(params: dict[str, str], timeout: int = 25) -> object:
    query = urllib.parse.urlencode(params)
    request = urllib.request.Request(f"{API}?{query}", headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status != 200:
            raise RuntimeError(f"HTTP {response.status}")
        return json.loads(response.read().decode("utf-8"))


def parse_time_series(payload: object, key: str, now: dt.datetime) -> dict[str, Any]:
    if not isinstance(payload, dict) or payload.get("status") == "error":
        raise ValueError("Twelve Data returned an error")
    values = payload.get("values")
    meta = payload.get("meta")
    if not isinstance(values, list) or len(values) < 2 or not isinstance(meta, dict):
        raise ValueError("time series does not contain two bars")
    latest, previous = values[0], values[1]
    if not isinstance(latest, dict) or not isinstance(previous, dict):
        raise ValueError("time series bar is invalid")
    definition = INSTRUMENTS[key]
    symbol = str(meta.get("symbol") or definition["symbol"])
    if symbol.upper().replace(" ", "") != definition["symbol"].upper():
        raise ValueError("commodity symbol mismatch")
    price = finite(latest.get("close"), positive=True)
    previous_close = finite(previous.get("close"), positive=True)
    open_price = finite(latest.get("open"), positive=True)
    high = finite(latest.get("high"), positive=True)
    low = finite(latest.get("low"), positive=True)
    volume_raw = latest.get("volume")
    volume = finite(volume_raw) if volume_raw not in (None, "") else None
    if high < low:
        raise ValueError("high is below low")
    timezone_name = str(meta.get("exchange_timezone") or "UTC")
    raw_time = str(latest.get("datetime") or "")
    try:
        quote_time = dt.datetime.fromisoformat(raw_time)
    except ValueError as exc:
        raise ValueError("commodity quote timestamp is invalid") from exc
    if quote_time.tzinfo is None:
        # Twelve Data commodity examples use UTC unless the response declares otherwise.
        if timezone_name.upper() not in {"UTC", "ETC/UTC"}:
            raise ValueError("timezone-aware quote is required")
        quote_time = quote_time.replace(tzinfo=dt.timezone.utc)
    quote_time = quote_time.astimezone(dt.timezone.utc)
    if quote_time > now + dt.timedelta(minutes=5) or now - quote_time > dt.timedelta(days=5):
        raise ValueError("commodity timestamp is unreasonable or stale")
    change = price - previous_close
    change_pct = change / previous_close * 100
    if abs(change_pct) > 30:
        raise ValueError("commodity change is unreasonable")
    return {
        "key": key,
        "symbol": definition["symbol"],
        "name": definition["name"],
        "value": round(price, 4),
        "previous_close": round(previous_close, 4),
        "change": round(change, 4),
        "change_pct": round(change_pct, 4),
        "open": round(open_price, 4),
        "high": round(high, 4),
        "low": round(low, 4),
        "volume": round(volume, 4) if volume is not None else None,
        "data_time": quote_time.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "unit": definition["unit"],
        "quote_mode": "delayed",
        "delay_note": "授權來源延遲行情｜每 1 分鐘資料｜僅供參考",
        "source_name": "Twelve Data Commodity API",
        "source_url": SOURCE_PAGE,
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
        return item.get("quote_mode") in {"delayed", "close"}
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
    api_key = os.environ.get("TWELVE_DATA_API_KEY", "").strip()
    old = previous_payload()
    old_items = old.get("items") if isinstance(old.get("items"), dict) else {}
    items: dict[str, Any] = {}
    status: dict[str, str] = {}
    for key, definition in INSTRUMENTS.items():
        try:
            if not api_key:
                raise RuntimeError("TWELVE_DATA_API_KEY is not configured")
            item = parse_time_series(fetch_json({
                "symbol": definition["symbol"], "interval": "1min", "outputsize": "2", "apikey": api_key
            }), key, now)
            items[key] = item
            status[key] = "ok"
        except Exception as exc:  # noqa: BLE001
            previous = old_items.get(key)
            if not valid_item(previous, key):
                raise RuntimeError(f"{key} quote failed without valid cache: {exc}") from exc
            items[key] = dict(previous)
            if not api_key:
                items[key]["source_name"] = "舊版最後成功快取（原來源已停用）"
                items[key]["source_url"] = ""
                items[key]["delay_note"] = "授權來源尚未設定｜資料可能過期｜僅供參考"
            status[key] = "not_configured_last_success" if not api_key else "cached_after_error"
    quote_version = "|".join(f"{key}:{items[key]['data_time']}:{items[key]['value']}" for key in sorted(items))
    payload = {
        "version": 2,
        "updated_at": old.get("updated_at") if old.get("quote_version") == quote_version else now.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "quote_version": quote_version,
        "label": "延遲行情｜來源時間為準｜僅供參考",
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
