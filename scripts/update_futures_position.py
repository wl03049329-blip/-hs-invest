#!/usr/bin/env python3
"""Update validated Taiwan futures positioning from TAIFEX official OpenAPI."""

from __future__ import annotations

import json
import math
import os
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "futures-position.json"
INSTITUTION_URL = (
    "https://openapi.taifex.com.tw/v1/"
    "MarketDataOfMajorInstitutionalTradersDetailsOfFuturesContractsBytheDate"
)
DAILY_URL = "https://openapi.taifex.com.tw/v1/DailyMarketReportFut"
PRODUCTS = {
    "TX": "臺股期貨",
    "MTX": "小型臺指期貨",
    "TMF": "微型臺指期貨",
}
INSTITUTION_TYPES = ("自營商", "投信", "外資及陸資")


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
    try:
        institutional = fetch_json(INSTITUTION_URL)
        daily = fetch_json(DAILY_URL)
        institutional_dates = rows_by_date(institutional)
        daily_dates = rows_by_date(daily)
        common_dates = sorted(set(institutional_dates) & set(daily_dates), reverse=True)
        if not common_dates:
            raise ValueError("official sources do not contain an aligned trading date")
        current_date = common_dates[0]
        current_inst = institutional_dates[current_date]
        current_daily = daily_dates[current_date]

        current_tx = foreign_tx(current_inst)
        current_mtx, mtx_scope = estimate_non_institutional(current_daily, current_inst, "MTX")
        current_tmf, tmf_scope = estimate_non_institutional(current_daily, current_inst, "TMF")
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
            "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
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
                "net_change_available": has_previous,
                "net_change_baseline_date": existing.get("data_date", "") if has_previous else "",
                "session_scope": "一般交易時段未平倉量",
                "mtx_contract_scope": mtx_scope,
                "tmf_contract_scope": tmf_scope,
                "institutional_source": INSTITUTION_URL,
                "market_source": DAILY_URL,
            },
        }
        validate_output(payload)
        if existing and comparable(existing) == comparable(payload):
            payload["updated_at"] = existing["updated_at"]
        write_atomic(payload)
        print(f"Updated futures positions for {current_date}.")
    except Exception as exc:  # noqa: BLE001
        if existing:
            validate_output(existing)
            print(f"Kept previous valid futures-position.json after failure: {exc}")
            return
        raise


if __name__ == "__main__":
    main()
