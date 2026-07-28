#!/usr/bin/env python3
"""Fetch CNN Fear & Greed structured data and write a validated local JSON file."""
from __future__ import annotations

import datetime as dt
import json
import math
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "cnn-fear-greed.json"
API_URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata"
SOURCE_URL = "https://www.cnn.com/markets/fear-and-greed"
MAX_SOURCE_AGE = dt.timedelta(days=10)
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Referer": SOURCE_URL,
    "Origin": "https://www.cnn.com",
}


def validated_score(value: object, field: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{field} is not a number")
    try:
        score = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} is not a number") from exc
    if not math.isfinite(score) or not 0 <= score <= 100:
        raise ValueError(f"{field} is outside 0-100")
    return round(score, 1)


def parse_timestamp(value: object) -> dt.datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("CNN timestamp is missing")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("CNN timestamp is invalid") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def sentiment_label(score: float) -> str:
    if score <= 24:
        return "極度恐懼"
    if score <= 44:
        return "恐懼"
    if score <= 55:
        return "中性"
    if score <= 74:
        return "貪婪"
    return "極度貪婪"


def build_payload(data: object, now: dt.datetime | None = None) -> dict:
    if not isinstance(data, dict):
        raise ValueError("CNN response is not an object")
    current = data.get("fear_and_greed")
    if not isinstance(current, dict):
        raise ValueError("CNN fear_and_greed object is missing")

    now = (now or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone.utc)
    source_time = parse_timestamp(current.get("timestamp"))
    if source_time > now + dt.timedelta(hours=6):
        raise ValueError("CNN timestamp is unexpectedly in the future")
    if now - source_time > MAX_SOURCE_AGE:
        raise ValueError("CNN data is too old")

    score = validated_score(current.get("score"), "score")
    previous = {
        "day": validated_score(current.get("previous_close"), "previous.day"),
        "week": validated_score(current.get("previous_1_week"), "previous.week"),
        "month": validated_score(current.get("previous_1_month"), "previous.month"),
    }
    payload = {
        "updated_at": now.isoformat(timespec="seconds"),
        "source_updated_at": source_time.isoformat(timespec="seconds"),
        "source": "CNN Fear & Greed Index",
        "source_url": SOURCE_URL,
        "score": score,
        "sentiment": sentiment_label(score),
        "previous": previous,
    }
    # Validate the serialized payload too, so only plain JSON-safe values are written.
    json.dumps(payload, ensure_ascii=False, allow_nan=False)
    return payload


def fetch_data() -> dict:
    request = urllib.request.Request(API_URL, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status != 200:
            raise RuntimeError(f"CNN API returned HTTP {response.status}")
        return json.loads(response.read().decode("utf-8"))


def main() -> None:
    payload = build_payload(fetch_data())
    OUT.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote CNN Fear & Greed score {payload['score']} to {OUT}")


if __name__ == "__main__":
    main()
