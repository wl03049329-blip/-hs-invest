#!/usr/bin/env python3
"""Build a same-origin delayed/closing quote cache from official Taiwan bulk APIs."""

from __future__ import annotations

import json
import os
import re
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "market-quotes.json"
META_OUTPUT = ROOT / "market-quotes-meta.json"
TWSE_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"
TPEX_URL = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes"
CODE_RE = re.compile(r"^[0-9A-Z]{4,10}$")


def fetch_json(url: str) -> list[dict[str, Any]]:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "HS-Invest-V6/1.0"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status != 200:
            raise RuntimeError(f"{url} returned HTTP {response.status}")
        payload = json.load(response)
    if not isinstance(payload, list):
        raise ValueError(f"{url} did not return a JSON array")
    return payload


def number(value: Any) -> float | None:
    try:
        parsed = float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    return parsed if 0 < parsed < 1_000_000_000 else None


def roc_date(value: Any) -> str | None:
    digits = re.sub(r"\D", "", str(value))
    if len(digits) != 7:
        return None
    year = int(digits[:3]) + 1911
    result = f"{year:04d}-{digits[3:5]}-{digits[5:7]}"
    try:
        datetime.strptime(result, "%Y-%m-%d")
    except ValueError:
        return None
    return result


def clean_text(value: Any, maximum: int = 40) -> str:
    text = re.sub(r"[\x00-\x1f\x7f<>]", "", str(value or ""))
    return re.sub(r"\s+", " ", text).strip()[:maximum]


def normalize_rows(rows: list[dict[str, Any]], market: str) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for row in rows:
        if market == "TWSE":
            code = str(row.get("Code", "")).strip().upper()
            name = row.get("Name", "")
            price = number(row.get("ClosingPrice"))
            change_value = row.get("Change")
            date = roc_date(row.get("Date"))
        else:
            code = str(row.get("SecuritiesCompanyCode", "")).strip().upper()
            name = row.get("CompanyName", "")
            price = number(row.get("Close"))
            change_value = row.get("Change")
            date = roc_date(row.get("Date"))
        if not CODE_RE.fullmatch(code) or price is None or date is None:
            continue
        try:
            change = float(str(change_value).replace(",", "").strip())
        except (TypeError, ValueError):
            change = None
        previous_close = price - change if change is not None and price - change > 0 else None
        output.append(
            {
                "code": code,
                "name": clean_text(name),
                "price": price,
                "previous_close": previous_close,
                "date": date,
                "market": market,
            }
        )
    if not output:
        raise ValueError(f"{market} returned no valid quote rows")
    return output


def existing_payload() -> dict[str, Any]:
    try:
        data = json.loads(OUTPUT.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def validate_items(items: list[dict[str, Any]]) -> None:
    if not items or len(items) > 10_000:
        raise ValueError("quote item count is unreasonable")
    codes: set[str] = set()
    for item in items:
        code = item.get("code")
        if not isinstance(code, str) or not CODE_RE.fullmatch(code) or code in codes:
            raise ValueError(f"invalid or duplicate quote code: {code!r}")
        codes.add(code)
        if number(item.get("price")) is None:
            raise ValueError(f"invalid price for {code}")
        try:
            datetime.strptime(str(item.get("date", "")), "%Y-%m-%d")
        except ValueError as exc:
            raise ValueError(f"invalid date for {code}") from exc


def write_atomic(payload: dict[str, Any]) -> None:
    # The full-market cache is read on phones; compact JSON saves substantial bandwidth.
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
    handle, temp_name = tempfile.mkstemp(prefix="market-quotes-", suffix=".json", dir=ROOT)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
        os.replace(temp_name, OUTPUT)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def write_meta(payload: dict[str, Any]) -> None:
    meta = {
        "version": payload["version"],
        "updated_at": payload["updated_at"],
        "source_dates": payload["source_dates"],
        "source_status": payload["source_status"],
        "item_count": len(payload["items"]),
    }
    text = json.dumps(meta, ensure_ascii=False, indent=2) + "\n"
    handle, temp_name = tempfile.mkstemp(prefix="market-quotes-meta-", suffix=".json", dir=ROOT)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
        os.replace(temp_name, META_OUTPUT)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def main() -> None:
    existing = existing_payload()
    items_by_market: dict[str, list[dict[str, Any]]] = {}
    errors: dict[str, str] = {}
    for market, url in (("TWSE", TWSE_URL), ("TPEx", TPEX_URL)):
        try:
            items_by_market[market] = normalize_rows(fetch_json(url), market)
        except Exception as exc:  # noqa: BLE001 - keep the other official market usable
            errors[market] = str(exc)
            previous = [item for item in existing.get("items", []) if item.get("market") == market]
            if previous:
                items_by_market[market] = previous
    if not items_by_market:
        raise RuntimeError(f"all quote sources failed: {errors}")
    items = sorted(
        (item for group in items_by_market.values() for item in group),
        key=lambda item: (item["code"], item["market"]),
    )
    deduplicated = {item["code"]: item for item in items}
    items = sorted(deduplicated.values(), key=lambda item: item["code"])
    validate_items(items)
    if existing.get("items") == items:
        if existing:
            write_atomic(existing)
            write_meta(existing)
        print(f"Market quote cache unchanged ({len(items)} symbols).")
        return
    payload = {
        "version": 1,
        "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source_dates": {
            market: max(item["date"] for item in rows)
            for market, rows in items_by_market.items()
        },
        "source_status": {
            market: ("cached_after_error" if market in errors else "ok")
            for market in items_by_market
        },
        "sources": {"TWSE": TWSE_URL, "TPEx": TPEX_URL},
        "items": items,
    }
    write_atomic(payload)
    write_meta(payload)
    print(f"Updated {OUTPUT.name} with {len(items)} symbols.")


if __name__ == "__main__":
    main()
