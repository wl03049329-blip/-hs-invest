#!/usr/bin/env python3
"""Build the after-hours TWSE + TPEx rolling margin-cost estimate.

The exchanges do not publish a market-wide maintenance ratio.  This script
therefore estimates the remaining financed cost security by security and uses
the *same matched security scope* for collateral and principal:

    sum(margin balance shares x close)
    ---------------------------------- x 100
    sum(rolling remaining cost x 0.60)

No external aggregate financing field is used as the denominator.
"""
from __future__ import annotations

import argparse
import datetime as dt
import http.client
import json
import math
import os
import socket
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "margin-data.json"
STATE = ROOT / "margin-cost-state.json"
RECONCILIATION = ROOT / "reconciliation-report.json"
FINANCING_RATIO = 0.60
INITIAL_RATIO = 100 / FINANCING_RATIO
MIN_WARMUP_DAYS = 120
TARGET_WARMUP_DAYS = 125
MAX_STALE_DAYS = 10
TAIPEI = dt.timezone(dt.timedelta(hours=8))
HEADERS = {"User-Agent": "HS-ETF-Stock-Radar/6.2 (+GitHub Actions)", "Accept": "application/json"}
TWSE_MARGIN = "https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date={date}&selectType=ALL&response=json"
TWSE_PRICE = "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date={date}&type=ALLBUT0999&response=json"
TPEX_MARGIN = "https://www.tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php?l=zh-tw&o=json&d={roc}"
TPEX_PRICE = "https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date={slash}&id=&response=json"
TWSE_SOURCE = "https://www.twse.com.tw/zh/trading/margin/mi-margn.html"
TPEX_SOURCE = "https://www.tpex.org.tw/zh-tw/mainboard/trading/margin-trading/transactions.html"
RULE_SOURCE = "https://twse-regulation.twse.com.tw/TW/law/DOC01.aspx?FLCODE=FL007121&FLNO=53"
RETRYABLE_NETWORK_ERRORS = (
    OSError,
    TimeoutError,
    socket.timeout,
    urllib.error.URLError,
    http.client.HTTPException,
    http.client.IncompleteRead,
)


class NetworkFetchError(RuntimeError):
    """A structured source remained unavailable after finite retries."""


def number(value: object, *, positive: bool = False) -> float:
    if isinstance(value, bool):
        raise ValueError("boolean is not numeric")
    text = str(value).replace(",", "").replace("+", "").strip()
    result = float(text)
    if not math.isfinite(result) or (positive and result <= 0):
        raise ValueError("invalid number")
    return result


def maybe(value: object, *, positive: bool = False) -> float | None:
    try:
        return number(value, positive=positive)
    except (TypeError, ValueError):
        return None


def get_json(url: str, timeout: int = 35, attempts: int = 4) -> dict:
    last: Exception | None = None
    host = urllib.parse.urlparse(url).netloc or "unknown-host"
    for attempt in range(1, attempts + 1):
        try:
            request = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(request, timeout=timeout) as response:
                if response.status != 200:
                    raise ValueError(f"HTTP {response.status}")
                raw = response.read()
                payload = json.loads(raw.decode("utf-8-sig"))
            if not isinstance(payload, dict):
                raise ValueError("JSON root is not an object")
            return payload
        except (*RETRYABLE_NETWORK_ERRORS, ValueError) as exc:
            last = exc
            print(
                f"source={host} attempt {attempt}/{attempts} failed: "
                f"{type(exc).__name__}: {exc}",
                flush=True,
            )
            if attempt < attempts:
                delay = 2 ** (attempt - 1)
                print(f"source={host} retrying in {delay}s", flush=True)
                time.sleep(delay)
    raise NetworkFetchError(f"structured source failed after {attempts} attempts ({host}): {last}") from last


def table(payload: dict, index: int) -> list[list[Any]]:
    tables = payload.get("tables")
    if not isinstance(tables, list) or index >= len(tables):
        raise ValueError("expected data table is absent")
    rows = tables[index].get("data")
    if not isinstance(rows, list):
        raise ValueError("table rows are absent")
    return rows


def formats(day: dt.date) -> dict[str, str]:
    return {
        "date": day.strftime("%Y%m%d"),
        "roc": f"{day.year - 1911:03d}/{day:%m/%d}",
        "slash": day.strftime("%Y/%m/%d"),
    }


def parse_twse(day: dt.date, margin: dict, prices: dict) -> tuple[list[dict], dict]:
    if margin.get("stat") != "OK" or prices.get("stat") != "OK":
        raise ValueError("TWSE has no data for date")
    price_rows = table(prices, 8)
    price_map: dict[str, dict] = {}
    for row in price_rows:
        if not isinstance(row, list) or len(row) < 10:
            continue
        code, close = str(row[0]).strip(), maybe(row[8], positive=True)
        shares, amount = maybe(row[2], positive=True), maybe(row[4], positive=True)
        if code and close:
            price_map[code] = {"close": close, "average": amount / shares if shares and amount else None}
    records = []
    short_balance = short_previous = 0.0
    for row in table(margin, 1):
        if not isinstance(row, list) or len(row) < 16:
            continue
        values = [maybe(row[i]) for i in (2, 3, 4, 5, 6, 11, 12)]
        if any(value is None for value in values):
            continue
        code = str(row[0]).strip()
        quote = price_map.get(code, {})
        rec = {
            "market": "twse", "code": code, "name": str(row[1]).strip(),
            "buy": values[0] * 1000, "sell": values[1] * 1000, "cash": values[2] * 1000,
            "previous": values[3] * 1000, "balance": values[4] * 1000,
            "short_previous": values[5] * 1000, "short_balance": values[6] * 1000,
            "close": quote.get("close"), "average": quote.get("average"),
        }
        records.append(rec)
        short_previous += rec["short_previous"]
        short_balance += rec["short_balance"]
    return records, {"short_balance": short_balance, "short_previous": short_previous}


def parse_tpex(day: dt.date, margin: dict, prices: dict) -> tuple[list[dict], dict]:
    if margin.get("stat") != "ok" or prices.get("stat") != "ok":
        raise ValueError("TPEx has no data for date")
    price_map: dict[str, dict] = {}
    for row in table(prices, 0):
        if not isinstance(row, list) or len(row) < 10:
            continue
        code, close, average = str(row[0]).strip(), maybe(row[2], positive=True), maybe(row[7], positive=True)
        if code and close:
            price_map[code] = {"close": close, "average": average}
    records = []
    short_balance = short_previous = 0.0
    for row in table(margin, 0):
        if not isinstance(row, list) or len(row) < 16:
            continue
        values = [maybe(row[i]) for i in (2, 3, 4, 5, 6, 10, 14)]
        if any(value is None for value in values):
            continue
        code = str(row[0]).strip()
        quote = price_map.get(code, {})
        rec = {
            "market": "tpex", "code": code, "name": str(row[1]).strip(),
            "previous": values[0] * 1000, "buy": values[1] * 1000, "sell": values[2] * 1000,
            "cash": values[3] * 1000, "balance": values[4] * 1000,
            "short_previous": values[5] * 1000, "short_balance": values[6] * 1000,
            "close": quote.get("close"), "average": quote.get("average"),
        }
        records.append(rec)
        short_previous += rec["short_previous"]
        short_balance += rec["short_balance"]
    return records, {"short_balance": short_balance, "short_previous": short_previous}


def fetch_day(day: dt.date) -> tuple[list[dict], dict]:
    fmt = formats(day)
    twse_margin = get_json(TWSE_MARGIN.format(**fmt))
    if twse_margin.get("stat") != "OK" or str(twse_margin.get("date", "")) != fmt["date"]:
        raise ValueError("not a TWSE trading day")
    last: Exception | None = None
    for attempt in range(3):
        try:
            with ThreadPoolExecutor(max_workers=3) as executor:
                futures = [executor.submit(get_json, url) for url in (
                    TWSE_PRICE.format(**fmt), TPEX_MARGIN.format(**fmt), TPEX_PRICE.format(**fmt))]
                twse_price, tpex_margin, tpex_price = [future.result() for future in futures]
            twse, twse_totals = parse_twse(day, twse_margin, twse_price)
            tpex, tpex_totals = parse_tpex(day, tpex_margin, tpex_price)
            if len(twse) < 100 or len(tpex) < 50:
                raise RuntimeError("security coverage is unexpectedly small")
            return twse + tpex, {"twse": twse_totals, "tpex": tpex_totals}
        except RETRYABLE_NETWORK_ERRORS as exc:
            last = NetworkFetchError(f"official source transport failed for {day}: {exc}")
            if attempt + 1 < 3:
                time.sleep(1.2 * (attempt + 1))
        except (ValueError, RuntimeError) as exc:
            last = exc
            if attempt + 1 < 3:
                time.sleep(1.2 * (attempt + 1))
    if isinstance(last, NetworkFetchError):
        raise NetworkFetchError(f"official trading day transport failed: {last}") from last
    raise RuntimeError(f"official trading day is incomplete: {last}")


def blank_state() -> dict:
    return {"model": "rolling_estimated_margin_cost", "data_date": None, "warmup_trading_days": 0,
            "securities": {}, "history": [], "events": []}


def load_json(path: Path) -> dict | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else None
    except (OSError, ValueError):
        return None


def safe_quote(rec: dict, old: dict | None, day: dt.date) -> tuple[float | None, bool]:
    close = maybe(rec.get("close"), positive=True)
    if close is not None:
        return close, False
    if not old:
        return None, False
    old_close = maybe(old.get("last_close"), positive=True)
    old_date = str(old.get("price_date", ""))
    try:
        age = (day - dt.date.fromisoformat(old_date)).days
    except ValueError:
        return None, False
    return (old_close, True) if old_close and 0 <= age <= MAX_STALE_DAYS else (None, False)


def roll_security(rec: dict, old: dict | None, day: dt.date) -> tuple[dict | None, dict]:
    close, stale = safe_quote(rec, old, day)
    balance, reported_previous = number(rec["balance"]), number(rec["previous"])
    buy, removed = number(rec["buy"]), number(rec["sell"]) + number(rec["cash"])
    event = {"corporate_action": False, "reconciled": False, "stale": stale}
    if old and maybe(old.get("estimated_cost"), positive=True) and maybe(old.get("shares"), positive=True):
        old_cost, old_shares = number(old["estimated_cost"]), number(old["shares"])
        if reported_previous > 0 and abs(reported_previous - old_shares) >= max(1000, old_shares * 0.002):
            ratio = reported_previous / old_shares
            if 0.1 <= ratio <= 10:
                event["corporate_action"] = True
                event["share_adjustment_ratio"] = round(ratio, 6)
            else:
                event["reconciled"] = True
            old_shares = reported_previous
        previous_average = old_cost / old_shares if old_shares > 0 else 0
        purchase_price = maybe(rec.get("average"), positive=True) or close
        if buy > 0 and purchase_price is None:
            return None, {**event, "reason": "purchase_price_unavailable"}
        cost = old_cost + buy * (purchase_price or 0) - min(removed, old_shares + buy) * previous_average
        expected = max(0.0, reported_previous + buy - removed)
        if abs(expected - balance) > max(1000, balance * 0.002):
            event["reconciled"] = True
            cost = max(0.0, cost + (balance - expected) * previous_average)
    else:
        purchase_price = maybe(rec.get("average"), positive=True) or close
        if balance <= 0 or purchase_price is None:
            return None, {**event, "reason": "initial_price_unavailable"}
        cost = balance * purchase_price
    if balance <= 0:
        return None, event
    if close is None or not math.isfinite(cost) or cost <= 0:
        return None, {**event, "reason": "invalid_cost_or_close"}
    return {
        "market": rec["market"], "code": rec["code"], "name": rec["name"], "shares": round(balance),
        "estimated_cost": round(cost, 2), "last_close": close,
        "price_date": old.get("price_date") if stale and old else day.isoformat(),
    }, event


def summarize(state: dict, records: list[dict], short: dict, day: dt.date) -> dict:
    old_securities = state.get("securities", {}) if isinstance(state.get("securities"), dict) else {}
    securities: dict[str, dict] = {}
    market = {name: {"collateral_market_value": 0.0, "estimated_remaining_cost": 0.0,
                     "estimated_financing_principal": 0.0, "margin_balance_shares": 0.0,
                     "matched_count": 0, "missing_count": 0, "stale_price_count": 0}
              for name in ("twse", "tpex")}
    events, missing = [], []
    official_balance_shares = 0.0
    for rec in records:
        key = f"{rec['market']}:{rec['code']}"
        official_balance_shares += rec["balance"]
        rolled, event = roll_security(rec, old_securities.get(key), day)
        if event.get("corporate_action") or event.get("reconciled"):
            events.append({"date": day.isoformat(), "market": rec["market"], "code": rec["code"], **event})
        if rolled is None:
            if rec["balance"] > 0:
                market[rec["market"]]["missing_count"] += 1
                missing.append({"market": rec["market"].upper(), "code": rec["code"], "reason": event.get("reason", "unmatched")})
            continue
        securities[key] = rolled
        bucket = market[rec["market"]]
        collateral = rolled["shares"] * rolled["last_close"]
        bucket["collateral_market_value"] += collateral
        bucket["estimated_remaining_cost"] += rolled["estimated_cost"]
        bucket["estimated_financing_principal"] += rolled["estimated_cost"] * FINANCING_RATIO
        bucket["margin_balance_shares"] += rolled["shares"]
        bucket["matched_count"] += 1
        bucket["stale_price_count"] += int(event.get("stale", False))
    combined: dict[str, float] = {}
    for key in ("collateral_market_value", "estimated_remaining_cost", "estimated_financing_principal",
                "margin_balance_shares", "matched_count", "missing_count", "stale_price_count"):
        combined[key] = market["twse"][key] + market["tpex"][key]
    for bucket in (market["twse"], market["tpex"], combined):
        principal = bucket["estimated_financing_principal"]
        bucket["maintenance_ratio"] = bucket["collateral_market_value"] / principal * 100 if principal > 0 else None
        for key, value in list(bucket.items()):
            if isinstance(value, float):
                bucket[key] = round(value, 2 if key == "maintenance_ratio" else 0)
    coverage = combined["margin_balance_shares"] / official_balance_shares * 100 if official_balance_shares else 0
    state["securities"] = securities
    state["data_date"] = day.isoformat()
    state["warmup_trading_days"] = int(state.get("warmup_trading_days", 0)) + 1
    state["events"] = (state.get("events", []) + events)[-300:]
    summary = {
        "date": day.isoformat(), "markets": {**market, "combined": combined},
        "short_balance": round(short["twse"]["short_balance"] + short["tpex"]["short_balance"]),
        "short_previous": round(short["twse"]["short_previous"] + short["tpex"]["short_previous"]),
        "coverage_ratio": round(coverage, 2), "missing_securities": missing[:200],
    }
    state["history"] = (state.get("history", []) + [summary])[-260:]
    return summary


def percentile(values: list[float], current: float, minimum: int = 20) -> float | None:
    clean = [value for value in values if isinstance(value, (int, float)) and math.isfinite(value)]
    return round(sum(value <= current for value in clean) / len(clean) * 100, 1) if len(clean) >= minimum else None


def build_payload(state: dict, now: dt.datetime) -> dict:
    history = state["history"]
    current, previous = history[-1], history[-2] if len(history) > 1 else None
    combined = current["markets"]["combined"]
    prev_combined = previous["markets"]["combined"] if previous else None
    principal, ratio = combined["estimated_financing_principal"], combined["maintenance_ratio"]
    principal_change = principal - prev_combined["estimated_financing_principal"] if prev_combined else None
    ratio_change = ratio - prev_combined["maintenance_ratio"] if prev_combined else None
    principal_samples = [row["markets"]["combined"]["estimated_financing_principal"] for row in history]
    ratio_samples = [row["markets"]["combined"]["maintenance_ratio"] for row in history]
    short_change = current["short_balance"] - current["short_previous"]
    payload = {
        "data_date": current["date"], "updated_at": now.astimezone(TAIPEI).isoformat(timespec="seconds"),
        "data_mode": "after_hours",
        "model": {"name": "rolling_estimated_margin_cost", "financing_ratio": FINANCING_RATIO,
                  "initial_maintenance_ratio": round(INITIAL_RATIO, 4),
                  "warmup_trading_days": state["warmup_trading_days"], "is_estimated": True,
                  "sample_state": "ready" if state["warmup_trading_days"] >= 60 else "building"},
        "margin_balance": {
            "estimated_financing_principal": round(principal),
            "daily_change": round(principal_change) if principal_change is not None else None,
            "daily_change_pct": round(principal_change / prev_combined["estimated_financing_principal"] * 100, 2) if principal_change is not None and prev_combined["estimated_financing_principal"] else None,
            "change_20d": round(principal - principal_samples[-21]) if len(principal_samples) >= 21 else None,
            "percentile_60d": percentile(principal_samples[-60:], principal),
            "balance_shares": round(combined["margin_balance_shares"]),
        },
        "maintenance_ratio": {
            "value": round(ratio, 2), "daily_change": round(ratio_change, 2) if ratio_change is not None else None,
            "average_20d": round(sum(ratio_samples[-20:]) / 20, 2) if len(ratio_samples) >= 20 else None,
            "percentile_60d": percentile(ratio_samples[-60:], ratio),
            "collateral_market_value": round(combined["collateral_market_value"]),
            "estimated_financing_principal": round(principal), "method": "rolling_estimated_margin_cost",
            "is_estimated": True,
        },
        "short_balance": {"shares": current["short_balance"], "daily_change": round(short_change)},
        "markets": current["markets"],
        "coverage": {"matched_count": round(combined["matched_count"]), "missing_count": round(combined["missing_count"]),
                     "coverage_ratio": current["coverage_ratio"], "stale_price_count": round(combined["stale_price_count"])},
        "risk_state": "成本模型樣本建立中" if state["warmup_trading_days"] < 60 else "依推估維持率判讀",
        "summary": "融資本金採逐檔滾動成本推估；融資增減與維持率需交叉觀察，單日變動不代表後續方向。",
        "source_name": "臺灣證券交易所／證券櫃檯買賣中心官方結構化資料",
        "source_url": TWSE_SOURCE, "secondary_source_url": TPEX_SOURCE,
        "source_status": {"twse": {"ok": True}, "tpex": {"ok": True}, "same_scope": True,
                          "unit_mapping": "融資與融券張數欄位 x 1,000 股；價格為新臺幣/股"},
        "history": [{"date": row["date"], "estimated_financing_principal": row["markets"]["combined"]["estimated_financing_principal"],
                     "collateral_market_value": row["markets"]["combined"]["collateral_market_value"],
                     "maintenance_ratio": row["markets"]["combined"]["maintenance_ratio"]} for row in history[-160:]],
        "missing_securities": current.get("missing_securities", []),
        "methodology": "逐檔昨日平均成本＝昨日推估成本÷昨日融資股數；新增融資以當日均價（缺少時收盤價）計成本；賣出與現償按昨日平均成本減除；剩餘成本×60%為推估本金。全市場先各自加總同範圍擔保品與本金，再計算比率。",
        "disclaimer": "市場推估融資維持率僅用於觀察整體融資戶壓力，不代表個人帳戶維持率或追繳狀態。130%僅為個別信用帳戶法規參考。",
        "rule_url": RULE_SOURCE,
    }
    validate_payload(payload)
    return payload


def validate_payload(payload: dict) -> None:
    dt.date.fromisoformat(payload["data_date"])
    if payload.get("model", {}).get("name") != "rolling_estimated_margin_cost":
        raise ValueError("wrong model")
    if payload["model"].get("warmup_trading_days", 0) < MIN_WARMUP_DAYS:
        raise ValueError("rolling model has fewer than 120 warmup days")
    balance, maintenance = payload["margin_balance"], payload["maintenance_ratio"]
    for value in (balance["estimated_financing_principal"], balance["balance_shares"],
                  maintenance["value"], maintenance["collateral_market_value"],
                  maintenance["estimated_financing_principal"]):
        if maybe(value, positive=True) is None:
            raise ValueError("required model value is invalid")
    if balance["estimated_financing_principal"] != maintenance["estimated_financing_principal"]:
        raise ValueError("homepage and detail principal fields diverge")
    if not 100 < maintenance["value"] < 400:
        raise ValueError("maintenance estimate is unreasonable")
    for name in ("twse", "tpex", "combined"):
        bucket = payload["markets"][name]
        expected = bucket["collateral_market_value"] / bucket["estimated_financing_principal"] * 100
        if abs(expected - bucket["maintenance_ratio"]) > 0.02:
            raise ValueError(f"{name} market scope is inconsistent")
    json.dumps(payload, ensure_ascii=False, allow_nan=False)


def atomic_write(path: Path, payload: dict) -> None:
    handle, temporary = tempfile.mkstemp(prefix=path.stem + "-", suffix=".json", dir=ROOT)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def reconciliation(payload: dict) -> dict | None:
    if payload["data_date"] != "2026-07-31":
        return None
    reference = {"estimated_financing_principal": 545_500_000_000, "collateral_market_value": 889_600_000_000,
                 "maintenance_ratio": 163.08, "balance_shares": 9_096_008_000,
                 "short_balance_shares": 219_259_000}
    actual = {
        "estimated_financing_principal": payload["margin_balance"]["estimated_financing_principal"],
        "collateral_market_value": payload["maintenance_ratio"]["collateral_market_value"],
        "maintenance_ratio": payload["maintenance_ratio"]["value"],
        "balance_shares": payload["margin_balance"]["balance_shares"],
        "short_balance_shares": payload["short_balance"]["shares"],
    }
    differences = {key: round((actual[key] - value) / value * 100, 2) for key, value in reference.items()}
    if all(abs(value) <= 3 for value in differences.values()):
        return None
    return {
        "data_date": payload["data_date"], "generated_at": payload["updated_at"],
        "reason": "與使用者提供的畫面參考值相差超過3%；未套用任何調整係數。",
        "reference": reference, "actual": actual, "difference_pct": differences,
        "markets": payload["markets"], "coverage": payload["coverage"],
        "missing_securities": payload["missing_securities"],
        "estimated_remaining_cost": payload["markets"]["combined"]["estimated_remaining_cost"],
        "financing_ratio": FINANCING_RATIO, "sources": [TWSE_SOURCE, TPEX_SOURCE],
        "units": {"money": "TWD", "shares": "shares", "maintenance_ratio": "percent"},
    }


def trading_days_to_fetch(end: dt.date, target: int) -> list[dt.date]:
    days, cursor = [], end
    while len(days) < target and (end - cursor).days < 260:
        if cursor.weekday() < 5:
            try:
                records, short = fetch_day(cursor)
                days.append((cursor, records, short))
                print(f"bootstrap {len(days):03d}/{target}: {cursor}", flush=True)
            except (ValueError, RuntimeError):
                pass
        cursor -= dt.timedelta(days=1)
    if len(days) < target:
        raise RuntimeError(f"only {len(days)} official trading days were available")
    return list(reversed(days))


def newest_day(now: dt.date, after: str | None) -> tuple[dt.date, list[dict], dict] | None:
    network_errors: list[NetworkFetchError] = []
    for offset in range(0, 12):
        day = now - dt.timedelta(days=offset)
        if day.weekday() >= 5 or (after and day.isoformat() <= after):
            continue
        try:
            records, short = fetch_day(day)
            return day, records, short
        except NetworkFetchError as exc:
            network_errors.append(exc)
        except (ValueError, RuntimeError):
            continue
    if network_errors:
        raise NetworkFetchError(f"newest trading day lookup failed: {network_errors[-1]}") from network_errors[-1]
    return None


def valid_previous_cache(payload: dict | None, state: dict | None) -> bool:
    if not isinstance(payload, dict) or not isinstance(state, dict):
        return False
    try:
        validate_payload(payload)
        if state.get("model") != "rolling_estimated_margin_cost":
            return False
        if state.get("warmup_trading_days", 0) < MIN_WARMUP_DAYS:
            return False
        if state.get("data_date") != payload.get("data_date"):
            return False
        if not isinstance(state.get("history"), list) or not state["history"]:
            return False
        return True
    except (KeyError, TypeError, ValueError):
        return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bootstrap-days", type=int, default=TARGET_WARMUP_DAYS)
    args = parser.parse_args()
    now = dt.datetime.now(dt.timezone.utc)
    today = now.astimezone(TAIPEI).date()
    old_payload, state = load_json(OUT), load_json(STATE)
    has_valid_previous = valid_previous_cache(old_payload, state)
    try:
        if not state or state.get("model") != "rolling_estimated_margin_cost" or state.get("warmup_trading_days", 0) < MIN_WARMUP_DAYS:
            state = blank_state()
            for day, records, short in trading_days_to_fetch(today, max(MIN_WARMUP_DAYS, args.bootstrap_days)):
                summarize(state, records, short, day)
        else:
            latest = newest_day(today, state.get("data_date"))
            if latest:
                summarize(state, latest[1], latest[2], latest[0])
            elif has_valid_previous:
                print(f"no newer official trading day; retained {OUT.name} data_date={old_payload['data_date']}")
                return 0
        payload = build_payload(state, now)
        atomic_write(STATE, state)
        atomic_write(OUT, payload)
        report = reconciliation(payload)
        if report:
            atomic_write(RECONCILIATION, report)
        elif RECONCILIATION.exists():
            RECONCILIATION.unlink()
        print(f"updated {OUT.name}: {payload['data_date']} ratio={payload['maintenance_ratio']['value']} warmup={payload['model']['warmup_trading_days']}")
        return 0
    except Exception as exc:
        if has_valid_previous:
            print("MARGIN_UPDATE_DEGRADED")
            print("retained previous valid cache")
            print(f"reason={type(exc).__name__}: {exc}")
            return 0
        raise


if __name__ == "__main__":
    raise SystemExit(main())
