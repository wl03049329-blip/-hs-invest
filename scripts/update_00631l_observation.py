"""Description-only 00631L closes, derived from the pinned historical source."""
import datetime as dt
import json
import math
import os
import re
from decimal import Decimal
from pathlib import Path
from urllib.request import urlopen, Request
from scripts.lc4_research_daily import (
    ROOT, TZ, encoded, load_history, read, require, sha,
)
from scripts.collect_radar_twse import digest

SYMBOL = "00631L"
FILE = "data/00631l-close-observation-v1.json"
SCHEMA = "HS_00631L_CLOSE_OBSERVATION_V1"
THRESHOLD_VERSION = "P80_P95_CLOSE_FIXED_20201231_V1"
TRAIN = "2020-12-31"
PERIODS = (20, 60, 120, 240, "all")
FROZEN_THRESHOLDS = {
    "speed": [2.2185014650481394, 6.714628297362113, 1508],
    "20": [6.6833056017748245, 13.198992443324942, 1494],
    "60": [11.023851076207103, 23.181707613719293, 1454],
    "120": [15.859564164648921, 26.069410815173534, 1394],
    "240": [18.886198547215493, 27.72397094430994, 1274],
    "all": [19.854941069809605, 28.934624697336574, 1274],
}
OPENAPI = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"
LICENSE = "https://data.gov.tw/license"
DATASET = "https://data.gov.tw/dataset/11549"


def thresholds(rows):
    samples = {k: [] for k in ("speed", *map(str, PERIODS))}
    historical_high = 0
    for i, row in enumerate(rows):
        historical_high = max(historical_high, row[1])
        if i >= 5:
            samples["speed"].append(max(0, 100 * (1 - row[1] / rows[i-5][1])))
        for days in PERIODS:
            if i + 1 >= (240 if days == "all" else days):
                high = historical_high if days == "all" else max(x[1] for x in rows[i-days+1:i+1])
                samples[str(days)].append(max(0, 100 * (1 - row[1] / high)))
    def pair(values):
        values = sorted(values)
        n = len(values)
        require(n >= 240, "TRAINING_SAMPLE_SHORT")
        return [values[(80*n+99)//100-1], values[(95*n+99)//100-1], n]
    return {k: pair(v) for k, v in samples.items()}


def compact_bar(values, close):
    require(len(values) == 5 and all(type(v) in (str, int) and
            re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", str(v)) for v in values), "INVALID_OHLCV")
    o, h, l, c, volume = map(lambda x: Decimal(str(x)), values)
    require(0 < l <= min(o,c) <= max(o,c) <= h and volume > 0 and
            volume == volume.to_integral_value() and c == Decimal(str(close)), "OHLCV_OR_HS_CLOSE_CONFLICT")
    return [float(o), float(h), float(l), float(c), int(volume)]


def verify_archive(raw, day, close, pinned_sha):
    require(sha(raw) == pinned_sha, "ARCHIVE_FILE_HASH")
    a = json.loads(raw)
    require(a.get("schema") == 1 and a.get("kind") == "price_twse" and a.get("trade_date") == day
            and a.get("source") == "twse_openapi_stock_day_all" and a.get("license") == "open"
            and a.get("license_url") == LICENSE and a.get("revision") == 1 and
            a.get("previous_checksum") is None, "ARCHIVE_DATE_SOURCE_OR_LICENSE")
    require(sha(json.dumps({k:a[k] for k in ("rows","source","license")}, sort_keys=True,
                            separators=(",", ":")).encode()) == a["checksum"], "ARCHIVE_DATA_CHECKSUM")
    fields = a["fields"]
    require(len(fields) == len(set(fields)) == 5, "ARCHIVE_FIELD_SCHEMA")
    row = dict(zip(fields, a["rows"][SYMBOL], strict=True))
    return compact_bar([row[k] for k in ("open", "high", "low", "close", "volume_shares")], close)


def checked_payload(doc, role):
    body = {k:v for k,v in doc.items() if k != "content_sha256"}
    require(digest(body) == doc.get("content_sha256"), role + "_HASH")
    return doc


def parse_openapi(raw, day, close, prior_close):
    rows = json.loads(raw)
    roc = str(int(day[:4])-1911) + day[5:].replace("-", "")
    require(isinstance(rows,list) and rows and all(r.get("Date") == roc for r in rows), "OPENAPI_SESSION_DATE_MISMATCH")
    hits = [r for r in rows if r.get("Code") == SYMBOL]
    require(len(hits) == 1, "OPENAPI_SYMBOL_NOT_UNIQUE")
    r = hits[0]
    value = r.get("ClosingPrice")
    require(isinstance(value,str) and re.fullmatch(r"[0-9]+(?:\.[0-9]+)?",value) and
            Decimal(value) > 0 and Decimal(value) == Decimal(str(close)), "INVALID_OR_CONFLICTING_CLOSE")
    # Reject any flagged/reset comparison basis and any unexplained carry-over.
    # This is an ordinary-session check, not authorization to adjust a new split.
    change = r.get("Change")
    require(isinstance(change,str) and re.fullmatch(r"[+-]?[0-9]+(?:\.[0-9]+)?",change) and
            Decimal(r["ClosingPrice"]) - Decimal(change) == Decimal(str(prior_close)),
            "REFERENCE_RESET_OR_ACTION_REQUIRES_REVIEW")
    return float(value)


def build(root, fetch, now):
    root = Path(root)
    pointer = read(root / "data/lc4-research/latest.json")
    history = load_history(root)
    anchor = history["asof"]
    rows = [[r["date"], r["close"]] for r in history["histories"][SYMBOL]]
    status = checked_payload(read(root / "data/radar-history/status-v1.json"), "SESSION_STATUS")
    target = status["expected_completed_bar"]
    filename = root / FILE
    require(filename.exists(), "AUTHORIZED_CONTINUOUS_BACKFILL_REQUIRED")
    old = read(filename)
    require(old.get("schema") == SCHEMA and old.get("threshold_version") == THRESHOLD_VERSION and
            old.get("training_end") == TRAIN and old.get("history_sha256") == pointer["sha256"] and
            old.get("open_data_seed_verified") is True and old["rows"][:len(rows)] == rows and
            old["rows"][-1][0] == old["asof"] and
            all(len(r) == 2 and type(r[1]) in (int,float) and math.isfinite(r[1]) and r[1] > 0
                for r in old["rows"]) and
            [r[0] for r in old["rows"]] == sorted({r[0] for r in old["rows"]}),
            "AUTHORIZED_CONTINUOUS_BACKFILL_REQUIRED")
    limits = thresholds([r for r in rows if r[0] <= TRAIN])
    require(old["thresholds"] == limits == FROZEN_THRESHOLDS, "THRESHOLD_CHANGED")
    require(target >= old["asof"] >= anchor, "ROLLBACK_REJECTED")
    if target == old["asof"]:
        return None
    require(now >= dt.datetime.combine(dt.date.fromisoformat(target),dt.time(18),TZ), "SESSION_NOT_COMPLETED")
    calendar = checked_payload(read(root / "data/radar-history/twse/0050.json"), "SESSION_CALENDAR")
    inc = calendar["incremental_verification"]
    sessions = inc["sessions"]
    # The official radar archive rolls its verified calendar window forward.
    # Require a verified overlap, then check every date in the overlapping range.
    start = max(anchor, inc["start"])
    require(calendar.get("verified") is True and
            calendar["content_sha256"] == status["symbols"]["0050"]["archive_sha256"] and
            inc.get("calendar_evidence") and inc["end"] == target and start <= old["asof"] and
            old["asof"] in sessions and sessions == sorted(set(sessions)) and
            [d for d in sessions if start <= d <= target] ==
            [r[0] for r in old["rows"] if r[0] >= start] + [target], "GAP_OR_UNVERIFIED_CALENDAR")
    q = read(root / "market-quotes.json")
    hits = [r for r in q["items"] if r.get("code") == SYMBOL and r.get("market") == "TWSE" and
            r.get("quote_mode") == "close" and r.get("date") == target]
    require(len(hits) == 1 and q["official_source_dates"]["TWSE"] == q["source_dates"]["TWSE"] == target and
            q["sources"]["TWSE_close"] in (OPENAPI,"https://www.twse.com.tw/exchangeReport/MI_INDEX") and
            q["source_status"]["TWSE"] in ("official_closing_data_daily_report","official_closing_data"), "HS_CLOSE_UNCONFIRMED")
    raw = fetch()
    close = parse_openapi(raw,target,hits[0]["price"],old["rows"][-1][1])
    return {**old, "asof": target, "rows": old["rows"]+[[target,close]],
            "verified_at": now.isoformat(), "source": "臺灣證券交易所 OpenAPI（政府開放資料集 11549）",
            "evidence": old["evidence"]+[{"url":OPENAPI,"sha256":sha(raw),"date":target,"license":LICENSE,"dataset":DATASET}]}


def fetch_openapi():
    with urlopen(Request(OPENAPI,headers={"Accept":"application/json"}),timeout=30) as response:
        require(response.status == 200 and response.geturl() == OPENAPI, "OPENAPI_HTTP_OR_REDIRECT")
        raw = response.read(4_000_001)
    require(len(raw) <= 4_000_000, "OPENAPI_BODY_TOO_LARGE")
    return raw


if __name__ == "__main__":
    require(os.environ.get("HS_00631L_OPENAPI_CONTINUITY_APPROVED") == "1", "CONTINUITY_GATE_NOT_CONFIGURED")
    artifact = build(ROOT, fetch_openapi, dt.datetime.now(TZ))
    if artifact is not None:
        tmp = ROOT / (FILE + ".tmp")
        tmp.write_bytes(encoded(artifact))
        tmp.replace(ROOT / FILE)
        print("00631L verified:", artifact["asof"], "sha256:", sha(encoded(artifact)))
