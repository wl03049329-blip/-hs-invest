#!/usr/bin/env python3
"""Build same-origin delayed and closing quote caches from structured Taiwan sources.

TAIFEX DailyMarketReportFut is intentionally treated as official daily history only.
It must never be labelled as a current day-session or night-session quote.
"""

from __future__ import annotations

import json
import math
import os
import random
import re
import tempfile
import time as time_module
import urllib.parse
import urllib.request
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
OUTPUT_ROOT = Path(os.environ.get("HS_MARKET_OUTPUT_DIR", ROOT)).resolve()
OUTPUT = OUTPUT_ROOT / "market-quotes.json"
META_OUTPUT = OUTPUT_ROOT / "market-quotes-meta.json"
OVERVIEW_OUTPUT = OUTPUT_ROOT / "market-overview.json"
FUTURES_OUTPUT = OUTPUT_ROOT / "tx-futures-quote.json"

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
    "tse_00757.tw",
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
# The UI can keep WAIT_NATIVE instruments visible, but a symbol which is not
# eligible for a formal Core Score must never block the verified live batch.
RADAR_REQUIRED_LIVE_SYMBOLS = ("0050", "00662", "00757", "00830", "00935")
RADAR_NON_BLOCKING_SYMBOLS = ("009815",)
RADAR_CODES = RADAR_REQUIRED_LIVE_SYMBOLS + RADAR_NON_BLOCKING_SYMBOLS
RADAR_SLOTS = ("09:30", "10:30", "11:30", "12:30", "13:30")
SLOT_CONTRACT = "HS_LIVE_INTRADAY_SLOT_V4"
RADAR_FINAL_SLOT_CLOSE = time(14, 20)
MIS_BATCH_SIZE = 60
# TWSE MIS may legitimately return ``z: "-"`` between transactions.  Retry
# required radar symbols independently and accumulate only real, parsed quotes
# inside the currently open V4 slot.  The bounded budget stays well below one
# slot and never permits stale or synthetic price fallback.
MIS_REQUIRED_RETRY_DELAYS = (0.35, 0.9, 1.5, 2.5, 4.0, 6.0, 9.0, 13.0, 18.0)


class MisSnapshotRows(list[dict[str, Any]]):
    """Parsed MIS rows with compact required-symbol fetch diagnostics."""

    def __init__(self, rows: list[dict[str, Any]], diagnostics: dict[str, Any]) -> None:
        super().__init__(rows)
        self.diagnostics = diagnostics


def fetch_json(url: str, *, timeout: int = 25, headers: dict[str, str] | None = None) -> Any:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", **(headers or {})},
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
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(prefix=f"{path.stem}-", suffix=".json", dir=path.parent)
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


def mis_channel_code(channel: str) -> str:
    match = re.fullmatch(r"(?:tse|otc)_([0-9A-Z]{4,10})\.tw", str(channel or ""), re.IGNORECASE)
    return match.group(1).upper() if match else ""


def fetch_mis_batch(channels: list[str]) -> list[dict[str, Any]]:
    query = urllib.parse.urlencode({
        "ex_ch": "|".join(channels),
        "json": "1",
        "delay": "0",
        "_": str(int(time_module.time() * 1000)),
    })
    payload = fetch_json(
        f"{TWSE_MIS_URL}?{query}",
        timeout=20,
        headers={
            "Referer": "https://mis.twse.com.tw/stock/index.jsp",
            "User-Agent": "Mozilla/5.0 (compatible; HS-ETF-Radar/2.0)",
        },
    )
    batch = payload.get("msgArray") if isinstance(payload, dict) else None
    if not isinstance(batch, list):
        raise ValueError("TWSE MIS response has no msgArray")
    return [row for row in batch if isinstance(row, dict)]


def required_raw_fields(row: dict[str, Any] | None) -> dict[str, Any]:
    row = row if isinstance(row, dict) else {}
    return {
        key: row.get(key)
        for key in ("c", "ex", "d", "^", "t", "%", "tlong", "z", "pz", "y", "o", "h", "l", "v", "tv", "a", "b")
    }


def missing_or_invalid_reason(value: Any, *, missing: str, invalid: str, positive: bool = False) -> str | None:
    if value is None or not str(value).strip() or str(value).strip() in {"-", "--"}:
        return missing
    return invalid if finite_number(value, positive=positive) is None else None


def parse_mis_row(row: dict[str, Any], *, required: bool = False) -> tuple[dict[str, Any] | None, str | None]:
    if not isinstance(row, dict):
        return None, "malformed_row"
    code = str(row.get("c", "")).strip().upper()
    if not code or not CODE_RE.fullmatch(code):
        return None, "malformed_row"
    price_reason = missing_or_invalid_reason(row.get("z"), missing="missing_price", invalid="invalid_price", positive=True)
    if price_reason:
        return None, price_reason
    reference_reason = missing_or_invalid_reason(
        row.get("y"), missing="missing_reference_price", invalid="invalid_reference_price", positive=True
    )
    if reference_reason:
        return None, reference_reason
    date_value = row.get("d") or row.get("^")
    if date_value is None or not str(date_value).strip():
        return None, "missing_date"
    data_date = iso_date(date_value)
    if data_date is None:
        return None, "invalid_date"
    quote_time = str(row.get("t") or row.get("%") or "").strip()
    if required and not quote_time:
        return None, "missing_time"
    if quote_time and not re.fullmatch(r"\d{2}:\d{2}:\d{2}", quote_time):
        return None, "invalid_time"
    price = finite_number(row.get("z"), positive=True)
    previous_close = finite_number(row.get("y"), positive=True)
    high = finite_number(row.get("h"), positive=True)
    low = finite_number(row.get("l"), positive=True)
    open_price = finite_number(row.get("o"), positive=True)
    volume_lots = finite_number(row.get("v"))
    volume = volume_lots * 1000 if volume_lots is not None and volume_lots >= 0 else None
    return {
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
    }, None


def inspect_mis_batch(
    rows: list[dict[str, Any]], required_codes: set[str]
) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    parsed: dict[str, dict[str, Any]] = {}
    raw_required: dict[str, dict[str, Any]] = {}
    rejected: dict[str, dict[str, Any]] = {}
    for row in rows:
        code = str(row.get("c", "")).strip().upper() if isinstance(row, dict) else ""
        is_required = code in required_codes
        if is_required:
            raw_required[code] = row
        parsed_row, reason = parse_mis_row(row, required=is_required)
        if parsed_row:
            parsed[parsed_row["code"]] = parsed_row
            if code in required_codes:
                rejected.pop(code, None)
        elif is_required:
            rejected[code] = {"reason": reason or "malformed_row", "raw_fields": required_raw_fields(row)}
    return parsed, raw_required, rejected


def fetch_mis_snapshot(
    *,
    deadline: datetime | None = None,
    now_fn=lambda: datetime.now(TAIPEI),
    sleep_fn=time_module.sleep,
    jitter_fn=lambda: random.uniform(0.0, 0.15),
    retry_delays: tuple[float, ...] = MIS_REQUIRED_RETRY_DELAYS,
) -> MisSnapshotRows:
    channels = tracked_channels()
    batches = [channels[offset : offset + MIS_BATCH_SIZE] for offset in range(0, len(channels), MIS_BATCH_SIZE)]
    required_codes = set(RADAR_REQUIRED_LIVE_SYMBOLS)
    required_locations: dict[str, dict[str, Any]] = {}
    for batch_index, batch in enumerate(batches, start=1):
        for request_key in batch:
            code = mis_channel_code(request_key)
            if code in required_codes:
                required_locations[code] = {"batch": batch_index, "request_key": request_key}

    parsed_by_code: dict[str, dict[str, Any]] = {}
    raw_required: dict[str, dict[str, Any]] = {}
    rejected_required: dict[str, dict[str, Any]] = {}
    for batch in batches:
        parsed, raw, rejected = inspect_mis_batch(fetch_mis_batch(batch), required_codes)
        parsed_by_code.update(parsed)
        raw_required.update(raw)
        rejected_required.update(rejected)
        for code in raw:
            if code in parsed:
                rejected_required.pop(code, None)

    def status_for(code: str) -> str:
        if code in parsed_by_code:
            return "PRESENT_AND_PARSED"
        return "PARSE_REJECTED" if code in raw_required else "RAW_MISSING"

    initial_missing = [code for code in RADAR_REQUIRED_LIVE_SYMBOLS if status_for(code) == "RAW_MISSING"]
    initial_rejected = {
        code: {**required_locations.get(code, {}), **rejected_required.get(code, {})}
        for code in RADAR_REQUIRED_LIVE_SYMBOLS
        if status_for(code) == "PARSE_REJECTED"
    }
    problem_codes = [code for code in RADAR_REQUIRED_LIVE_SYMBOLS if status_for(code) != "PRESENT_AND_PARSED"]
    retry_batch_indexes = sorted({required_locations[code]["batch"] for code in problem_codes if code in required_locations})
    retry_recovered: list[str] = []
    targeted_retry_attempts: dict[str, int] = {code: 0 for code in problem_codes}
    retry_errors: dict[str, list[str]] = {code: [] for code in problem_codes}
    # A required symbol is retried by its own official MIS request.  This avoids
    # repeatedly refetching unrelated instruments and prevents a single odd
    # batch response from becoming the only legal opportunity for the slot.
    for delay in retry_delays:
        remaining = [code for code in problem_codes if code not in parsed_by_code]
        if not remaining:
            break
        wait_seconds = max(0.0, delay + float(jitter_fn()))
        if deadline is not None and now_fn().astimezone(TAIPEI) + timedelta(seconds=wait_seconds) > deadline:
            break
        if wait_seconds:
            sleep_fn(wait_seconds)
        for code in remaining:
            if deadline is not None and now_fn().astimezone(TAIPEI) > deadline:
                break
            request_key = required_locations.get(code, {}).get("request_key")
            if not request_key:
                continue
            targeted_retry_attempts[code] += 1
            try:
                retry_parsed, retry_raw, retry_rejected = inspect_mis_batch(fetch_mis_batch([request_key]), {code})
            except Exception as exc:  # noqa: BLE001
                retry_errors[code].append(clean_text(exc, 120))
                continue
            if code in retry_raw:
                raw_required[code] = retry_raw[code]
            if code in retry_parsed:
                parsed_by_code[code] = retry_parsed[code]
                rejected_required.pop(code, None)
                retry_recovered.append(code)
            elif code in retry_rejected:
                rejected_required[code] = retry_rejected[code]

    final_missing = [code for code in RADAR_REQUIRED_LIVE_SYMBOLS if code not in raw_required]
    final_rejected = {
        code: {**required_locations.get(code, {}), **rejected_required.get(code, {})}
        for code in RADAR_REQUIRED_LIVE_SYMBOLS
        if code in raw_required and code not in parsed_by_code
    }
    symbol_diagnostics = {
        code: {
            **required_locations.get(code, {}),
            "raw_present": code in raw_required,
            "parsed": code in parsed_by_code,
            "rejection_reason": final_rejected.get(code, {}).get("reason"),
            "raw_fields": final_rejected.get(code, {}).get("raw_fields"),
        }
        for code in RADAR_REQUIRED_LIVE_SYMBOLS
    }
    diagnostics = {
        "required_symbols": list(RADAR_REQUIRED_LIVE_SYMBOLS),
        "initial_missing": initial_missing,
        "initial_parse_rejected": initial_rejected,
        "retried_batches": retry_batch_indexes,
        "retry_strategy": "required_symbol_single_request",
        "targeted_retry_attempts": targeted_retry_attempts,
        "retry_errors": {code: errors for code, errors in retry_errors.items() if errors},
        "retry_recovered": sorted(set(retry_recovered)),
        "final_missing": final_missing,
        "final_parse_rejected": final_rejected,
        "symbols": symbol_diagnostics,
    }
    return MisSnapshotRows(list(parsed_by_code.values()), diagnostics)


def build_slot_diagnostic(
    trading_date: str,
    slot: str,
    diagnostics: dict[str, Any] | None,
    *,
    error: str | None = None,
) -> dict[str, Any]:
    diagnostics = diagnostics if isinstance(diagnostics, dict) else {}
    symbols = diagnostics.get("symbols") if isinstance(diagnostics.get("symbols"), dict) else {}
    required: dict[str, str] = {}
    for code in RADAR_REQUIRED_LIVE_SYMBOLS:
        row = symbols.get(code) if isinstance(symbols.get(code), dict) else {}
        reason = clean_text(row.get("rejection_reason"), 40)
        if row.get("parsed") is True:
            required[code] = "PASS"
        elif reason:
            required[code] = f"FAIL_{reason.upper()}"
        elif row.get("raw_present") is False:
            required[code] = "FAIL_RAW_MISSING"
        else:
            required[code] = "NOT_REACHED"
    source_reached = bool(symbols)
    return {
        "schema_version": 3,
        "contract": SLOT_CONTRACT,
        "trading_date": trading_date,
        "classified_slot": slot,
        "actual_run_time": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "market_fetch": "PASS" if source_reached else "FAIL",
        "required_symbols": required,
        "market_as_of": diagnostics.get("candidate_market_as_of") or None,
        "core_input": "PENDING" if not error else "NOT_RUN",
        "score": "NOT_RUN",
        "snapshot_append": "NOT_RUN",
        "existing_slot_success": False,
        "retry_number": None,
        "failure_class": None if not error else "OPERATIONAL_SOURCE",
        "reason": clean_text(error, 120) if error else None,
        "source_attempts": diagnostics.get("targeted_retry_attempts", {}),
    }


def quote_datetime(data_date: str, quote_time: str) -> datetime | None:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(data_date or "")):
        return None
    if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d", str(quote_time or "")):
        return None
    try:
        return datetime.fromisoformat(f"{data_date}T{quote_time}").replace(tzinfo=TAIPEI)
    except ValueError:
        return None


def radar_slot_window(trading_date: str, slot: str) -> tuple[datetime, datetime]:
    if slot not in RADAR_SLOTS:
        raise ValueError(f"unsupported radar slot: {slot}")
    start = datetime.fromisoformat(f"{trading_date}T{slot}:00").replace(tzinfo=TAIPEI)
    index = RADAR_SLOTS.index(slot)
    if index + 1 < len(RADAR_SLOTS):
        end = datetime.fromisoformat(f"{trading_date}T{RADAR_SLOTS[index + 1]}:00").replace(tzinfo=TAIPEI)
    else:
        end = datetime.combine(datetime.fromisoformat(trading_date).date(), RADAR_FINAL_SLOT_CLOSE, tzinfo=TAIPEI)
    return start, end


def spot_quote_mode(now: datetime, data_date: str, quote_time: str = "") -> str:
    """Classify by the source quote timestamp, never by job completion time."""
    quote_at = quote_datetime(data_date, quote_time)
    if quote_at is None or quote_at.weekday() >= 5:
        return "close"
    in_session = time(9, 0) <= quote_at.time() <= time(13, 30, 59)
    return "delayed" if in_session else "close"


def validate_radar_refresh(
    rows: list[dict[str, Any]], trading_date: str, slot: str, verified_at: datetime,
    required_diagnostics: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if slot not in RADAR_SLOTS:
        raise ValueError(f"unsupported radar slot: {slot}")
    if trading_date != verified_at.astimezone(TAIPEI).date().isoformat():
        raise ValueError("radar trading date is not Taipei today")
    minimum, maximum = radar_slot_window(trading_date, slot)
    local_verified = verified_at.astimezone(TAIPEI)
    if not minimum <= local_verified < maximum:
        raise ValueError(f"radar slot window is not open: {slot}")
    by_code = {str(row.get("code", "")): row for row in rows}
    diagnostics = required_diagnostics or getattr(rows, "diagnostics", {})
    final_missing = set(diagnostics.get("final_missing") or []) if isinstance(diagnostics, dict) else set()
    final_rejected = diagnostics.get("final_parse_rejected") if isinstance(diagnostics, dict) else {}
    final_rejected = final_rejected if isinstance(final_rejected, dict) else {}
    quote_times: dict[str, str] = {}
    market_as_of: dict[str, str] = {}
    for code in RADAR_REQUIRED_LIVE_SYMBOLS:
        if code in final_missing:
            raise ValueError(f"radar required quote raw missing: {code}")
        if code in final_rejected:
            reason = clean_text(final_rejected[code].get("reason"), 40)
            raise ValueError(f"radar required quote parse rejected: {code} reason={reason or 'malformed_row'}")
        row = by_code.get(code)
        if not row:
            raise ValueError(f"radar required quote lookup missing: {code}")
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
        if quote_at is None or quote_at < minimum or quote_at >= maximum:
            raise ValueError(f"radar quote time outside {slot} window: {code}")
        if quote_at > local_verified:
            raise ValueError(f"radar future quote rejected: {code}")
        quote_times[code] = quote_at.strftime("%H:%M:%S")
        market_as_of[code] = quote_at.isoformat()
    return {
        "verified": True,
        "trading_date": trading_date,
        "slot": slot,
        "verified_at": verified_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "captured_at": verified_at.astimezone(TAIPEI).isoformat(),
        "codes": list(RADAR_REQUIRED_LIVE_SYMBOLS),
        "non_blocking_codes": list(RADAR_NON_BLOCKING_SYMBOLS),
        "non_blocking_status": {code: "WAIT_NATIVE" for code in RADAR_NON_BLOCKING_SYMBOLS},
        "quote_times": quote_times,
        "market_as_of": market_as_of,
        "source": "TWSE_MIS",
        "source_url": TWSE_MIS_URL,
        "required_symbol_diagnostics": diagnostics,
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


def merge_official_close_with_lkg(
    items_by_market: dict[str, list[dict[str, Any]]],
    existing_items: list[dict[str, Any]],
    *,
    preserve_intraday_date: str | None = None,
) -> list[dict[str, Any]]:
    """Keep a symbol's last known close only when its current official row is absent.

    A missing individual row must not discard the other market's newly published
    official close data.  Intraday MIS validation is deliberately not involved
    in this merge: it has a separate snapshot-completeness responsibility.
    """
    current = {
        item["code"]: item
        for rows in items_by_market.values()
        for item in rows
    }
    available_markets = set(items_by_market)
    for item in existing_items:
        code = item.get("code")
        market = item.get("market")
        current_item = current.get(code) if isinstance(code, str) else None
        if (
            isinstance(code, str)
            and market in available_markets
        ):
            # A real MIS transaction from today remains a valid candidate for
            # its V4 slot even when a later poll temporarily reports ``z: -``.
            # Preserve only a newer delayed observation; the slot validator
            # below still rejects prior-slot, prior-day and future timestamps.
            if (
                isinstance(current_item, dict)
                and item.get("quote_mode") == "delayed"
                and str(item.get("date", "")) >= str(current_item.get("date", ""))
                and str(item.get("date", "")) == str(preserve_intraday_date or "")
            ):
                current[code] = item
            elif code not in current:
                current[code] = item
    return list(current.values())


def merge_mis_items(
    items: list[dict[str, Any]], mis_rows: list[dict[str, Any]], now: datetime
) -> list[dict[str, Any]]:
    """Overlay only real parsed MIS observations onto the market cache."""
    item_map = {item["code"]: item for item in items}
    for row in mis_rows:
        if not CODE_RE.fullmatch(row["code"]):
            continue
        old = item_map.get(row["code"], {})
        item_map[row["code"]] = {
            "code": row["code"],
            "name": row["name"] or old.get("name", row["code"]),
            "price": row["price"],
            "previous_close": row["previous_close"],
            "date": row["date"],
            "market": row["market"],
            "quote_mode": spot_quote_mode(now, row["date"], row["quote_time"]),
            "quote_time": row["quote_time"],
            "open": row.get("open"),
            "high": row.get("high"),
            "low": row.get("low"),
            "volume": row.get("volume"),
            "source": row.get("source"),
        }
    return list(item_map.values())


def candidate_diagnostics(
    diagnostics: dict[str, Any], candidate_rows: list[dict[str, Any]]
) -> dict[str, Any]:
    """Mark same-slot persisted observations without hiding current failures."""
    result = dict(diagnostics) if isinstance(diagnostics, dict) else {}
    candidate_codes = {str(row.get("code", "")) for row in candidate_rows}
    source_symbols = result.get("symbols") if isinstance(result.get("symbols"), dict) else {}
    result["current_attempt_symbols"] = source_symbols
    result["candidate_cache_recovered"] = sorted(
        code for code in candidate_codes
        if not isinstance(source_symbols.get(code), dict) or source_symbols[code].get("parsed") is not True
    )
    reconciled_symbols = {
        code: dict(value) if isinstance(value, dict) else {}
        for code, value in source_symbols.items()
    }
    candidate_market_as_of: dict[str, str] = {}
    for row in candidate_rows:
        code = str(row.get("code", ""))
        observed_at = quote_datetime(str(row.get("date", "")), str(row.get("quote_time", "")))
        if observed_at is None:
            continue
        candidate_market_as_of[code] = observed_at.isoformat()
        reconciled_symbols[code] = {
            **reconciled_symbols.get(code, {}),
            "parsed": True,
            "candidate_cache": code in result["candidate_cache_recovered"],
            "candidate_market_as_of": observed_at.isoformat(),
        }
    result["symbols"] = reconciled_symbols
    result["candidate_market_as_of"] = candidate_market_as_of
    result["final_missing"] = [code for code in result.get("final_missing", []) if code not in candidate_codes]
    result["final_parse_rejected"] = {
        code: value
        for code, value in (result.get("final_parse_rejected") or {}).items()
        if code not in candidate_codes
    }
    return result


def write_market_cache(
    items: list[dict[str, Any]],
    statuses: dict[str, str],
    now: datetime,
    existing: dict[str, Any],
    radar_refresh: dict[str, Any] | None = None,
    refresh_attempt: dict[str, Any] | None = None,
    official_eod_snapshot: dict[str, Any] | None = None,
) -> None:
    items = sorted({item["code"]: item for item in items}.values(), key=lambda item: item["code"])
    validate_quote_items(items)
    if existing.get("items") == items and not radar_refresh:
        payload = dict(existing)
        # Freshness metadata may change even when every official quote remains
        # identical.  Do not pretend an old MIS status is still current.
        payload["source_status"] = statuses
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
        if isinstance(existing.get("intraday_completeness"), dict):
            payload["intraday_completeness"] = existing["intraday_completeness"]
        if isinstance(existing.get("intraday_quote_snapshots"), dict):
            payload["intraday_quote_snapshots"] = existing["intraday_quote_snapshots"]
        if official_eod_snapshot:
            payload["official_eod_snapshot"] = official_eod_snapshot
        if radar_refresh:
            payload["radar_refresh"] = radar_refresh
        elif isinstance(existing.get("radar_refresh"), dict):
            payload["radar_refresh"] = existing["radar_refresh"]
    if radar_refresh:
        snapshots = dict(payload.get("intraday_quote_snapshots") or {})
        key = f'{radar_refresh["trading_date"]}_{radar_refresh["slot"].replace(":", "")}'
        by_code = {item["code"]: item for item in payload["items"]}
        snapshot_items = {
            code: {
                field: by_code[code].get(field)
                for field in ("price", "open", "high", "low", "volume", "date", "quote_time")
            }
            for code in RADAR_REQUIRED_LIVE_SYMBOLS
            if code in by_code
        }
        if len(snapshot_items) != len(RADAR_REQUIRED_LIVE_SYMBOLS):
            raise ValueError("validated radar snapshot is missing a required ETF")
        candidate_snapshot = {
            "contract": SLOT_CONTRACT,
            "market_date": radar_refresh["trading_date"],
            "slot": radar_refresh["slot"],
            "status": "SUCCESS",
            "captured_at": radar_refresh.get("captured_at") or radar_refresh["verified_at"],
            "calculated_at": radar_refresh["verified_at"],
            "market_as_of": radar_refresh["market_as_of"],
            "items": snapshot_items,
            "non_blocking_status": radar_refresh.get("non_blocking_status", {}),
        }
        if key in snapshots:
            comparable_fields = ("market_date", "slot", "status", "market_as_of", "items", "non_blocking_status")
            existing_comparable = {field: snapshots[key].get(field) for field in comparable_fields}
            candidate_comparable = {field: candidate_snapshot.get(field) for field in comparable_fields}
            if existing_comparable != candidate_comparable:
                raise ValueError(f"INTEGRITY_FAILURE conflicting immutable raw radar snapshot: {key}")
        else:
            snapshots[key] = candidate_snapshot
        successful = sorted(
            (row for row in snapshots.values() if row.get("status") == "SUCCESS"),
            key=lambda row: (str(row.get("market_date", "")), str(row.get("slot", ""))),
        )
        previous = successful[-2] if len(successful) > 1 else None
        payload["intraday_quote_snapshots"] = snapshots
        payload["intraday_snapshot_meta"] = {
            "current_market_date": radar_refresh["trading_date"],
            "current_slot": radar_refresh["slot"],
            "previous_successful_slot": previous.get("slot") if previous else None,
            "last_successful_snapshot": key,
            "snapshot_calculated_at": radar_refresh["verified_at"],
        }
    elif isinstance(existing.get("intraday_snapshot_meta"), dict):
        payload["intraday_snapshot_meta"] = existing["intraday_snapshot_meta"]
    if official_eod_snapshot:
        payload["official_eod_snapshot"] = official_eod_snapshot
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
        "intraday_completeness": payload.get("intraday_completeness"),
        "intraday_snapshot_meta": payload.get("intraday_snapshot_meta"),
        "intraday_quote_snapshots": payload.get("intraday_quote_snapshots"),
        "official_eod_snapshot": payload.get("official_eod_snapshot"),
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

    # Official closing data owns the production quote cache.  Preserve a
    # per-symbol last known close only for a source row that is individually
    # absent; never let an intraday Radar validation failure roll back this set.
    items = merge_official_close_with_lkg(
        items_by_market,
        existing_quotes.get("items", []),
        preserve_intraday_date=requested_date if requested_slot else None,
    )
    # Preserve the verified close set before MIS can replace display quotes with
    # intraday values.  It is consumed only by the separate EOD history finalizer.
    required_core = ("0050", "00662", "00757", "00830", "00935")
    official_by_code = {str(item.get("code", "")): item for item in items}
    official_dates = {str(official_by_code.get(code, {}).get("date", "")) for code in required_core}
    official_eod_snapshot: dict[str, Any] | None = None
    if (
        statuses.get("TWSE") == "official_closing_data"
        and statuses.get("TPEx") == "official_closing_data"
        and len(official_dates) == 1
        and next(iter(official_dates), "")
    ):
        official_date = next(iter(official_dates))
        official_eod_snapshot = {
            "snapshot_type": "OFFICIAL_CLOSE_INPUT",
            "date": official_date,
            "observed_at": now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
            "source_status": "official_closing_data",
            "items": {code: official_by_code[code] for code in required_core},
        }

    mis_rows: list[dict[str, Any]] = []
    mis_diagnostics: dict[str, Any] = {}
    radar_refresh: dict[str, Any] | None = None
    refresh_attempt: dict[str, Any] | None = None
    try:
        retry_deadline = None
        if requested_slot and requested_slot in RADAR_SLOTS:
            _, retry_deadline = radar_slot_window(requested_date, requested_slot)
        mis_rows = fetch_mis_snapshot(deadline=retry_deadline)
        mis_diagnostics = getattr(mis_rows, "diagnostics", {})
        # Persist every genuine source observation even when the atomic radar
        # set is not complete yet.  Later scheduled attempts may combine only
        # observations that the V4 validator proves belong to the same slot.
        items = merge_mis_items(items, mis_rows, now)
        if requested_slot:
            verified_at = datetime.now(TAIPEI)
            item_map = {item["code"]: item for item in items}
            slot_start, slot_end = radar_slot_window(requested_date, requested_slot)
            candidate_rows = [
                item_map[code]
                for code in RADAR_REQUIRED_LIVE_SYMBOLS
                if code in item_map
                and (candidate_at := quote_datetime(
                    str(item_map[code].get("date", "")),
                    str(item_map[code].get("quote_time", "")),
                )) is not None
                and slot_start <= candidate_at < slot_end
                and candidate_at <= verified_at
            ]
            mis_diagnostics = candidate_diagnostics(mis_diagnostics, candidate_rows)
            radar_refresh = {
                **validate_radar_refresh(candidate_rows, requested_date, requested_slot, verified_at, mis_diagnostics),
                "status": "success",
            }
            refresh_attempt = {
                **radar_refresh,
                "slot_diagnostic": {
                    **build_slot_diagnostic(requested_date, requested_slot, mis_diagnostics),
                    "actual_run_time": radar_refresh["verified_at"],
                    "market_as_of": radar_refresh["market_as_of"],
                },
            }
        statuses["TWSE_MIS"] = "ok"
    except Exception as exc:  # noqa: BLE001
        attempted_at = datetime.now(TAIPEI)
        error_text = clean_text(exc, 100)
        statuses["TWSE_MIS"] = f"cached_after_error: {error_text}"
        if requested_slot:
            slot_diagnostic = build_slot_diagnostic(
                requested_date,
                requested_slot,
                mis_diagnostics,
                error=error_text,
            )
            refresh_attempt = {
                "verified": False,
                "status": "failed",
                "trading_date": requested_date,
                "slot": requested_slot,
                "attempted_at": attempted_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                "error": error_text,
                "failure_class": "OPERATIONAL_SOURCE",
                "required_symbol_diagnostics": mis_diagnostics,
                "slot_diagnostic": slot_diagnostic,
            }
        else:
            items = [item for rows in items_by_market.values() for item in rows]

    write_market_cache(items, statuses, now, existing_quotes, radar_refresh, refresh_attempt, official_eod_snapshot)

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
            print(f"OPTIONAL_ENRICHMENT_UNAVAILABLE market_overview: {exc}")

    try:
        taifex_payload = fetch_json(TAIFEX_DAILY_URL, timeout=30)
        if not isinstance(taifex_payload, list):
            raise ValueError("TAIFEX daily source is not an array")
        write_atomic(FUTURES_OUTPUT, build_tx_fallback(taifex_payload, now))
    except Exception as exc:  # noqa: BLE001
        if existing_futures:
            print(f"TX official close fallback kept after source failure: {exc}")
        else:
            print(f"OPTIONAL_ENRICHMENT_UNAVAILABLE tx_futures: {exc}")
    print(f"Updated quote cache with {len(items)} symbols and validated market overview.")


if __name__ == "__main__":
    main()
