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
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "cnn-fear-greed.json"
API_URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata"
SOURCE_URL = "https://www.cnn.com/markets/fear-and-greed"
MAX_SOURCE_AGE = dt.timedelta(days=10)
MAX_FETCH_ATTEMPTS = 5
FETCH_BACKOFF_SECONDS = (2, 4, 8, 16)
# NYSE core-session calendar: https://www.nyse.com/trade/hours-calendars
# Extend only after checking the published calendar; never infer unknown years.
NYSE_HOLIDAYS = {
    2026: "01-01 01-19 02-16 04-03 05-25 06-19 07-03 09-07 11-26 12-25",
    2027: "01-01 01-18 02-15 03-26 05-31 06-18 07-05 09-06 11-25 12-24",
    2028: "01-17 02-21 04-14 05-29 06-19 07-04 09-04 11-23 12-25",
}
NYSE_EARLY_CLOSES = {"2026-11-27", "2026-12-24", "2027-11-26", "2028-07-03", "2028-11-24"}
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


def closed_sessions(as_of: dt.datetime) -> list[dt.date]:
    local = as_of.astimezone(ZoneInfo("America/New_York"))
    day = local.date()
    sessions = []
    while len(sessions) < 11:
        if day.year not in NYSE_HOLIDAYS:
            raise ValueError("NYSE calendar coverage unavailable")
        early = day.isoformat() in NYSE_EARLY_CLOSES
        if (day.weekday() < 5 and day.isoformat()[5:] not in NYSE_HOLIDAYS[day.year].split()
                and (day < local.date() or local.time() >= dt.time(13 if early else 16))):
            sessions.append(day)
        day -= dt.timedelta(days=1)
    return list(reversed(sessions))


def build_history(data: dict, as_of: dt.datetime) -> dict:
    history = data.get("fear_and_greed_historical")
    points = history.get("data") if isinstance(history, dict) else None
    if not isinstance(points, list):
        raise ValueError("CNN daily history unavailable")
    dates = closed_sessions(as_of)
    # CNN daily keys are UTC midnight *date labels*, not US session instants.
    # Non-midnight samples are not daily closes.
    keys = {int(dt.datetime.combine(day, dt.time(), dt.timezone.utc).timestamp()) * 1000: day for day in dates}
    scores = {}
    for point in points:
        if not isinstance(point, dict):
            continue
        key = point.get("x")
        if type(key) not in (float, int) or key not in keys:
            continue
        day = keys[key]
        if day in scores:
            raise ValueError(f"duplicate CNN daily point: {day}")
        scores[day] = validated_score(point.get("y"), f"history.{day}")
    if len(scores) != len(dates):
        raise ValueError("CNN daily points missing: " + ",".join(str(day) for day in dates if day not in scores))
    return {
        "schema": "HS_CNN_CLOSED_SESSIONS_V1",
        "sessions": [{"date": day.isoformat(), "score": scores[day]} for day in dates],
    }


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
    try:
        payload["history"] = build_history(data, min(now, source_time))
    except (ValueError, ZoneInfoNotFoundError) as exc:
        # Optional history must never prevent publication of the existing gauge.
        print(f"CNN_HISTORY_UNAVAILABLE {exc}")
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
