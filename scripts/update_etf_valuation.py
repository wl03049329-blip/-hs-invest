#!/usr/bin/env python3
"""Update ETF valuation proxies from issuer-owned structured data.

The current primary source for 00830 is Invesco's public JSON fund
characteristics resource for SOXQ. SOXX remains documented as a secondary
proxy, but is not scraped from the large iShares product HTML page while the
same-benchmark SOXQ JSON source is healthy.
"""

from __future__ import annotations

import json
import math
import os
import tempfile
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
MAP_PATH = ROOT / "valuation-proxy-map.json"
OUTPUT_PATH = ROOT / "etf-valuation.json"
HISTORY_PATH = ROOT / "valuation-history.json"
USER_AGENT = "HS-ETF-Radar/6.1 (+https://github.com/wl03049329-blip/-hs-invest)"


def read_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def write_atomic(path: Path, payload: dict[str, Any]) -> None:
    handle, temp_name = tempfile.mkstemp(prefix=f"{path.stem}-", suffix=".json", dir=ROOT)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def fetch_json(url: str, timeout: int = 25) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json, text/plain, */*",
            "Referer": "https://www.invesco.com/",
            "User-Agent": USER_AGENT,
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        content_type = response.headers.get("Content-Type", "")
        body = response.read(256_001)
    if len(body) > 256_000:
        raise ValueError("valuation response is unexpectedly large")
    if "json" not in content_type.lower() and not body.lstrip().startswith(b"{"):
        raise ValueError("valuation source did not return JSON")
    payload = json.loads(body.decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("valuation response is not an object")
    return payload


def number(value: Any, *, minimum: float | None = None, maximum: float | None = None) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(result):
        return None
    if minimum is not None and result < minimum:
        return None
    if maximum is not None and result > maximum:
        return None
    return result


def interpolate(value: float, points: list[tuple[float, float]]) -> float:
    if value <= points[0][0]:
        return points[0][1]
    if value >= points[-1][0]:
        return points[-1][1]
    for left, right in zip(points, points[1:]):
        if value <= right[0]:
            ratio = (value - left[0]) / (right[0] - left[0])
            return left[1] + (right[1] - left[1]) * ratio
    raise AssertionError("unreachable")


def percentile(values: list[float], current: float) -> float | None:
    if not values:
        return None
    return round(sum(value <= current for value in values) / len(values) * 100, 2)


def valuation_score(item: dict[str, Any]) -> tuple[int | None, int]:
    metrics: dict[str, tuple[float | None, int]] = {
        "current_pe": (
            interpolate(item["current_pe"], [(8, 95), (15, 82), (25, 65), (40, 45), (60, 25), (100, 10)])
            if item.get("current_pe") is not None
            else None,
            15,
        ),
        "forward_pe": (
            interpolate(item["forward_pe"], [(8, 95), (15, 82), (25, 66), (35, 50), (50, 32), (80, 12)])
            if item.get("forward_pe") is not None
            else None,
            25,
        ),
        "pe_percentile": (
            100 - item["pe_percentile"] if item.get("pe_percentile") is not None else None,
            15,
        ),
        "forward_pe_percentile": (
            100 - item["forward_pe_percentile"] if item.get("forward_pe_percentile") is not None else None,
            10,
        ),
        "earnings_growth": (
            interpolate(item["earnings_growth"], [(-20, 10), (0, 30), (10, 48), (20, 62), (40, 78), (80, 90), (150, 95)])
            if item.get("earnings_growth") is not None
            else None,
            20,
        ),
        "peg": (
            interpolate(item["peg"], [(0.4, 95), (0.8, 85), (1.2, 74), (1.8, 58), (2.5, 40), (4, 20), (8, 8)])
            if item.get("peg") is not None
            else None,
            10,
        ),
        "pb": (
            interpolate(item["pb"], [(0.8, 95), (1.5, 85), (3, 70), (6, 50), (10, 32), (20, 12), (40, 5)])
            if item.get("pb") is not None
            else None,
            5,
        ),
    }
    available = [(value, weight) for value, weight in metrics.values() if value is not None]
    available_weight = sum(weight for _, weight in available)
    if available_weight < 50:
        return None, available_weight
    return round(sum(value * weight for value, weight in available) / available_weight), available_weight


def parse_source_date(value: Any) -> str:
    text = str(value or "")
    datetime.strptime(text, "%Y-%m-%d")
    parsed = date.fromisoformat(text)
    if parsed > date.today() + timedelta(days=2) or parsed < date.today() - timedelta(days=120):
        raise ValueError("valuation source date is unreasonable")
    return text


def history_values(
    history: dict[str, Any], code: str, key: str, source_name: str
) -> tuple[list[float], set[str]]:
    values: list[float] = []
    source_dates: set[str] = set()
    for snapshot in history.get("snapshots", []):
        item = snapshot.get("items", {}).get(code, {})
        if item.get("source_name") != source_name:
            continue
        value = number(item.get(key), minimum=0.000001, maximum=300)
        if value is not None:
            values.append(value)
            source_dates.add(str(item.get("source_date") or snapshot.get("date") or ""))
    return values, source_dates


def build_item(code: str, config: dict[str, Any], history: dict[str, Any]) -> dict[str, Any]:
    source = config["primary_source"]
    payload = fetch_json(source["url"])
    current_pe = number(payload.get("priceToEarningsRatio"), minimum=0.000001, maximum=300)
    forward_pe = number(payload.get("forwardPriceToEarningsRatio"), minimum=0.000001, maximum=300)
    pb = number(payload.get("priceToBookRatio"), minimum=0.000001, maximum=100)
    roe = number(payload.get("returnOnEquity"), minimum=-100, maximum=500)
    source_date = parse_source_date(payload.get("effectiveDate"))
    if current_pe is None and forward_pe is None and pb is None:
        raise ValueError(f"{code} has no usable valuation metrics")
    earnings_growth = None
    peg = None
    if current_pe is not None and forward_pe is not None and forward_pe > 0:
        earnings_growth = max(-100.0, min(500.0, (current_pe / forward_pe - 1) * 100))
        if earnings_growth > 0:
            peg = min(20.0, current_pe / earnings_growth)
    pe_history, pe_dates = history_values(history, code, "current_pe", source["name"])
    forward_history, forward_dates = history_values(history, code, "forward_pe", source["name"])
    if current_pe is not None and source_date not in pe_dates:
        pe_history.append(current_pe)
    if forward_pe is not None and source_date not in forward_dates:
        forward_history.append(forward_pe)
    sample_count = len(pe_history)
    pe_percentile = percentile(pe_history, current_pe) if current_pe is not None and sample_count >= 30 else None
    forward_percentile = percentile(forward_history, forward_pe) if forward_pe is not None and len(forward_history) >= 30 else None
    if sample_count >= 250:
        history_status = "formal_one_year"
    elif sample_count >= 90:
        history_status = "short_term_sample_limited"
    elif sample_count >= 30:
        history_status = "short_term_building"
    else:
        history_status = "building"
    item = {
        "benchmark": config["benchmark"],
        "primary_proxy": config["primary_proxy"],
        "secondary_proxy": config["secondary_proxy"],
        "current_pe": current_pe,
        "forward_pe": forward_pe,
        "pb": pb,
        "earnings_growth": round(earnings_growth, 4) if earnings_growth is not None else None,
        "earnings_growth_method": "implied from same-source trailing and forward P/E" if earnings_growth is not None else "",
        "return_on_equity": roe,
        "peg": round(peg, 4) if peg is not None else None,
        "valuation_score": None,
        "valuation_coverage": 0,
        "pe_percentile": pe_percentile,
        "forward_pe_percentile": forward_percentile,
        "history_sample_count": sample_count,
        "history_status": history_status,
        "source_name": source["name"],
        "source_url": source["url"],
        "source_date": source_date,
        "is_proxy": True,
        "proxy_level": "primary",
        "proxy_note": config["proxy_note"],
        "score_status": "provisional_current_metrics",
    }
    item["valuation_score"], item["valuation_coverage"] = valuation_score(item)
    return item


def compact_history(history: dict[str, Any], now_date: date) -> dict[str, Any]:
    snapshots = sorted(history.get("snapshots", []), key=lambda item: item.get("date", ""))
    kept: list[dict[str, Any]] = []
    monthly_seen: set[str] = set()
    for snapshot in reversed(snapshots):
        try:
            snapshot_date = date.fromisoformat(str(snapshot.get("date", "")))
        except ValueError:
            continue
        age = (now_date - snapshot_date).days
        if age <= 366:
            kept.append(snapshot)
            continue
        month_key = snapshot_date.strftime("%Y-%m")
        if month_key not in monthly_seen:
            kept.append(snapshot)
            monthly_seen.add(month_key)
    kept.sort(key=lambda item: item["date"])
    return {"version": 1, "updated_at": history.get("updated_at", ""), "snapshots": kept}


def main() -> None:
    config_payload = read_json(MAP_PATH)
    existing = read_json(OUTPUT_PATH)
    history = compact_history(read_json(HISTORY_PATH), date.today())
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    items: dict[str, Any] = {}
    statuses: dict[str, str] = {}
    for code, config in config_payload.get("items", {}).items():
        try:
            items[code] = build_item(code, config, history)
            statuses[code] = "ok"
        except Exception as exc:  # noqa: BLE001
            previous = existing.get("items", {}).get(code)
            if not isinstance(previous, dict):
                raise RuntimeError(f"{code} valuation update failed without cache: {exc}") from exc
            items[code] = previous
            statuses[code] = f"cached_after_error: {str(exc)[:120]}"
    successful_items = {code: item for code, item in items.items() if statuses.get(code) == "ok"}
    payload = {
        "version": 1,
        "updated_at": now if successful_items else existing.get("updated_at", ""),
        "items": items,
        "source_status": statuses,
    }
    if successful_items:
        source_dates = {item["source_date"] for item in successful_items.values()}
        snapshot_date = max(source_dates)
        snapshots = [item for item in history.get("snapshots", []) if item.get("date") != snapshot_date]
        snapshots.append(
            {
                "date": snapshot_date,
                "captured_at": now,
                "items": {
                    code: {
                        key: item.get(key)
                        for key in (
                            "current_pe",
                            "forward_pe",
                            "pb",
                            "earnings_growth",
                            "peg",
                            "source_name",
                            "source_date",
                            "primary_proxy",
                        )
                    }
                    for code, item in successful_items.items()
                },
            }
        )
        history = compact_history({"version": 1, "updated_at": now, "snapshots": snapshots}, date.today())
        history["updated_at"] = now
    write_atomic(OUTPUT_PATH, payload)
    write_atomic(HISTORY_PATH, history)
    print(f"Updated {len(items)} ETF valuation item(s); status={statuses}")


if __name__ == "__main__":
    main()
