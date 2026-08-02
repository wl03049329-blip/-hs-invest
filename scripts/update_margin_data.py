#!/usr/bin/env python3
"""Build the after-hours Taiwan margin-risk cache from structured data.

The exchange does not publish one official market-wide maintenance ratio.  We
therefore publish an explicitly labelled estimate:

    same-day market value of margin-financed collateral
    ----------------------------------------------------  x 100
         same-day outstanding financing amount

Security balances and closes come from TWSE / TPEx OpenAPI.  The market-wide
financing amount and its history come from FinMind's structured Taiwan market
aggregate.  Missing values are never replaced by zero.
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
OUT = ROOT / "margin-data.json"
FINMIND_API = "https://api.finmindtrade.com/api/v4/data"
TWSE_MARGIN_API = "https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN"
TWSE_PRICE_API = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"
TPEX_MARGIN_API = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_margin_balance"
TPEX_PRICE_API = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes"
TWSE_SOURCE = "https://www.twse.com.tw/zh/trading/margin/mi-margn.html"
TPEX_SOURCE = "https://www.tpex.org.tw/zh-tw/mainboard/trading/margin-trading/transactions.html"
FINMIND_SOURCE = "https://finmind.github.io/"
MAINTENANCE_RULE = "https://twse-regulation.twse.com.tw/TW/law/DOC01.aspx?FLCODE=FL007121&FLNO=53"
HEADERS = {"User-Agent": "HS-ETF-Stock-Radar/6.2 (+GitHub Actions)", "Accept": "application/json"}
TAIPEI = dt.timezone(dt.timedelta(hours=8))
SHARES_PER_REPORTED_UNIT = 1_000  # TWSE trading unit / TPEx thousand shares.
MONEY_SCALE = 1  # FinMind TodayBalance is already NTD.
MIN_PUBLISH_COVERAGE = 95.0
NORMAL_COVERAGE = 98.0
MAX_PRICE_CACHE_AGE_DAYS = 10


def finite_number(value: object, *, positive: bool = False) -> float:
    if isinstance(value, bool):
        raise ValueError("boolean is not numeric")
    if isinstance(value, str):
        value = value.replace(",", "").replace("+", "").strip()
    number = float(value)
    if not math.isfinite(number) or (positive and number <= 0):
        raise ValueError("invalid numeric value")
    return number


def optional_positive(value: object) -> float | None:
    try:
        return finite_number(value, positive=True)
    except (TypeError, ValueError):
        return None


def get_json(url: str, timeout: int = 30) -> object:
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status != 200:
            raise RuntimeError(f"HTTP {response.status}")
        return json.loads(response.read().decode("utf-8-sig"))


def finmind_history(now: dt.datetime) -> list[dict]:
    params = {
        "dataset": "TaiwanStockTotalMarginPurchaseShortSale",
        "start_date": (now.date() - dt.timedelta(days=240)).isoformat(),
        "end_date": now.date().isoformat(),
    }
    token = os.getenv("FINMIND_TOKEN", "").strip()
    if token:
        params["token"] = token
    payload = get_json(FINMIND_API + "?" + urllib.parse.urlencode(params))
    if not isinstance(payload, dict) or payload.get("status") != 200 or not isinstance(payload.get("data"), list):
        raise ValueError("FinMind margin response is invalid")
    rows: list[dict] = []
    for row in payload["data"]:
        if row.get("name") != "MarginPurchaseMoney" or not isinstance(row.get("date"), str):
            continue
        try:
            value = finite_number(row.get("TodayBalance"), positive=True) * MONEY_SCALE
            previous = finite_number(row.get("YesBalance"), positive=True) * MONEY_SCALE
        except (TypeError, ValueError):
            continue
        rows.append({"date": row["date"], "value": round(value), "previous": round(previous)})
    rows.sort(key=lambda item: item["date"])
    if len(rows) < 21:
        raise ValueError("FinMind margin history has fewer than 21 observations")
    return rows[-160:]


def percentile(values: list[float], current: float, minimum: int = 20) -> float | None:
    clean = [value for value in values if math.isfinite(value)]
    if len(clean) < minimum:
        return None
    return round(sum(value <= current for value in clean) / len(clean) * 100, 1)


def roc_date_to_iso(value: object) -> str | None:
    text = str(value or "").strip().replace("/", "")
    if len(text) != 7 or not text.isdigit():
        return None
    try:
        return dt.date(int(text[:3]) + 1911, int(text[3:5]), int(text[5:7])).isoformat()
    except ValueError:
        return None


def row_date(row: dict) -> str | None:
    raw = row.get("Date") or row.get("date")
    text = str(raw or "").strip()
    if len(text) == 10:
        try:
            return dt.date.fromisoformat(text.replace("/", "-")).isoformat()
        except ValueError:
            return None
    return roc_date_to_iso(text)


def official_rows() -> dict[str, list[dict]]:
    result = {
        "twse_margin": get_json(TWSE_MARGIN_API),
        "twse_prices": get_json(TWSE_PRICE_API),
        "tpex_margin": get_json(TPEX_MARGIN_API),
        "tpex_prices": get_json(TPEX_PRICE_API),
    }
    minimums = {"twse_margin": 100, "twse_prices": 100, "tpex_margin": 50, "tpex_prices": 50}
    for key, rows in result.items():
        if not isinstance(rows, list) or len(rows) < minimums[key] or not all(isinstance(row, dict) for row in rows[:10]):
            raise ValueError(f"{key} response is invalid")
    return result


def _latest_common_date(data: dict[str, list[dict]], financing_date: str) -> str:
    twse_dates = {date for row in data["twse_prices"] if (date := row_date(row))}
    tpex_margin_dates = {date for row in data["tpex_margin"] if (date := row_date(row))}
    tpex_price_dates = {date for row in data["tpex_prices"] if (date := row_date(row))}
    common = twse_dates & tpex_margin_dates & tpex_price_dates & {financing_date}
    if not common:
        raise ValueError("TWSE, TPEx and financing amount dates do not match")
    return max(common)


def _price_map(rows: list[dict], market: str, target_date: str, previous_cache: dict) -> tuple[dict, int]:
    code_key = "Code" if market == "twse" else "SecuritiesCompanyCode"
    price_key = "ClosingPrice" if market == "twse" else "Close"
    by_code: dict[str, list[tuple[str, float]]] = {}
    for row in rows:
        code = str(row.get(code_key, "")).strip()
        date = row_date(row)
        price = optional_positive(row.get(price_key))
        if code and date and date <= target_date and price is not None:
            by_code.setdefault(code, []).append((date, price))
    prices: dict[str, dict] = {}
    suspended = 0
    target = dt.date.fromisoformat(target_date)
    for code, observations in by_code.items():
        date, price = max(observations, key=lambda item: item[0])
        age = (target - dt.date.fromisoformat(date)).days
        if age <= MAX_PRICE_CACHE_AGE_DAYS:
            prices[code] = {"price": price, "date": date, "is_previous_close": date != target_date}
            suspended += int(date != target_date)
    for key, cached in (previous_cache or {}).items():
        if not key.startswith(market + ":") or not isinstance(cached, dict):
            continue
        code = key.split(":", 1)[1]
        if code in prices:
            continue
        price, date = optional_positive(cached.get("price")), str(cached.get("date", ""))
        try:
            age = (target - dt.date.fromisoformat(date)).days
        except ValueError:
            continue
        if price is not None and 0 <= age <= MAX_PRICE_CACHE_AGE_DAYS:
            prices[code] = {"price": price, "date": date, "is_previous_close": True}
            suspended += 1
    return prices, suspended


def estimate_market_ratio(data: dict[str, list[dict]], financing_amount: float, financing_date: str,
                          previous_cache: dict | None = None) -> dict:
    """Return a same-day, unit-normalised estimate and coverage diagnostics."""
    date = _latest_common_date(data, financing_date)
    twse_prices, twse_suspended = _price_map(data["twse_prices"], "twse", date, previous_cache or {})
    tpex_prices, tpex_suspended = _price_map(data["tpex_prices"], "tpex", date, previous_cache or {})
    specs = [
        ("twse", data["twse_margin"], "股票代號", "融資今日餘額", twse_prices),
        ("tpex", data["tpex_margin"], "SecuritiesCompanyCode", "MarginPurchaseBalance", tpex_prices),
    ]
    total_shares = matched_shares = collateral = 0.0
    matched_count = missing_count = 0
    missing: list[dict[str, str]] = []
    cache: dict[str, dict] = {}
    for market, rows, code_key, balance_key, prices in specs:
        for row in rows:
            code = str(row.get(code_key, "")).strip()
            units = optional_positive(row.get(balance_key))
            if not code or units is None:
                continue
            shares = units * SHARES_PER_REPORTED_UNIT
            total_shares += shares
            quote = prices.get(code)
            if quote is None:
                missing_count += 1
                missing.append({"market": market.upper(), "code": code, "reason": "same_or_recent_close_unavailable"})
                continue
            matched_count += 1
            matched_shares += shares
            collateral += shares * quote["price"]
            cache[f"{market}:{code}"] = {"price": quote["price"], "date": quote["date"]}
    if total_shares <= 0 or financing_amount <= 0:
        raise ValueError("market balances or financing amount are invalid")
    coverage = matched_shares / total_shares * 100
    ratio = collateral / financing_amount * 100
    if not math.isfinite(ratio) or ratio <= 100 or ratio >= 1000:
        raise ValueError("estimated maintenance ratio is unreasonable")
    return {
        "data_date": date,
        "value": round(ratio, 2),
        "collateral_market_value": round(collateral),
        "financing_amount": round(financing_amount),
        "coverage_ratio": round(coverage, 2),
        "matched_security_count": matched_count,
        "missing_security_count": missing_count,
        "suspended_price_count": twse_suspended + tpex_suspended,
        "missing_securities": missing[:100],
        "price_cache": cache,
    }


def merge_history(balance_history: list[dict], previous: dict | None, estimate: dict | None) -> list[dict]:
    previous_rows = {row.get("date"): row for row in (previous or {}).get("history", []) if isinstance(row, dict)}
    output: list[dict] = []
    for balance in balance_history[-160:]:
        old = previous_rows.get(balance["date"], {})
        row = {
            "date": balance["date"],
            "margin_balance": round(float(balance["value"])),
            "collateral_market_value": old.get("collateral_market_value"),
            "financing_amount": old.get("financing_amount"),
            "maintenance_ratio": old.get("maintenance_ratio"),
            "coverage_ratio": old.get("coverage_ratio"),
        }
        if estimate and balance["date"] == estimate["data_date"]:
            row.update({key: estimate[key] for key in (
                "collateral_market_value", "financing_amount", "coverage_ratio")})
            row["maintenance_ratio"] = estimate["value"]
        output.append(row)
    return output[-160:]


def ratio_statistics(history: list[dict], current: float | None) -> tuple[float | None, float | None, float | None]:
    samples = [float(row["maintenance_ratio"]) for row in history if optional_positive(row.get("maintenance_ratio"))]
    if current is None:
        return None, None, None
    previous = samples[-2] if len(samples) >= 2 else None
    daily_change = round(current - previous, 2) if previous is not None else None
    average20 = round(sum(samples[-20:]) / 20, 2) if len(samples) >= 20 else None
    pct60 = percentile(samples[-60:], current)
    return daily_change, average20, pct60


def risk_state_for(ratio: float | None) -> str:
    if ratio is None:
        return "資料不完整"
    if ratio >= 180:
        return "安全墊較高"
    if ratio >= 160:
        return "一般水位"
    if ratio >= 150:
        return "安全墊縮小"
    if ratio >= 140:
        return "壓力升高"
    if ratio >= 130:
        return "接近法規參考區"
    return "極端壓力區"


def build_payload(balance_history: list[dict], now: dt.datetime, previous: dict | None = None,
                  official: dict[str, list[dict]] | None = None) -> dict:
    latest = balance_history[-1]
    current, previous_balance = float(latest["value"]), float(balance_history[-2]["value"])
    ref20 = float(balance_history[-21]["value"])
    status: dict[str, Any] = {}
    estimate = None
    estimate_error = None
    try:
        official = official or official_rows()
        estimate = estimate_market_ratio(
            official, current, latest["date"], (previous or {}).get("price_cache", {})
        )
        status["twse"] = {"ok": True, "margin_records": len(official["twse_margin"]), "price_records": len(official["twse_prices"]), "url": TWSE_MARGIN_API}
        status["tpex"] = {"ok": True, "margin_records": len(official["tpex_margin"]), "price_records": len(official["tpex_prices"]), "url": TPEX_MARGIN_API}
    except Exception as exc:
        estimate_error = str(exc)[:200]
        status["estimate"] = {"ok": False, "error": estimate_error}

    publish_estimate = estimate if estimate and estimate["coverage_ratio"] >= MIN_PUBLISH_COVERAGE else None
    history = merge_history(balance_history, previous, publish_estimate)
    retained = False
    effective_date = latest["date"]
    if publish_estimate:
        ratio_value = publish_estimate["value"]
        coverage_state = "normal" if publish_estimate["coverage_ratio"] >= NORMAL_COVERAGE else "partial"
    else:
        old_ratio = (previous or {}).get("maintenance_ratio", {})
        ratio_value = optional_positive(old_ratio.get("value"))
        retained = ratio_value is not None
        effective_date = str(old_ratio.get("effective_data_date") or (previous or {}).get("data_date") or latest["date"])
        coverage_state = "retained_previous" if retained else "unavailable"
    daily, average20, pct60 = ratio_statistics(history, ratio_value)
    diagnostics = estimate or {}
    maintenance = {
        "value": ratio_value,
        "daily_change": daily,
        "average_20d": average20,
        "percentile_60d": pct60,
        "collateral_market_value": diagnostics.get("collateral_market_value") if publish_estimate else (previous or {}).get("maintenance_ratio", {}).get("collateral_market_value") if retained else None,
        "financing_amount": diagnostics.get("financing_amount") if publish_estimate else (previous or {}).get("maintenance_ratio", {}).get("financing_amount") if retained else None,
        "coverage_ratio": diagnostics.get("coverage_ratio") if estimate else None,
        "matched_security_count": diagnostics.get("matched_security_count", 0),
        "missing_security_count": diagnostics.get("missing_security_count", 0),
        "suspended_price_count": diagnostics.get("suspended_price_count", 0),
        "method": "estimated_market_margin_maintenance_ratio",
        "is_estimated": True,
        "coverage_state": coverage_state,
        "effective_data_date": effective_date,
        "retained_previous": retained,
    }
    status["estimate"] = {
        "ok": publish_estimate is not None,
        "coverage_state": coverage_state,
        "coverage_ratio": diagnostics.get("coverage_ratio"),
        "missing_securities": diagnostics.get("missing_securities", []),
        "reason": estimate_error or ("coverage_below_95_percent" if estimate and not publish_estimate else None),
        "unit_mapping": {
            "twse_margin_balance": "trading_units_x_1000_shares",
            "tpex_margin_balance": "thousand_shares_x_1000",
            "close": "TWD_per_share",
            "financing_amount": "FinMind_TodayBalance_TWD",
        },
    }
    daily_change = current - previous_balance
    balance_change20 = current - ref20
    summary = "融資餘額與推估維持率需交叉觀察；單日變動不代表後續方向。"
    payload = {
        "updated_at": now.astimezone(TAIPEI).isoformat(timespec="seconds"),
        "data_date": latest["date"],
        "data_mode": "after_hours",
        "margin_balance": {
            "value": round(current), "daily_change": round(daily_change),
            "change_20d": round(balance_change20),
            "percentile_60d": percentile([float(item["value"]) for item in balance_history[-60:]], current),
        },
        "maintenance_ratio": maintenance,
        "risk_state": risk_state_for(ratio_value),
        "summary": summary,
        "source_name": "TWSE／TPEx OpenAPI（擔保品市值）＋ FinMind 市場融資金額",
        "source_url": TWSE_SOURCE,
        "secondary_source_url": TPEX_SOURCE,
        "financing_source_url": FINMIND_SOURCE,
        "source_status": status,
        "history": history,
        "disclaimer": "市場推估融資維持率為本站依官方個股融資餘額與同日收盤價估算，不是交易所公布的全市場維持率，也不代表個人帳戶維持率或追繳狀態。130% 僅為個別信用帳戶法規參考，不代表所有投資人必然追繳。",
        "methodology": "Σ(融資餘額仟股×1,000×同日收盤價) ÷ 同日市場融資金額餘額 ×100；覆蓋率低於95%時不發布新估值。",
        "rule_url": MAINTENANCE_RULE,
    }
    validate_payload(payload)
    return payload


def validate_payload(payload: dict) -> None:
    if not isinstance(payload, dict) or not isinstance(payload.get("data_date"), str):
        raise ValueError("margin payload/date is invalid")
    try:
        data_date = dt.date.fromisoformat(payload["data_date"])
    except ValueError as exc:
        raise ValueError("margin data date is invalid") from exc
    if data_date > dt.datetime.now(TAIPEI).date() + dt.timedelta(days=1):
        raise ValueError("margin data date is unexpectedly in the future")
    balance, ratio = payload.get("margin_balance"), payload.get("maintenance_ratio")
    if not isinstance(balance, dict) or finite_number(balance.get("value"), positive=True) <= 0:
        raise ValueError("margin balance is invalid")
    balance_value = finite_number(balance["value"], positive=True)
    if abs(finite_number(balance.get("daily_change", 0))) > balance_value * 0.5:
        raise ValueError("margin balance daily jump is unreasonable")
    if not isinstance(ratio, dict) or ratio.get("method") != "estimated_market_margin_maintenance_ratio" or ratio.get("is_estimated") is not True:
        raise ValueError("estimated maintenance ratio metadata is missing")
    if ratio.get("value") is not None:
        value = finite_number(ratio["value"], positive=True)
        if value <= 100 or value >= 1000:
            raise ValueError("maintenance ratio is unreasonable")
        if ratio.get("daily_change") is not None and abs(finite_number(ratio["daily_change"])) > 100:
            raise ValueError("maintenance ratio daily jump is unreasonable")
    for key in ("coverage_ratio",):
        if ratio.get(key) is not None and not 0 <= finite_number(ratio[key]) <= 100:
            raise ValueError(f"{key} is invalid")
    if not isinstance(payload.get("history"), list) or len(payload["history"]) < 120:
        raise ValueError("margin history must retain at least 120 trading observations")
    json.dumps(payload, ensure_ascii=False, allow_nan=False)


def atomic_write(payload: dict) -> None:
    handle, temporary = tempfile.mkstemp(prefix="margin-data-", suffix=".json", dir=ROOT)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
        os.replace(temporary, OUT)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main() -> int:
    now = dt.datetime.now(dt.timezone.utc)
    previous = None
    if OUT.exists():
        try:
            previous = json.loads(OUT.read_text(encoding="utf-8"))
        except Exception:
            previous = None
    try:
        payload = build_payload(finmind_history(now.astimezone(TAIPEI)), now, previous)
        atomic_write(payload)
        print(f"updated {OUT.name}: {payload['data_date']} ratio={payload['maintenance_ratio']['value']}")
        return 0
    except Exception as exc:
        if previous is not None:
            print(f"update failed; retained previous cache: {exc}")
            return 0
        raise


if __name__ == "__main__":
    raise SystemExit(main())
