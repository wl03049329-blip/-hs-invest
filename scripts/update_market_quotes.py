#!/usr/bin/env python3
"""Build same-origin delayed and closing quote caches from structured Taiwan sources.

TAIFEX DailyMarketReportFut is intentionally treated as official daily history only.
It must never be labelled as a current day-session or night-session quote.
"""

from __future__ import annotations

import json
import math
import os
import re
import tempfile
import urllib.parse
import urllib.request
from datetime import date, datetime, time, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "market-quotes.json"
META_OUTPUT = ROOT / "market-quotes-meta.json"
OVERVIEW_OUTPUT = ROOT / "market-overview.json"

TWSE_CLOSE_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"
TPEX_CLOSE_URL = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes"
TWSE_MIS_URL = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp"
TAIFEX_DAILY_URL = "https://openapi.taifex.com.tw/v1/DailyMarketReportFut"

TRACKED_CHANNELS = (
    "tse_t00.tw",
    "otc_o00.tw",
    "tse_2330.tw",
    "tse_0050.tw",
    "tse_00631L.tw",
    "tse_00662.tw",
    "tse_00830.tw",
    "otc_009815.tw",
)
OVERVIEW_CODES = {
    "T00": ("taiex", "台股加權指數"),
    "O00": ("otc", "櫃買指數"),
    "2330": ("tsmc", "台積電 2330"),
}
CODE_RE = re.compile(r"^[0-9A-Z]{4,10}$")
TAIPEI = ZoneInfo("Asia/Taipei")


def fetch_json(url: str, *, timeout: int = 25) -> Any:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "HS-ETF-Radar-V6.1/1.0"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status != 200:
            raise RuntimeError(f"{url} returned HTTP {response.status}")
        payload = json.load(response)
    return payload


def finite_number(value: Any, *, positive: bool = False) -> float | None:
    try:
        parsed = float(str(value).replace(",", "").replace("%", "").strip())
    except (TypeError, ValueError):
        return None
    if not math.isfinite(parsed) or abs(parsed) >= 1_000_000_000:
        return None
    if positive and parsed <= 0:
        return None
    return parsed


def iso_date(value: Any) -> str | None:
    digits = re.sub(r"\D", "", str(value or ""))
    if len(digits) == 7:
        digits = f"{int(digits[:3]) + 1911:04d}{digits[3:]}"
    if len(digits) != 8:
        return None
    result = f"{digits[:4]}-{digits[4:6]}-{digits[6:8]}"
    try:
        datetime.strptime(result, "%Y-%m-%d")
    except ValueError:
        return None
    return result


def clean_text(value: Any, maximum: int = 40) -> str:
    text = re.sub(r"[\x00-\x1f\x7f<>]", "", str(value or ""))
    return re.sub(r"\s+", " ", text).strip()[:maximum]


def existing_payload(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def write_atomic(path: Path, payload: dict[str, Any], *, compact: bool = False) -> None:
    text = (
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        if compact
        else json.dumps(payload, ensure_ascii=False, indent=2)
    ) + "\n"
    handle, temp_name = tempfile.mkstemp(prefix=f"{path.stem}-", suffix=".json", dir=ROOT)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def normalize_close_rows(rows: list[dict[str, Any]], market: str) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for row in rows:
        if market == "TWSE":
            code = str(row.get("Code", "")).strip().upper()
            name = row.get("Name", "")
            price = finite_number(row.get("ClosingPrice"), positive=True)
            change = finite_number(row.get("Change"))
            data_date = iso_date(row.get("Date"))
        else:
            code = str(row.get("SecuritiesCompanyCode", "")).strip().upper()
            name = row.get("CompanyName", "")
            price = finite_number(row.get("Close"), positive=True)
            change = finite_number(row.get("Change"))
            data_date = iso_date(row.get("Date"))
        if not CODE_RE.fullmatch(code) or price is None or data_date is None:
            continue
        previous_close = price - change if change is not None and price - change > 0 else None
        output.append(
            {
                "code": code,
                "name": clean_text(name),
                "price": price,
                "previous_close": previous_close,
                "date": data_date,
                "market": market,
                "quote_mode": "close",
                "quote_time": "收盤",
            }
        )
    if not output:
        raise ValueError(f"{market} returned no valid closing rows")
    return output


def fetch_mis_snapshot() -> list[dict[str, Any]]:
    query = urllib.parse.urlencode(
        {"ex_ch": "|".join(TRACKED_CHANNELS), "json": "1", "delay": "0"}
    )
    payload = fetch_json(f"{TWSE_MIS_URL}?{query}", timeout=20)
    rows = payload.get("msgArray") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise ValueError("TWSE MIS response has no msgArray")
    valid = []
    for row in rows:
        code = str(row.get("c", "")).strip().upper()
        price = finite_number(row.get("z"), positive=True)
        previous_close = finite_number(row.get("y"), positive=True)
        data_date = iso_date(row.get("d") or row.get("^"))
        quote_time = str(row.get("t") or row.get("%") or "").strip()
        if not code or price is None or previous_close is None or data_date is None:
            continue
        if quote_time and not re.fullmatch(r"\d{2}:\d{2}:\d{2}", quote_time):
            continue
        valid.append(
            {
                "code": code,
                "name": clean_text(row.get("n")),
                "price": price,
                "previous_close": previous_close,
                "date": data_date,
                "quote_time": quote_time or "—",
                "market": "TPEx" if row.get("ex") == "otc" else "TWSE",
            }
        )
    if not all(any(row["code"] == code for row in valid) for code in OVERVIEW_CODES):
        raise ValueError("TWSE MIS snapshot is missing a required market instrument")
    return valid


def spot_quote_mode(now: datetime, data_date: str) -> str:
    weekday = now.weekday() < 5
    in_session = time(9, 0) <= now.time() <= time(13, 30)
    return "delayed" if weekday and in_session and data_date == now.date().isoformat() else "close"


def third_wednesday(year: int, month: int) -> date:
    first = date(year, month, 1)
    first_wednesday = 1 + (2 - first.weekday()) % 7
    return date(year, month, first_wednesday + 14)


def select_near_month_tx(rows: list[dict[str, Any]]) -> dict[str, Any]:
    candidates: list[tuple[str, dict[str, Any]]] = []
    dates = sorted(
        {iso_date(row.get("Date")) for row in rows if row.get("Contract") == "TX"},
        reverse=True,
    )
    latest_date = next((value for value in dates if value), None)
    if latest_date is None:
        raise ValueError("TAIFEX daily report has no TX date")
    trade_date = datetime.strptime(latest_date, "%Y-%m-%d").date()
    for row in rows:
        month = str(row.get("ContractMonth(Week)", "")).strip()
        if row.get("Contract") != "TX" or iso_date(row.get("Date")) != latest_date:
            continue
        if row.get("TradingSession") != "一般" or not re.fullmatch(r"\d{6}", month):
            continue
        expiry = third_wednesday(int(month[:4]), int(month[4:]))
        oi = finite_number(row.get("OpenInterest"), positive=True)
        price = finite_number(row.get("Last"), positive=True)
        if expiry < trade_date or oi is None or price is None:
            continue
        candidates.append((month, row))
    if not candidates:
        raise ValueError("TAIFEX daily report has no valid unexpired TX month")
    contract_month, day_row = min(candidates, key=lambda item: item[0])
    night_rows = [
        row
        for row in rows
        if row.get("Contract") == "TX"
        and str(row.get("ContractMonth(Week)", "")).strip() == contract_month
        and row.get("TradingSession") == "盤後"
        and finite_number(row.get("Last"), positive=True) is not None
    ]
    selected = max(night_rows, key=lambda row: str(row.get("Date", ""))) if night_rows else day_row
    price = finite_number(selected.get("Last"), positive=True)
    change = finite_number(selected.get("Change"))
    pct = finite_number(selected.get("%"))
    if price is None or change is None or pct is None:
        raise ValueError("TAIFEX TX row has invalid price fields")
    return {
        "key": "tx_front",
        "name": "台指期近月",
        "value": price,
        "change": change,
        "change_pct": pct,
        "previous_close": price - change if price - change > 0 else None,
        "data_date": iso_date(selected.get("Date")),
        "data_time": "盤後收盤" if selected.get("TradingSession") == "盤後" else "日盤收盤",
        "source_session": "night_close" if selected.get("TradingSession") == "盤後" else "day_close",
        "quote_mode": "close",
        "contract_month": contract_month,
        "source": TAIFEX_DAILY_URL,
        "source_status": "official_daily_close_only",
        "availability": "official_close_only",
    }


def build_overview(
    mis_rows: list[dict[str, Any]], futures_row: dict[str, Any], now: datetime
) -> dict[str, Any]:
    instruments: dict[str, dict[str, Any]] = {}
    for row in mis_rows:
        definition = OVERVIEW_CODES.get(row["code"])
        if not definition:
            continue
        key, name = definition
        mode = spot_quote_mode(now, row["date"])
        change = row["price"] - row["previous_close"]
        instruments[key] = {
            "key": key,
            "name": name,
            "value": row["price"],
            "change": change,
            "change_pct": change / row["previous_close"] * 100,
            "previous_close": row["previous_close"],
            "data_date": row["date"],
            "data_time": row["quote_time"],
            "source_session": "spot",
            "quote_mode": mode,
            "source": TWSE_MIS_URL,
            "source_status": "ok",
        }
    instruments["tx_front"] = futures_row
    if set(instruments) != {"taiex", "otc", "tx_front", "tsmc"}:
        raise ValueError("market overview does not contain four valid instruments")
    comparable = instruments
    for item in comparable.values():
        if finite_number(item["value"], positive=True) is None:
            raise ValueError("market overview contains an invalid value")
        if finite_number(item["change"]) is None or finite_number(item["change_pct"]) is None:
            raise ValueError("market overview contains invalid change data")
    return {
        "version": 1,
        "updated_at": now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "label": "盤中延遲行情｜約每 5 分鐘更新｜僅供參考",
        "instruments": instruments,
        "source_status": {
            "spot": "ok",
            "futures": "official_daily_close_only",
            "futures_note": "期交所免費 OpenAPI 僅提供每日歷史行情；日盤或夜盤期間必須標示過期，不冒充盤中報價。",
        },
    }


def validate_quote_items(items: list[dict[str, Any]]) -> None:
    if not items or len(items) > 10_000:
        raise ValueError("quote item count is unreasonable")
    codes: set[str] = set()
    for item in items:
        code = item.get("code")
        if not isinstance(code, str) or not CODE_RE.fullmatch(code) or code in codes:
            raise ValueError(f"invalid or duplicate quote code: {code!r}")
        codes.add(code)
        if finite_number(item.get("price"), positive=True) is None:
            raise ValueError(f"invalid price for {code}")
        if item.get("quote_mode") not in {"delayed", "close"}:
            raise ValueError(f"invalid quote mode for {code}")
        datetime.strptime(str(item.get("date", "")), "%Y-%m-%d")


def write_market_cache(
    items: list[dict[str, Any]],
    statuses: dict[str, str],
    now: datetime,
    existing: dict[str, Any],
) -> None:
    items = sorted({item["code"]: item for item in items}.values(), key=lambda item: item["code"])
    validate_quote_items(items)
    if existing.get("items") == items:
        payload = existing
    else:
        payload = {
            "version": 2,
            "updated_at": now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
            "source_dates": {
                market: max(
                    item["date"] for item in items if item.get("market") == market
                )
                for market in ("TWSE", "TPEx")
                if any(item.get("market") == market for item in items)
            },
            "source_status": statuses,
            "sources": {
                "TWSE_close": TWSE_CLOSE_URL,
                "TPEx_close": TPEX_CLOSE_URL,
                "TWSE_delayed_snapshot": TWSE_MIS_URL,
            },
            "items": items,
        }
    write_atomic(OUTPUT, payload, compact=True)
    meta = {
        "version": payload["version"],
        "updated_at": payload["updated_at"],
        "source_dates": payload["source_dates"],
        "source_status": payload["source_status"],
        "item_count": len(payload["items"]),
    }
    write_atomic(META_OUTPUT, meta)


def main() -> None:
    now = datetime.now(TAIPEI)
    existing_quotes = existing_payload(OUTPUT)
    existing_overview = existing_payload(OVERVIEW_OUTPUT)
    items_by_market: dict[str, list[dict[str, Any]]] = {}
    statuses: dict[str, str] = {}
    for market, url in (("TWSE", TWSE_CLOSE_URL), ("TPEx", TPEX_CLOSE_URL)):
        try:
            payload = fetch_json(url)
            if not isinstance(payload, list):
                raise ValueError(f"{market} closing source is not an array")
            items_by_market[market] = normalize_close_rows(payload, market)
            statuses[market] = "official_closing_data"
        except Exception as exc:  # noqa: BLE001
            previous = [
                item for item in existing_quotes.get("items", []) if item.get("market") == market
            ]
            if not previous:
                raise RuntimeError(f"{market} closing source failed: {exc}") from exc
            items_by_market[market] = previous
            statuses[market] = "cached_after_error"

    mis_rows: list[dict[str, Any]] = []
    try:
        mis_rows = fetch_mis_snapshot()
        statuses["TWSE_MIS"] = "ok"
        item_map = {
            item["code"]: item
            for rows in items_by_market.values()
            for item in rows
        }
        for row in mis_rows:
            if not CODE_RE.fullmatch(row["code"]):
                continue
            old = item_map.get(row["code"], {})
            mode = spot_quote_mode(now, row["date"])
            item_map[row["code"]] = {
                "code": row["code"],
                "name": row["name"] or old.get("name", row["code"]),
                "price": row["price"],
                "previous_close": row["previous_close"],
                "date": row["date"],
                "market": row["market"],
                "quote_mode": mode,
                "quote_time": row["quote_time"],
            }
        items = list(item_map.values())
    except Exception as exc:  # noqa: BLE001
        statuses["TWSE_MIS"] = f"cached_after_error: {clean_text(exc, 100)}"
        items = [item for rows in items_by_market.values() for item in rows]

    write_market_cache(items, statuses, now, existing_quotes)

    try:
        if not mis_rows:
            raise ValueError("spot snapshot unavailable")
        futures_payload = fetch_json(TAIFEX_DAILY_URL)
        if not isinstance(futures_payload, list):
            raise ValueError("TAIFEX daily report is not an array")
        overview = build_overview(mis_rows, select_near_month_tx(futures_payload), now)
        comparable = overview["instruments"]
        previous_comparable = {
            key: item
            for key, item in existing_overview.get("instruments", {}).items()
            if isinstance(item, dict)
        }
        if previous_comparable == comparable:
            overview = existing_overview
        write_atomic(OVERVIEW_OUTPUT, overview)
    except Exception as exc:  # noqa: BLE001
        if existing_overview:
            print(f"Market overview kept after source failure: {exc}")
        else:
            raise
    print(f"Updated quote cache with {len(items)} symbols and validated market overview.")


if __name__ == "__main__":
    main()
