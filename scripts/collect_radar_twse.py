"""Bounded, resumable PUBLIC raw-OHLC collection for the radar chart only.

No FinMind calls, adjusted prices, scores, ledgers, credentials or publication.
Evidence is separate from immutable FinMind source files. Any conflict aborts
promotion; downloaded responses remain available for inspection, never spliced.
"""
import argparse
import calendar
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
import re
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data/radar-history/twse"
FIELDS = ["日期", "成交股數", "成交金額", "開盤價", "最高價", "最低價", "收盤價", "漲跌價差", "成交筆數", "註記"]
PRICE_KEYS = ("open", "max", "min", "close")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def roc(value):
    parts = re.fullmatch(r"(\d{3})[年/](\d{2})[月/](\d{2})日?", value)
    if not parts:
        raise ValueError("DATE_FORMAT")
    y, m, d = map(int, parts.groups())
    return dt.date(y + 1911, m, d).isoformat()


def number(value, integer=False):
    if not isinstance(value, str) or not re.fullmatch(r"[\d,]+(?:\.\d+)?", value):
        raise ValueError("NUMBER_MISSING_OR_INVALID")
    n = float(value.replace(",", ""))
    if not math.isfinite(n) or n <= 0 or (integer and not n.is_integer()):
        raise ValueError("NUMBER_RANGE")
    return int(n) if n.is_integer() else n


def parse_month(payload, symbol, month, cutoff):
    if payload.get("stat") != "OK" or payload.get("date") != month + "01" or payload.get("fields") != FIELDS:
        raise ValueError("MONTH_SCHEMA")
    if not re.search(r"\b" + re.escape(symbol) + r"\b", payload.get("title", "")):
        raise ValueError("SYMBOL_MISMATCH")
    rows, seen = [], set()
    if not isinstance(payload.get("data"), list) or payload.get("total") != len(payload["data"]):
        raise ValueError("MONTH_COUNT")
    for raw in payload["data"]:
        if len(raw) != len(FIELDS):
            raise ValueError("ROW_SCHEMA")
        date = roc(raw[0])
        if date.replace("-", "")[:6] != month or date in seen:
            raise ValueError("DATE_COVERAGE")
        seen.add(date)
        if date > cutoff:
            continue
        # No repair of suspended/invalid bars; caller retains the previous file.
        row = dict(date=date, stock_id=symbol, open=number(raw[3]), max=number(raw[4]), min=number(raw[5]), close=number(raw[6]), Trading_Volume=number(raw[1], True))
        if not row["min"] <= min(row["open"], row["close"]) <= max(row["open"], row["close"]) <= row["max"]:
            raise ValueError("OHLC_BOUNDS:" + date)
        if "**" in raw[9]:
            raise ValueError("UNREVIEWED_SPLIT:" + date)
        rows.append(row)
    if not rows:
        raise ValueError("EMPTY_MONTH")
    return sorted(rows, key=lambda r: r["date"])


def overlap(seed, rows):
    prior = {r["date"]: r for r in seed["price"]}
    common = [r for r in rows if r["date"] in prior]
    if not common or seed["price"][-1]["date"] not in {r["date"] for r in common}:
        raise ValueError("OVERLAP_ANCHOR_MISSING")
    differences = []
    for row in common:
        old = prior[row["date"]]
        for key in PRICE_KEYS:
            if abs(old[key] - row[key]) > 1e-8:
                raise ValueError("PRICE_CONFLICT:" + row["date"] + ":" + key)
        if old["Trading_Volume"] != row["Trading_Volume"]:
            differences.append(dict(date=row["date"], finmind_volume=old["Trading_Volume"], twse_volume=row["Trading_Volume"]))
    return dict(count=len(common), price_tolerance="0.00000001", volume_differences=differences, policy="Original FinMind rows retained; TWSE volume applies only to new dates")


def months(start, end):
    y, m = map(int, start[:7].split("-"))
    while f"{y:04}-{m:02}" <= end[:7]:
        yield f"{y:04}{m:02}"
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def evidence(key, url, offline):
    path = DATA / "evidence" / (key + ".json")
    if path.exists():
        entry = json.loads(path.read_text(encoding="utf-8"))
        if entry["url"] != url or digest(entry["payload"]) != entry["sha256"]:
            raise ValueError("EVIDENCE_HASH:" + key)
        return entry
    if offline:
        raise ValueError("EVIDENCE_MISSING:" + key)
    # One request per resource, no retries, no quota circumvention.
    time.sleep(3)
    with urlopen(url, timeout=30) as response:
        payload = json.loads(response.read())
    entry = dict(url=url, fetched_at=dt.datetime.now(dt.timezone.utc).isoformat(), payload=payload, sha256=digest(payload))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(entry, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return entry


def month_evidence(symbol, month, cutoff, offline):
    url = f"https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date={month}01&stockNo={symbol}"
    key = f"{symbol}-{month}-{cutoff}"
    # A later as-of date must not redownload already completed historic months.
    # Only reuse evidence acquired after month-end with a covering cutoff.
    year, mon = int(month[:4]), int(month[4:])
    last = dt.date(year, mon, calendar.monthrange(year, mon)[1]).isoformat()
    if last < cutoff:
        for path in sorted((DATA / "evidence").glob(f"{symbol}-{month}-*.json"), reverse=True):
            prior_cutoff = path.stem[-10:]
            if not last <= prior_cutoff <= cutoff:
                continue
            entry = evidence(path.stem, url, True)
            acquired = dt.datetime.fromisoformat(entry["fetched_at"]).astimezone(dt.timezone(dt.timedelta(hours=8))).date().isoformat()
            if acquired > last:
                parse_month(entry["payload"], symbol, month, cutoff)
                return path.stem, entry
    return key, evidence(key, url, offline)


def collect(symbol, cutoff, offline=False):
    seed_path = ROOT / f"research/c4_historical/source/{symbol}.json"
    seed = json.loads(seed_path.read_text(encoding="utf-8")) if seed_path.exists() else None
    if seed:
        meta = json.loads((ROOT / f"research/c4_historical/{symbol}.json").read_text(encoding="utf-8"))
        if digest(seed) != meta["metadata"]["provenance"]["source_ohlc_sha256"]:
            raise ValueError("SAVED_PROVENANCE")
        start = seed["price"][-1]["date"][:7] + "-01"
    elif symbol == "00757":
        start = "2018-12-01"  # TWSE publication 0002000167: listed 2018-12-06.
    else:
        raise ValueError("LISTING_START_NOT_VERIFIED")
    refs, rows = [], []
    for month in months(start, cutoff):
        key, e = month_evidence(symbol, month, cutoff, offline)
        rows.extend(parse_month(e["payload"], symbol, month, cutoff))
        refs.append(dict(file="evidence/" + key + ".json", sha256=e["sha256"], fetched_at=e["fetched_at"], url=e["url"]))
        print(symbol, month, len(rows), flush=True)
    checked = overlap(seed, rows) if seed else dict(count=0, policy="TWSE primary source from listing; no provider splice")
    # Explicit returned date bounds prevent a latest-only endpoint masquerading as history.
    events, action_refs = [], []
    for year in range(int(start[:4]), int(cutoff[:4]) + 1):
        lo, hi = max(start, f"{year}-01-01"), min(cutoff, f"{year}-12-31")
        compact = lambda s: s.replace("-", "")
        key = f"actions-{compact(lo)}-{compact(hi)}"
        e = evidence(key, f"https://www.twse.com.tw/exchangeReport/TWT49U?response=json&startDate={compact(lo)}&endDate={compact(hi)}", offline)
        p = e["payload"]
        if p.get("stat") != "OK" or p.get("strDate") != compact(lo) or p.get("endDate") != compact(hi) or p.get("fields", [])[:7] != ["資料日期", "股票代號", "股票名稱", "除權息前收盤價", "除權息參考價", "權值+息值", "權/息"]:
            raise ValueError("ACTION_COVERAGE")
        for r in p["data"]:
            date = roc(r[0])
            if not lo <= date <= hi:
                raise ValueError("ACTION_DATE")
            if r[1] == symbol:
                if r[6] != "息":
                    raise ValueError("UNREVIEWED_ACTION:" + date)
                events.append(dict(date=date, amount=number(r[5]), source="TWSE/TWT49U"))
        action_refs.append(dict(file="evidence/" + key + ".json", sha256=e["sha256"], url=e["url"]))
    if seed:
        old_events = {r["date"]: r for r in seed["dividend"] if start <= r["date"] <= seed["requested_end"] and r.get("stock_or_cache_dividend") == "息"}
        new_events = {r["date"]: r for r in events if r["date"] <= seed["requested_end"]}
        if old_events.keys() != new_events.keys() or any(abs(r["stock_and_cache_dividend"] - new_events[d]["amount"]) > 1e-6 for d, r in old_events.items()):
            raise ValueError("DIVIDEND_OVERLAP_CONFLICT")
    selected = [r for r in rows if not seed or r["date"] > seed["price"][-1]["date"]]
    # Cross-check observed exchange dates from other provenance-verified saved ETFs.
    observed = set()
    for path in (ROOT / "research/c4_historical/source").glob("*.json"):
        if path.stem not in ("0050", "00662", "00830", "00935", "009815"):
            continue
        peer = json.loads(path.read_text(encoding="utf-8"))
        meta = json.loads((path.parent.parent / path.name).read_text(encoding="utf-8"))
        if digest(peer) != meta["metadata"]["provenance"]["source_ohlc_sha256"]:
            raise ValueError("PEER_PROVENANCE")
        observed.update(r["date"] for r in peer["price"])
    missing = sorted(d for d in observed if rows[0]["date"] <= d <= rows[-1]["date"] and d not in {r["date"] for r in rows})
    if missing:
        raise ValueError("OBSERVED_SESSION_GAP:" + ",".join(missing))
    result = dict(schema_version=1, symbol=symbol, provider="TWSE/STOCK_DAY", price_type="RAW_UNADJUSTED", currency="TWD", price_unit="TWD_PER_UNIT", volume_unit="SHARES", verified=True, requested_start=start, requested_end=cutoff, fetched_at=max(r["fetched_at"] for r in refs), base_source_sha256=digest(seed) if seed else None, base_last_date=seed["price"][-1]["date"] if seed else None, overlap=checked, price=selected, dividends=events, action_coverage=dict(start=start,end=cutoff), evidence=refs, action_evidence=action_refs, missing_observed_sessions=missing, calendar_completeness="OBSERVED_ONLY_NOT_OFFICIAL_CALENDAR", listing_reference="https://www.twse.com.tw/staticFiles/product/publication/0002000167.pdf" if not seed else None)
    result["content_sha256"] = digest(result)
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / f"{symbol}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("VERIFIED", symbol, len(selected), rows[0]["date"], rows[-1]["date"], flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbols", nargs="+", required=True)
    parser.add_argument("--as-of", required=True)
    parser.add_argument("--offline", action="store_true")
    args = parser.parse_args()
    today = dt.datetime.now(dt.timezone(dt.timedelta(hours=8)))
    limit = today.date() if today.hour >= 18 else today.date() - dt.timedelta(days=1)
    if dt.date.fromisoformat(args.as_of) > limit:
        raise SystemExit("UNCOMPLETED_DAY")
    for sym in args.symbols:
        collect(sym, args.as_of, args.offline)
