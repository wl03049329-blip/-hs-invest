#!/usr/bin/env python3
"""Update the after-hours Taiwan margin risk cache from structured sources.

The exchanges do not publish an aggregate market maintenance-ratio series.  This
script therefore leaves that field null unless a future verified structured
source is added; it never derives a personal-account ratio or substitutes zero.
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

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "margin-data.json"
FINMIND_API = "https://api.finmindtrade.com/api/v4/data"
TWSE_API = "https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN"
TPEX_API = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_margin_balance"
TWSE_SOURCE = "https://openapi.twse.com.tw/"
TPEX_SOURCE = "https://www.tpex.org.tw/openapi/"
MAINTENANCE_RULE = "https://twse-regulation.twse.com.tw/TW/law/DOC01.aspx?FLCODE=FL007121&FLNO=53"
HEADERS = {"User-Agent": "HS-ETF-Stock-Radar/6.2 (+GitHub Actions)", "Accept": "application/json"}
TAIPEI = dt.timezone(dt.timedelta(hours=8))


def finite_number(value: object, *, positive: bool = False) -> float:
    if isinstance(value, bool):
        raise ValueError("boolean is not numeric")
    number = float(value)
    if not math.isfinite(number) or (positive and number <= 0):
        raise ValueError("invalid numeric value")
    return number


def get_json(url: str, timeout: int = 30) -> object:
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status != 200:
            raise RuntimeError(f"HTTP {response.status}")
        return json.loads(response.read().decode("utf-8-sig"))


def finmind_history(now: dt.datetime) -> list[dict]:
    params = {
        "dataset": "TaiwanStockTotalMarginPurchaseShortSale",
        "start_date": (now.date() - dt.timedelta(days=130)).isoformat(),
        "end_date": now.date().isoformat(),
    }
    token = os.getenv("FINMIND_TOKEN", "").strip()
    if token:
        params["token"] = token
    payload = get_json(FINMIND_API + "?" + urllib.parse.urlencode(params))
    if not isinstance(payload, dict) or payload.get("status") != 200 or not isinstance(payload.get("data"), list):
        raise ValueError("FinMind margin response is invalid")
    rows = []
    for row in payload["data"]:
        if row.get("name") != "MarginPurchaseMoney" or not isinstance(row.get("date"), str):
            continue
        try:
            value = finite_number(row.get("TodayBalance"), positive=True)
            previous = finite_number(row.get("YesBalance"), positive=True)
        except (TypeError, ValueError):
            continue
        rows.append({"date": row["date"], "value": round(value), "previous": round(previous)})
    rows.sort(key=lambda item: item["date"])
    if len(rows) < 21:
        raise ValueError("FinMind margin history has fewer than 21 observations")
    return rows[-90:]


def percentile(values: list[float], current: float) -> float | None:
    clean = [value for value in values if math.isfinite(value)]
    if len(clean) < 20:
        return None
    return round(sum(value <= current for value in clean) / len(clean) * 100, 1)


def roc_date_to_iso(value: object) -> str | None:
    text = str(value or "").strip()
    if len(text) != 7 or not text.isdigit():
        return None
    try:
        return dt.date(int(text[:3]) + 1911, int(text[3:5]), int(text[5:7])).isoformat()
    except ValueError:
        return None


def validate_official_sources(data_date: str) -> dict:
    status: dict[str, object] = {}
    try:
        twse = get_json(TWSE_API)
        if not isinstance(twse, list) or len(twse) < 100:
            raise ValueError("TWSE response is too small")
        status["twse"] = {"ok": True, "records": len(twse), "url": TWSE_API}
    except Exception as exc:  # Keep historical cache usable if one exchange is late.
        status["twse"] = {"ok": False, "error": str(exc)[:160], "url": TWSE_API}
    try:
        tpex = get_json(TPEX_API)
        if not isinstance(tpex, list) or len(tpex) < 50:
            raise ValueError("TPEx response is too small")
        roc_date = str(tpex[0].get("Date", "")) if tpex else ""
        official_date = roc_date_to_iso(roc_date)
        status["tpex"] = {
            "ok": True,
            "records": len(tpex),
            "data_date": official_date,
            "matches_history": official_date == data_date,
            "url": TPEX_API,
        }
    except Exception as exc:
        status["tpex"] = {"ok": False, "error": str(exc)[:160], "url": TPEX_API}
    status["history"] = {
        "ok": True,
        "provider": "FinMind TaiwanStockTotalMarginPurchaseShortSale",
        "data_date": data_date,
        "note": "交易所公開資料的結構化歷史彙整；官方 OpenAPI 同步做可用性驗證。",
    }
    status["maintenance_ratio"] = {
        "ok": False,
        "reason": "official_market_aggregate_not_published",
        "note": "官方規則公布個別信用帳戶計算公式，但未發布同口徑的全市場平均維持率序列。",
        "rule_url": MAINTENANCE_RULE,
    }
    return status


def build_payload(history: list[dict], now: dt.datetime) -> dict:
    latest = history[-1]
    current = finite_number(latest["value"], positive=True)
    previous = finite_number(history[-2]["value"], positive=True)
    ref20 = finite_number(history[-21]["value"], positive=True)
    daily_change = current - previous
    change_20d = current - ref20
    pct60 = percentile([float(item["value"]) for item in history[-60:]], current)
    status = validate_official_sources(latest["date"])
    if daily_change < 0:
        risk_state = "去槓桿觀察"
        summary = "融資餘額下降，市場正在降低槓桿；維持率缺值，仍需搭配價格是否止跌。"
    elif daily_change > 0:
        risk_state = "擁擠度觀察"
        summary = "融資餘額增加，追價與擁擠風險需觀察；維持率資料目前缺值。"
    else:
        risk_state = "中性"
        summary = "融資餘額變化有限；維持率資料目前缺值。"
    payload = {
        "updated_at": now.astimezone(TAIPEI).isoformat(timespec="seconds"),
        "data_date": latest["date"],
        "data_mode": "after_hours",
        "margin_balance": {
            "value": round(current),
            "daily_change": round(daily_change),
            "change_20d": round(change_20d),
            "percentile_60d": pct60,
        },
        "maintenance_ratio": {
            "value": None,
            "daily_change": None,
            "average_20d": None,
            "percentile_60d": None,
        },
        "risk_state": risk_state,
        "summary": summary,
        "source_name": "臺灣證券交易所／櫃買中心公開資料；FinMind 結構化歷史彙整",
        "source_url": TWSE_SOURCE,
        "secondary_source_url": TPEX_SOURCE,
        "source_status": status,
        "history": history,
        "disclaimer": "市場融資維持率僅用於觀察整體融資戶壓力，不代表個人帳戶維持率或追繳狀態。",
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
    balance = payload.get("margin_balance")
    ratio = payload.get("maintenance_ratio")
    if not isinstance(balance, dict) or finite_number(balance.get("value"), positive=True) <= 0:
        raise ValueError("margin balance is invalid")
    balance_value = finite_number(balance["value"], positive=True)
    daily_change = finite_number(balance.get("daily_change", 0))
    if abs(daily_change) > balance_value * 0.5:
        raise ValueError("margin balance daily jump is unreasonable")
    if not isinstance(ratio, dict):
        raise ValueError("maintenance ratio object is missing")
    if ratio.get("value") is not None:
        value = finite_number(ratio["value"], positive=True)
        if value >= 1000:
            raise ValueError("maintenance ratio is unreasonable")
        ratio_change = finite_number(ratio.get("daily_change", 0))
        if abs(ratio_change) > 100:
            raise ValueError("maintenance ratio daily jump is unreasonable")
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
            validate_payload(previous)
        except Exception:
            previous = None
    try:
        payload = build_payload(finmind_history(now.astimezone(TAIPEI)), now)
        atomic_write(payload)
        print(f"updated {OUT.name}: {payload['data_date']}")
        return 0
    except Exception as exc:
        if previous is not None:
            print(f"update failed; retained previous valid cache: {exc}")
            return 0
        raise


if __name__ == "__main__":
    raise SystemExit(main())
