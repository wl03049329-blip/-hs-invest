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
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "market-quotes.json"
META_OUTPUT = ROOT / "market-quotes-meta.json"
OVERVIEW_OUTPUT = ROOT / "market-overview.json"
FUTURES_OUTPUT = ROOT / "tx-futures-quote.json"

TWSE_CLOSE_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"
TPEX_CLOSE_URL = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes"
TWSE_MIS_URL = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp"
TAIFEX_DAILY_URL = "https://openapi.taifex.com.tw/v1/DailyMarketReportFut"

BASE_TRACKED_CHANNELS = (
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
    "O00": ("otc", "上櫃指數"),
    "2330": ("tsmc", "台積電 2330"),
}
CODE_RE = re.compile(r"^[0-9A-Z]{4,10}$")
TAIPEI = ZoneInfo("Asia/Taipei")
RADAR_CODES = ("0050", "00662", "00830", "00935", "009815")
RADAR_SLOTS = ("09:30", "10:30", "11:30", "12:30", "13:30")
RADAR_QUOTE_TOLERANCE_MINUTES = 20


def fetch_json(url: str, *, timeout: int = 25) -> Any:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json"},
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


def tracked_channels() -> list[str]:
    channels = set(BASE_TRACKED_CHANNELS)
    universe = existing_payload(ROOT / "etf-universe.json")
    for item in universe.get("items", []):
        code = str(item.get("code", "")).strip().upper()
        exchange = str(item.get("exchange", "")).strip()
        if CODE_RE.fullmatch(code) and exchange in {"TWSE", "TPEx"}:
            channels.add(f"{'otc' if exchange == 'TPEx' else 'tse'}_{code}.tw")
    return sorted(channels)


def fetch_mis_snapshot() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    channels = tracked_channels()
    for offset in range(0, len(channels), 60):
        query = urllib.parse.urlencode(
            {"ex_ch": "|".join(channels[offset : offset + 60]), "json": "1", "delay": "0"}
        )
        payload = fetch_json(f"{TWSE_MIS_URL}?{query}", timeout=20)
        batch = payload.get("msgArray") if isinstance(payload, dict) else None
        if not isinstance(batch, list):
            raise ValueError("TWSE MIS response has no msgArray")
        rows.extend(batch)
    valid = []
    for row in rows:
        code = str(row.get("c", "")).strip().upper()
        price = finite_number(row.get("z"), positive=True)
        previous_close = finite_number(row.get("y"), positive=True)
        data_date = iso_date(row.get("d") or row.get("^"))
        quote_time = str(row.get("t") or row.get("%") or "").strip()
        high = finite_number(row.get("h"), positive=True)
        low = finite_number(row.get("l"), positive=True)
        open_price = finite_number(row.get("o"), positive=True)
        volume_lots = finite_number(row.get("v"))
        volume = volume_lots * 1000 if volume_lots is not None and volume_lots >= 0 else None
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
                "high": high,
                "low": low,
                "open": open_price,
                "volume": volume,
                "source": TWSE_MIS_URL,
            }
        )
    if not all(any(row["code"] == code for row in valid) for code in OVERVIEW_CODES):
        raise ValueError("TWSE MIS snapshot is missing a required market instrument")
    return valid


def quote_datetime(data_date: str, quote_time: str) -> datetime | None:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(data_date or "")):
        return None
    if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d", str(quote_time or "")):
        return None
    try:
        return datetime.fromisoformat(f"{data_date}T{quote_time}").replace(tzinfo=TAIPEI)
    except ValueError:
        return None


def spot_quote_mode(now: datetime, data_date: str, quote_time: str = "") -> str:
    """Classify by the source quote timestamp, never by job completion time."""
    quote_at = quote_datetime(data_date, quote_time)
    if quote_at is None or quote_at.weekday() >= 5:
        return "close"
    in_session = time(9, 0) <= quote_at.time() <= time(13, 30, 59)
    return "delayed" if in_session else "close"


def validate_radar_refresh(
    rows: list[dict[str, Any]], trading_date: str, slot: str, verified_at: datetime
) -> dict[str, Any]:
    if slot not in RADAR_SLOTS:
        raise ValueError(f"unsupported radar slot: {slot}")
    if trading_date != verified_at.astimezone(TAIPEI).date().isoformat():
        raise ValueError("radar trading date is not Taipei today")
    target = datetime.fromisoformat(f"{trading_date}T{slot}:00").replace(tzinfo=TAIPEI)
    minimum = target - timedelta(minutes=RADAR_QUOTE_TOLERANCE_MINUTES)
    maximum = target + timedelta(minutes=RADAR_QUOTE_TOLERANCE_MINUTES)
    by_code = {str(row.get("code", "")): row for row in rows}
    quote_times: dict[str, str] = {}
    market_as_of: dict[str, str] = {}
    for code in RADAR_CODES:
        row = by_code.get(code)
        if not row:
            raise ValueError(f"radar quote missing: {code}")
        if row.get("date") != trading_date:
            raise ValueError(f"radar quote date mismatch: {code}")
        if row.get("source") != TWSE_MIS_URL:
            raise ValueError(f"radar quote source mismatch: {code}")
        price = finite_number(row.get("price"), positive=True)
        open_price = finite_number(row.get("open"), positive=True)
        high = finite_number(row.get("high"), positive=True)
        low = finite_number(row.get("low"), positive=True)
        if None in (price, open_price, high, low) or high < low:
            raise ValueError(f"radar OHLC invalid: {code}")
        if price < low * 0.999 or price > high * 1.001:
            raise ValueError(f"radar price outside high/low: {code}")
        quote_at = quote_datetime(trading_date, str(row.get("quote_time", "")))
        if quote_at is None or quote_at < minimum or quote_at > maximum:
            raise ValueError(f"radar quote time outside {slot} window: {code}")
        quote_times[code] = quote_at.strftime("%H:%M:%S")
        market_as_of[code] = quote_at.isoformat()
    return {
        "verified": True,
        "trading_date": trading_date,
        "slot": slot,
        "verified_at": verified_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "codes": list(RADAR_CODES),
        "quote_times": quote_times,
        "market_as_of": market_as_of,
        "source": "TWSE_MIS",
        "source_url": TWSE_MIS_URL,
    }


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


def normalize_tx_session(row: dict[str, Any], contract_month: str) -> dict[str, Any]:
    price = finite_number(row.get("Last"), positive=True)
    change = finite_number(row.get("Change"))
    pct = finite_number(row.get("%"))
    data_date = iso_date(row.get("Date"))
    session = "night" if row.get("TradingSession") == "盤後" else "day"
    if price is None or change is None or pct is None or data_date is None:
        raise ValueError("TAIFEX TX session row is invalid")
    previous_close = price - change
    if previous_close <= 0:
        raise ValueError("TAIFEX TX previous close is invalid")
    return {
        "key": f"tx_{session}",
        "name": "台指期夜盤" if session == "night" else "台指期日盤",
        "value": price,
        "previous_close": previous_close,
        "change": change,
        "change_pct": pct,
        "open": finite_number(row.get("Open"), positive=True),
        "high": finite_number(row.get("High"), positive=True),
        "low": finite_number(row.get("Low"), positive=True),
        "volume": finite_number(row.get("Volume")),
        "data_date": data_date,
        "data_time": "夜盤正式收盤" if session == "night" else "日盤正式收盤",
        "quote_time": f"{data_date}T{'05:00:00' if session == 'night' else '13:45:00'}+08:00",
        "quote_mode": "close",
        "source_session": session,
        "contract_month": contract_month,
        "source_name": "臺灣期貨交易所每日行情",
        "source_url": TAIFEX_DAILY_URL,
        "source_status": "official_daily_close_only",
    }


def build_tx_fallback(rows: list[dict[str, Any]], now: datetime) -> dict[str, Any]:
    selected = select_near_month_tx(rows)
    contract_month = selected["contract_month"]
    matching = [
        row
        for row in rows
        if row.get("Contract") == "TX"
        and str(row.get("ContractMonth(Week)", "")).strip() == contract_month
        and row.get("TradingSession") in {"一般", "盤後"}
        and iso_date(row.get("Date"))
    ]
    sessions: dict[str, dict[str, Any]] = {}
    for source_name, key in (("一般", "day"), ("盤後", "night")):
        candidates = [row for row in matching if row.get("TradingSession") == source_name]
        if candidates:
            row = max(candidates, key=lambda entry: iso_date(entry.get("Date")) or "")
            sessions[key] = normalize_tx_session(row, contract_month)
    return {
        "version": 1,
        "updated_at": now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "availability": "official_close_only",
        "authorized_intraday": False,
        "message": "台指期盤中行情需串接授權來源",
        "fallback_message": "目前顯示最近官方收盤資料",
        "contract_month": contract_month,
        "sessions": sessions,
        "source_name": "臺灣期貨交易所每日行情",
        "source_url": TAIFEX_DAILY_URL,
        "source_status": "official_daily_close_only",
    }


def build_overview(mis_rows: list[dict[str, Any]], now: datetime) -> dict[str, Any]:
    instruments: dict[str, dict[str, Any]] = {}
    for row in mis_rows:
        definition = OVERVIEW_CODES.get(row["code"])
        if not definition:
            continue
        key, name = definition
        mode = spot_quote_mode(now, row["date"], row["quote_time"])
        change = row["price"] - row["previous_close"]
        instruments[key] = {
            "key": key,
            "name": name,
            "value": row["price"],
            "change": change,
            "change_pct": change / row["previous_close"] * 100,
            "previous_close": row["previous_close"],
            "open": row.get("open"),
            "high": row.get("high"),
            "low": row.get("low"),
            "volume": row.get("volume"),
            "data_date": row["date"],
            "data_time": row["quote_time"],
            "quote_time": f"{row['date']}T{row['quote_time']}+08:00" if row["quote_time"] != "—" else None,
            "source_session": "spot",
            "quote_mode": mode,
            "source": TWSE_MIS_URL,
            "source_status": "ok",
        }
    if set(instruments) != {"taiex", "otc", "tsmc"}:
        raise ValueError("market overview does not contain three valid instruments")
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
    radar_refresh: dict[str, Any] | None = None,
    refresh_attempt: dict[str, Any] | None = None,
) -> None:
    items = sorted({item["code"]: item for item in items}.values(), key=lambda item: item["code"])
    validate_quote_items(items)
    if existing.get("items") == items and not radar_refresh:
        payload = dict(existing)
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
        if radar_refresh:
            payload["radar_refresh"] = radar_refresh
        elif isinstance(existing.get("radar_refresh"), dict):
            payload["radar_refresh"] = existing["radar_refresh"]
    if refresh_attempt:
        payload["radar_refresh_attempt"] = refresh_attempt
    elif isinstance(existing.get("radar_refresh_attempt"), dict):
        payload["radar_refresh_attempt"] = existing["radar_refresh_attempt"]
    write_atomic(OUTPUT, payload, compact=True)
    meta = {
        "version": payload["version"],
        "updated_at": payload["updated_at"],
        "source_dates": payload["source_dates"],
        "source_status": payload["source_status"],
        "item_count": len(payload["items"]),
        "radar_refresh": payload.get("radar_refresh"),
        "radar_refresh_attempt": payload.get("radar_refresh_attempt"),
    }
    write_atomic(META_OUTPUT, meta)


def main() -> None:
    now = datetime.now(TAIPEI)
    requested_slot = str(os.environ.get("HS_RADAR_SLOT", "")).strip()
    requested_date = str(os.environ.get("HS_RADAR_TRADING_DATE", now.date().isoformat())).strip()
    existing_quotes = existing_payload(OUTPUT)
    existing_overview = existing_payload(OVERVIEW_OUTPUT)
    existing_futures = existing_payload(FUTURES_OUTPUT)
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
    radar_refresh: dict[str, Any] | None = None
    refresh_attempt: dict[str, Any] | None = None
    try:
        mis_rows = fetch_mis_snapshot()
        if requested_slot:
            radar_refresh = validate_radar_refresh(mis_rows, requested_date, requested_slot, now)
            refresh_attempt = {**radar_refresh, "status": "success"}
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
            mode = spot_quote_mode(now, row["date"], row["quote_time"])
            item_map[row["code"]] = {
                "code": row["code"],
                "name": row["name"] or old.get("name", row["code"]),
                "price": row["price"],
                "previous_close": row["previous_close"],
                "date": row["date"],
                "market": row["market"],
                "quote_mode": mode,
                "quote_time": row["quote_time"],
                "open": row.get("open"),
                "high": row.get("high"),
                "low": row.get("low"),
                "volume": row.get("volume"),
            }
        items = list(item_map.values())
    except Exception as exc:  # noqa: BLE001
        error_text = clean_text(exc, 100)
        statuses["TWSE_MIS"] = f"cached_after_error: {error_text}"
        if requested_slot and existing_quotes.get("items"):
            items = existing_quotes["items"]
            statuses = dict(existing_quotes.get("source_status") or statuses)
            refresh_attempt = {
                "verified": False,
                "status": "failed",
                "trading_date": requested_date,
                "slot": requested_slot,
                "attempted_at": now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                "error": error_text,
            }
            mis_rows = []
        else:
            items = [item for rows in items_by_market.values() for item in rows]

    write_market_cache(items, statuses, now, existing_quotes, radar_refresh, refresh_attempt)

    try:
        if not mis_rows:
            raise ValueError("spot snapshot unavailable")
        overview = build_overview(mis_rows, now)
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

    try:
        taifex_payload = fetch_json(TAIFEX_DAILY_URL, timeout=30)
        if not isinstance(taifex_payload, list):
            raise ValueError("TAIFEX daily source is not an array")
        write_atomic(FUTURES_OUTPUT, build_tx_fallback(taifex_payload, now))
    except Exception as exc:  # noqa: BLE001
        if existing_futures:
            print(f"TX official close fallback kept after source failure: {exc}")
        else:
            raise
    print(f"Updated quote cache with {len(items)} symbols and validated market overview.")


if __name__ == "__main__":
    main()
