#!/usr/bin/env python3
"""Update validated Taiwan futures positioning from TAIFEX official OpenAPI."""

from __future__ import annotations

import json
import math
import os
import csv
import io
import tempfile
import urllib.request
from datetime import datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "futures-position.json"
INSTITUTION_URL = (
    "https://openapi.taifex.com.tw/v1/"
    "MarketDataOfMajorInstitutionalTradersDetailsOfFuturesContractsBytheDate"
)
DAILY_URL = "https://openapi.taifex.com.tw/v1/DailyMarketReportFut"
TAIFEX_OPEN_DATA_BASE = "https://www.taifex.com.tw/data_gov/taifex_open_data.asp?data_name="
TAIFEX_CSV_INSTITUTION_URL = TAIFEX_OPEN_DATA_BASE + "MarketDataOfMajorInstitutionalTradersDetailsOfFuturesContractsBytheDate"
TAIFEX_CSV_DAILY_URL = TAIFEX_OPEN_DATA_BASE + "DailyMarketReportFut"
DATA_GOV_INSTITUTION_DATASET = "https://data.gov.tw/api/v2/rest/dataset/11596"
DATA_GOV_DAILY_DATASET = "https://data.gov.tw/api/v2/rest/dataset/11319"
PRODUCTS = {
    "TX": "臺股期貨",
    "MTX": "小型臺指期貨",
    "TMF": "微型臺指期貨",
}
INSTITUTION_TYPES = ("自營商", "投信", "外資及陸資")
TAIPEI = timezone(timedelta(hours=8))
# Official 2026 TAIFEX non-trading dates.  Keep this deliberately small and
# explicit rather than introducing a second calendar system for one updater.
TAIWAN_MARKET_HOLIDAYS = frozenset({
    "2026-01-01", "2026-02-12", "2026-02-13", "2026-02-16", "2026-02-17",
    "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-27", "2026-04-03",
    "2026-04-06", "2026-05-01", "2026-06-19", "2026-09-25", "2026-09-28",
    "2026-10-09", "2026-10-26", "2026-12-25",
})
SOURCE_CURRENT = "CURRENT"
SOURCE_NOT_READY = "SOURCE_NOT_READY"
SOURCE_FALLBACK = "SOURCE_FALLBACK"
SOURCE_CONFLICT = "SOURCE_CONFLICT"
UPDATE_FAILED = "UPDATE_FAILED"


def expected_trading_date(now: datetime, holidays: frozenset[str] = TAIWAN_MARKET_HOLIDAYS) -> str:
    local = now.astimezone(TAIPEI)
    day = local.date()
    if local.time() < time(15, 30):
        day -= timedelta(days=1)
    while day.weekday() >= 5 or day.isoformat() in holidays:
        day -= timedelta(days=1)
    return day.isoformat()


def freshness_status(expected: str, source: str, production: str) -> str:
    if source < production:
        return "STALE_DATA_DETECTED"
    if source < expected:
        return "SOURCE_NOT_READY"
    if source > production:
        return "UPDATED_SUCCESSFULLY"
    return "UP_TO_DATE"


def emit_freshness(status: str, *, expected: str, source: str, production: str) -> None:
    prefix = "::warning::" if status in {
        "SOURCE_NOT_READY",
        "STALE_DATA_DETECTED",
        SOURCE_CONFLICT,
        UPDATE_FAILED,
    } else ""
    print(
        f"{prefix}{status} expected_date={expected} "
        f"source_latest={source} production_date={production}"
    )


def fetch_json(url: str) -> list[dict[str, Any]]:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "HS-ETF-Radar-V6.1/1.0"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status != 200:
            raise RuntimeError(f"HTTP {response.status}: {url}")
        payload = json.load(response)
    if not isinstance(payload, list):
        raise ValueError(f"official source is not an array: {url}")
    return payload


def fetch_object(url: str) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "HS-ETF-Radar-V6.1/1.0"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status != 200:
            raise RuntimeError(f"HTTP {response.status}: {url}")
        payload = json.load(response)
    if not isinstance(payload, dict):
        raise ValueError(f"official source is not an object: {url}")
    return payload


def fetch_csv(url: str) -> list[dict[str, str]]:
    request = urllib.request.Request(
        url,
        headers={"Accept": "text/csv", "User-Agent": "HS-ETF-Radar-V6.1/1.0"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status != 200:
            raise RuntimeError(f"HTTP {response.status}: {url}")
        text = response.read().decode("utf-8-sig")
    rows = list(csv.DictReader(io.StringIO(text)))
    if not rows:
        raise ValueError(f"official CSV is empty: {url}")
    return rows


def csv_institution_rows(rows: list[dict[str, str]]) -> list[dict[str, Any]]:
    return [{
        "Date": row.get("日期", ""), "ContractCode": row.get("商品名稱", ""),
        "Item": row.get("身份別", ""), "OpenInterest(Long)": row.get("多方未平倉口數", ""),
        "OpenInterest(Short)": row.get("空方未平倉口數", ""),
        "OpenInterest(Net)": row.get("多空未平倉口數淨額", ""),
    } for row in rows]


def csv_daily_rows(rows: list[dict[str, str]]) -> list[dict[str, Any]]:
    return [{
        "Date": row.get("日期", ""), "Contract": row.get("契約代號", ""),
        "ContractMonth(Week)": row.get("到期月份(週別)", ""),
        "OpenInterest": row.get("未沖銷契約數", ""),
        "TradingSession": row.get("交易時段", ""),
    } for row in rows]


def primary_sources() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    return fetch_json(INSTITUTION_URL), fetch_json(DAILY_URL)


def taifex_csv_sources() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    return (
        csv_institution_rows(fetch_csv(TAIFEX_CSV_INSTITUTION_URL)),
        csv_daily_rows(fetch_csv(TAIFEX_CSV_DAILY_URL)),
    )


def data_gov_resource(dataset_url: str) -> str:
    payload = fetch_object(dataset_url)
    distributions = payload.get("result", {}).get("distribution", [])
    if not isinstance(distributions, list) or not distributions:
        raise ValueError(f"data.gov dataset has no distribution: {dataset_url}")
    url = distributions[0].get("resourceDownloadUrl")
    if not isinstance(url, str) or not url.startswith("https://www.taifex.com.tw/"):
        raise ValueError(f"data.gov resource provenance is not TAIFEX: {dataset_url}")
    return url


def data_gov_sources() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    return (
        csv_institution_rows(fetch_csv(data_gov_resource(DATA_GOV_INSTITUTION_DATASET))),
        csv_daily_rows(fetch_csv(data_gov_resource(DATA_GOV_DAILY_DATASET))),
    )


def integer(value: Any, *, nonnegative: bool = False) -> int:
    text = str(value).replace(",", "").strip()
    if text in {"", "-", "NULL", "None"}:
        raise ValueError(f"missing integer: {value!r}")
    parsed = float(text)
    if not math.isfinite(parsed) or not parsed.is_integer():
        raise ValueError(f"not an integer: {value!r}")
    result = int(parsed)
    if nonnegative and result < 0:
        raise ValueError(f"negative value: {value!r}")
    return result


def valid_date(value: Any) -> str:
    digits = "".join(char for char in str(value or "") if char.isdigit())
    if len(digits) != 8:
        raise ValueError(f"invalid data date: {value!r}")
    result = f"{digits[:4]}-{digits[4:6]}-{digits[6:8]}"
    datetime.strptime(result, "%Y-%m-%d")
    return result


def read_existing() -> dict[str, Any]:
    try:
        data = json.loads(OUTPUT.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def write_atomic(payload: dict[str, Any]) -> None:
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    handle, temp_name = tempfile.mkstemp(prefix="futures-position-", suffix=".json", dir=ROOT)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
        os.replace(temp_name, OUTPUT)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def rows_by_date(rows: list[dict[str, Any]], date_field: str = "Date") -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        try:
            data_date = valid_date(row.get(date_field))
        except ValueError:
            continue
        result.setdefault(data_date, []).append(row)
    return result


def institutional_positions(
    rows: list[dict[str, Any]], product_name: str
) -> dict[str, dict[str, int]]:
    selected = [row for row in rows if str(row.get("ContractCode", "")).strip() == product_name]
    by_type: dict[str, dict[str, int]] = {}
    for item_type in INSTITUTION_TYPES:
        row = next((row for row in selected if str(row.get("Item", "")).strip() == item_type), None)
        if row is None:
            raise ValueError(f"{product_name} is missing {item_type}")
        long_value = integer(row.get("OpenInterest(Long)"), nonnegative=True)
        short_value = integer(row.get("OpenInterest(Short)"), nonnegative=True)
        net_value = integer(row.get("OpenInterest(Net)"))
        if long_value - short_value != net_value:
            raise ValueError(f"{product_name} {item_type} open-interest net does not reconcile")
        by_type[item_type] = {"long": long_value, "short": short_value, "net": net_value}
    return by_type


def total_open_interest(rows: list[dict[str, Any]], contract: str) -> tuple[int, list[str]]:
    selected = [
        row
        for row in rows
        if str(row.get("Contract", "")).strip() == contract
        and str(row.get("TradingSession", "")).strip() == "一般"
    ]
    totals: list[int] = []
    scopes: list[str] = []
    seen: set[str] = set()
    for row in selected:
        month = str(row.get("ContractMonth(Week)", "")).strip()
        if not month or month in seen:
            continue
        seen.add(month)
        try:
            open_interest = integer(row.get("OpenInterest"), nonnegative=True)
        except ValueError:
            continue
        totals.append(open_interest)
        scopes.append(month)
    if not totals:
        raise ValueError(f"{contract} has no valid regular-session open interest")
    return sum(totals), sorted(scopes)


def estimate_non_institutional(
    daily_rows: list[dict[str, Any]],
    institutional_rows: list[dict[str, Any]],
    contract: str,
) -> tuple[dict[str, int], list[str]]:
    total, scopes = total_open_interest(daily_rows, contract)
    positions = institutional_positions(institutional_rows, PRODUCTS[contract])
    institutional_long = sum(item["long"] for item in positions.values())
    institutional_short = sum(item["short"] for item in positions.values())
    estimated_long = total - institutional_long
    estimated_short = total - institutional_short
    if estimated_long < 0 or estimated_short < 0:
        raise ValueError(
            f"{contract} scope cannot align: total={total}, "
            f"institutional long={institutional_long}, short={institutional_short}"
        )
    return {
        "long": estimated_long,
        "short": estimated_short,
        "net": estimated_long - estimated_short,
    }, scopes


def foreign_tx(institutional_rows: list[dict[str, Any]]) -> dict[str, int]:
    positions = institutional_positions(institutional_rows, PRODUCTS["TX"])
    foreign = positions["外資及陸資"]
    return {"long": foreign["long"], "short": foreign["short"], "net": foreign["net"]}


def with_change(current: dict[str, int], previous: dict[str, int]) -> dict[str, int]:
    result = dict(current)
    result["net_change"] = current["net"] - previous["net"]
    return result


def candidate_from_rows(
    institutional: list[dict[str, Any]], daily: list[dict[str, Any]], provider: str
) -> dict[str, Any]:
    institutional_dates = rows_by_date(institutional)
    daily_dates = rows_by_date(daily)
    common_dates = sorted(set(institutional_dates) & set(daily_dates), reverse=True)
    if not common_dates:
        raise ValueError("official sources do not contain an aligned trading date")
    data_date = common_dates[0]
    current_inst = institutional_dates[data_date]
    current_daily = daily_dates[data_date]
    foreign = foreign_tx(current_inst)
    mtx, mtx_scope = estimate_non_institutional(current_daily, current_inst, "MTX")
    tmf, tmf_scope = estimate_non_institutional(current_daily, current_inst, "TMF")
    return {
        "data_date": data_date,
        "foreign_tx": foreign,
        "estimated_non_institutional_mtx": mtx,
        "estimated_non_institutional_tmf": tmf,
        "mtx_contract_scope": mtx_scope,
        "tmf_contract_scope": tmf_scope,
        "provider": provider,
    }


def candidate_signature(candidate: dict[str, Any]) -> tuple[Any, ...]:
    return (
        candidate["foreign_tx"]["long"], candidate["foreign_tx"]["short"],
        candidate["estimated_non_institutional_mtx"]["long"], candidate["estimated_non_institutional_mtx"]["short"],
        candidate["estimated_non_institutional_tmf"]["long"], candidate["estimated_non_institutional_tmf"]["short"],
    )


def resolve_official_candidate(
    expected: str,
    fetchers: list[tuple[str, Any]],
) -> tuple[dict[str, Any] | None, str, list[str]]:
    """Return only a complete same-date official observation.

    A fallback is attempted only after an unavailable, malformed, or
    not-current earlier source.  Any same-date disagreement is fail-closed.
    """
    primary_candidate: dict[str, Any] | None = None
    diagnostics: list[str] = []
    best_old: dict[str, Any] | None = None
    for index, (provider, fetcher) in enumerate(fetchers):
        try:
            institutional, daily = fetcher()
            candidate = candidate_from_rows(institutional, daily, provider)
        except Exception as exc:  # noqa: BLE001
            diagnostics.append(f"{provider}:{type(exc).__name__}")
            continue
        if best_old is None or candidate["data_date"] > best_old["data_date"]:
            best_old = candidate
        if index == 0:
            primary_candidate = candidate
            if candidate["data_date"] >= expected:
                return candidate, SOURCE_CURRENT, diagnostics
            diagnostics.append(f"{provider}:{SOURCE_NOT_READY}:{candidate['data_date']}")
            continue
        if primary_candidate and candidate["data_date"] == primary_candidate["data_date"]:
            if candidate_signature(candidate) != candidate_signature(primary_candidate):
                diagnostics.append(f"{provider}:{SOURCE_CONFLICT}:{candidate['data_date']}")
                return None, SOURCE_CONFLICT, diagnostics
        if candidate["data_date"] >= expected:
            return candidate, SOURCE_FALLBACK, diagnostics
        diagnostics.append(f"{provider}:{SOURCE_NOT_READY}:{candidate['data_date']}")
    if best_old is not None:
        return best_old, SOURCE_NOT_READY, diagnostics
    return None, UPDATE_FAILED, diagnostics


def lag_trading_days(expected: str, data_date: str) -> int:
    return max(0, (datetime.strptime(expected, "%Y-%m-%d").date() - datetime.strptime(data_date, "%Y-%m-%d").date()).days)


def validate_output(payload: dict[str, Any]) -> None:
    data_date = datetime.strptime(str(payload.get("data_date", "")), "%Y-%m-%d")
    if (datetime.now(timezone.utc).date() - data_date.date()).days > 14:
        raise ValueError("futures positioning data is more than 14 days old")
    for key in (
        "foreign_tx",
        "estimated_non_institutional_mtx",
        "estimated_non_institutional_tmf",
    ):
        item = payload.get(key)
        if not isinstance(item, dict):
            raise ValueError(f"{key} is missing")
        for field in ("long", "short", "net", "net_change"):
            if not isinstance(item.get(field), int):
                raise ValueError(f"{key}.{field} must be an integer")
        if item["long"] < 0 or item["short"] < 0 or item["long"] - item["short"] != item["net"]:
            raise ValueError(f"{key} has unreasonable long/short values")


def comparable(payload: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in payload.items() if key != "updated_at"}


def main() -> None:
    existing = read_existing()
    now = datetime.now(timezone.utc)
    expected = expected_trading_date(now)
    production_before = str(existing.get("data_date", ""))
    try:
        candidate, source_state, diagnostics = resolve_official_candidate(expected, [
            ("TAIFEX_PRIMARY", primary_sources),
            ("TAIFEX_OFFICIAL_CSV", taifex_csv_sources),
            ("DATA_GOV_OFFICIAL", data_gov_sources),
        ])
        if source_state == SOURCE_CONFLICT:
            emit_freshness(SOURCE_CONFLICT, expected=expected, source="CONFLICT", production=production_before)
            print(f"kept_previous_valid_futures_cache=true reason={';'.join(diagnostics)}")
            return
        if candidate is None:
            raise RuntimeError(f"all official sources failed: {';'.join(diagnostics)}")
        current_date = candidate["data_date"]
        if source_state == SOURCE_NOT_READY:
            emit_freshness(SOURCE_NOT_READY, expected=expected, source=current_date, production=production_before)
            print(f"kept_previous_valid_futures_cache=true reason={';'.join(diagnostics)}")
            return
        if production_before and current_date < production_before:
            emit_freshness(
                "STALE_DATA_DETECTED",
                expected=expected,
                source=current_date,
                production=production_before,
            )
            return
        if production_before and current_date == production_before:
            existing_status = existing.get("source_status", {})
            if not isinstance(existing_status, dict) or not existing_status.get("freshness"):
                upgraded = dict(existing)
                upgraded["source_status"] = {
                    **(existing_status if isinstance(existing_status, dict) else {}),
                    "aligned": True,
                    "freshness": source_state,
                    "source_provider": candidate["provider"],
                    "source_checked_at": now.isoformat().replace("+00:00", "Z"),
                    "latest_expected_trading_date": expected,
                    "lag_trading_days": lag_trading_days(expected, current_date),
                    "diagnostics": diagnostics,
                }
                write_atomic(upgraded)
            emit_freshness(SOURCE_CURRENT, expected=expected, source=current_date, production=production_before)
            return
        current_tx = candidate["foreign_tx"]
        current_mtx = candidate["estimated_non_institutional_mtx"]
        current_tmf = candidate["estimated_non_institutional_tmf"]
        has_previous = bool(existing and str(existing.get("data_date", "")) < current_date)
        previous_tx = existing.get("foreign_tx", current_tx) if has_previous else current_tx
        previous_mtx = (
            existing.get("estimated_non_institutional_mtx", current_mtx)
            if has_previous
            else current_mtx
        )
        previous_tmf = (
            existing.get("estimated_non_institutional_tmf", current_tmf)
            if has_previous
            else current_tmf
        )

        payload = {
            "version": 1,
            "updated_at": now.isoformat().replace("+00:00", "Z"),
            "data_date": current_date,
            "foreign_tx": with_change(current_tx, previous_tx),
            "estimated_non_institutional_mtx": with_change(current_mtx, previous_mtx),
            "estimated_non_institutional_tmf": with_change(current_tmf, previous_tmf),
            "methodology": (
                "外資臺股期貨採期交所三大法人未平倉資料。MTX/TMF 非三大法人部位推估＝"
                "一般交易時段、相同交易日、同商品所有有效月份（含 MTX 週契約）全市場未平倉量，"
                "分別扣除自營商、投信、外資及陸資的多方／空方未平倉口數。"
            ),
            "source_status": {
                "aligned": True,
                "freshness": source_state,
                "source_provider": candidate["provider"],
                "source_checked_at": now.isoformat().replace("+00:00", "Z"),
                "latest_expected_trading_date": expected,
                "lag_trading_days": lag_trading_days(expected, current_date),
                "net_change_available": has_previous,
                "net_change_baseline_date": existing.get("data_date", "") if has_previous else "",
                "session_scope": "一般交易時段未平倉量",
                "mtx_contract_scope": candidate["mtx_contract_scope"],
                "tmf_contract_scope": candidate["tmf_contract_scope"],
                "institutional_source": INSTITUTION_URL,
                "market_source": DAILY_URL,
                "diagnostics": diagnostics,
            },
        }
        validate_output(payload)
        if existing and comparable(existing) == comparable(payload):
            payload["updated_at"] = existing["updated_at"]
        write_atomic(payload)
        status = source_state if source_state == SOURCE_FALLBACK else freshness_status(expected, current_date, production_before or current_date)
        emit_freshness(status, expected=expected, source=current_date, production=current_date)
    except Exception as exc:  # noqa: BLE001
        if existing:
            validate_output(existing)
            emit_freshness(
                UPDATE_FAILED,
                expected=expected,
                source="UNKNOWN",
                production=production_before,
            )
            print(f"kept_previous_valid_futures_cache=true reason={type(exc).__name__}: {exc}")
            raise
        raise


if __name__ == "__main__":
    main()
