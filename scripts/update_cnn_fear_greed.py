#!/usr/bin/env python3
"""Fetch CNN Fear & Greed structured data and write a validated local JSON file."""
from __future__ import annotations

import datetime as dt
import json
import math
import os
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "cnn-fear-greed.json"
API_URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata"
SOURCE_URL = "https://www.cnn.com/markets/fear-and-greed"
MAX_SOURCE_AGE = dt.timedelta(days=10)
MAX_FETCH_ATTEMPTS = 5
FETCH_BACKOFF_SECONDS = (2, 4, 8, 16)
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
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


def is_transient_fetch_error(exc: BaseException) -> bool:
    if isinstance(exc, urllib.error.HTTPError):
        return exc.code == 429 or 500 <= exc.code <= 599
    return isinstance(exc, (urllib.error.URLError, ConnectionResetError, TimeoutError))


def fetch_data(*, urlopen=None, sleeper=None) -> dict:
    urlopen = urlopen or urllib.request.urlopen
    sleeper = sleeper or time.sleep
    request = urllib.request.Request(API_URL, headers=HEADERS)

    for attempt in range(1, MAX_FETCH_ATTEMPTS + 1):
        try:
            with urlopen(request, timeout=30) as response:
                status = getattr(response, "status", None)
                if status is None:
                    status = response.getcode()
                if status != 200:
                    raise urllib.error.HTTPError(
                        API_URL, status, f"CNN API returned HTTP {status}", response.headers, None
                    )
                return json.loads(response.read().decode("utf-8"))
        except Exception as exc:
            if not is_transient_fetch_error(exc) or attempt == MAX_FETCH_ATTEMPTS:
                raise
            delay = FETCH_BACKOFF_SECONDS[attempt - 1]
            print(
                f"CNN_FETCH_RETRY attempt={attempt}/{MAX_FETCH_ATTEMPTS} "
                f"backoff={delay}s error={type(exc).__name__}: {exc}"
            )
            sleeper(delay)

    raise RuntimeError("CNN fetch retry loop ended unexpectedly")


def validate_existing_payload(data: object) -> dict:
    if not isinstance(data, dict):
        raise ValueError("existing CNN artifact is not an object")
    if data.get("source") != "CNN Fear & Greed Index":
        raise ValueError("existing CNN artifact source is invalid")
    if data.get("source_url") != SOURCE_URL:
        raise ValueError("existing CNN artifact source URL is invalid")
    parse_timestamp(data.get("updated_at"))
    parse_timestamp(data.get("source_updated_at"))
    score = validated_score(data.get("score"), "existing.score")
    previous = data.get("previous")
    if not isinstance(previous, dict):
        raise ValueError("existing CNN artifact previous values are missing")
    validated_score(previous.get("day"), "existing.previous.day")
    validated_score(previous.get("week"), "existing.previous.week")
    validated_score(previous.get("month"), "existing.previous.month")
    if data.get("sentiment") != sentiment_label(score):
        raise ValueError("existing CNN artifact sentiment is inconsistent")
    json.dumps(data, ensure_ascii=False, allow_nan=False)
    return data


def load_last_valid_data(out_path: Path) -> dict | None:
    if not out_path.is_file():
        return None
    try:
        return validate_existing_payload(json.loads(out_path.read_text(encoding="utf-8")))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"LAST_VALID_DATA_INVALID error={type(exc).__name__}: {exc}")
        return None


def write_payload_atomic(out_path: Path, payload: dict) -> None:
    serialized = json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=out_path.parent,
            prefix=f".{out_path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary.write(serialized)
            temporary.flush()
            os.fsync(temporary.fileno())
            temporary_path = Path(temporary.name)
        temporary_path.replace(out_path)
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()


def main(*, out_path: Path = OUT, fetcher=None) -> int:
    fetcher = fetcher or fetch_data
    try:
        payload = build_payload(fetcher())
    except Exception as exc:
        print(f"CNN_FETCH_FAILED error={type(exc).__name__}: {exc}")
        if load_last_valid_data(out_path) is not None:
            print(f"USING_LAST_VALID_DATA path={out_path}")
            return 0
        print(f"NO_LAST_VALID_DATA path={out_path}")
        return 1

    write_payload_atomic(out_path, payload)
    print(f"Wrote CNN Fear & Greed score {payload['score']} to {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
