"""Read-only audit of independently dated prices and corporate-action coverage.

This is not a publication job. It does not write market or portfolio data,
touch FINAL, or treat website access as permission for unattended reuse.
"""
from __future__ import annotations

import argparse
import datetime as dt
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path
import re
from urllib.request import Request, urlopen

from scripts.update_radar_daily import TZ, expected_day, next_trading_session, official_sessions
from scripts.collect_radar_twse import digest, roc


TWSE = "https://www.twse.com.tw"
TPEX = "https://www.tpex.org.tw"
ID = re.compile(r"[0-9A-Z]{4,10}")
MARKETS = {
    "TWSE": {"venue": "twse", "code": "證券代號", "close": "收盤價"},
    "TPEx": {"venue": "tpex", "code": "代號", "close": "收盤"},
}
TWSE_ACTIONS = (
    ("/exchangeReport/TWT49U", "strDate", "資料日期", "股票代號"),
    ("/rwd/zh/split/TWTCAU", "startDate", "恢復買賣日期", "ETF代號"),
    ("/exchangeReport/TWTAUU", "strDate", "恢復買賣日期", "股票代號"),
)
TPEX_ACTIONS = (
    ("exDailyQ", "除權息日期", "代號"),
    ("etfSplitRslt", "恢復買賣日期", "證券代號"),
    ("etfRvsRslt", "恢復買賣日期", "證券代號"),
    ("revivt", "恢復買賣日期", "股票代號"),
    ("pvChgRslt", "恢復買賣日期", "證券代號"),
)


class ReadOnlyClient:
    def __init__(self):
        self.entries = {}

    def get(self, url):
        if url not in self.entries:
            if len(self.entries) >= 24:
                raise ValueError("REQUEST_LIMIT")
            with urlopen(Request(url, headers={"Accept": "application/json"}), timeout=15) as response:
                if response.status != 200 or response.geturl() != url:
                    raise ValueError("UNEXPECTED_OFFICIAL_RESPONSE")
                body = response.read(20_000_001)
            if len(body) > 20_000_000:
                raise ValueError("BODY_LIMIT")
            payload = json.loads(body.decode("utf-8-sig"))
            self.entries[url] = dict(url=url, payload=payload, sha256=digest(payload),
                                     fetched_at=dt.datetime.now(dt.timezone.utc).isoformat())
        return self.entries[url]


def date_query(day):
    return day.replace("-", "%2F")


def same_reported_price(value, expected):
    try:
        return type(value) in (int, float) and Decimal(str(value)) == expected
    except InvalidOperation:
        return False


def columns(table, *names, count_required=False):
    fields, rows = table.get("fields"), table.get("data")
    if (not isinstance(fields, list) or not isinstance(rows, list)
            or any(fields.count(name) != 1 for name in names)
            or any(not isinstance(row, list) or len(row) != len(fields) for row in rows)
            or count_required and table.get("totalCount") != len(rows)):
        raise ValueError("OFFICIAL_REPORT_SCHEMA_OR_COUNT")
    indices = [fields.index(name) for name in names]
    return [tuple(row[i] for i in indices) for row in rows]


def traded_rows(payload, market, day):
    keys = (MARKETS[market]["code"], MARKETS[market]["close"], "成交股數")
    if payload.get("stat") != ("OK" if market == "TWSE" else "ok") or payload.get("date") != day.replace("-", ""):
        raise ValueError("OFFICIAL_CLOSE_WRONG_SESSION")
    tables = [p for p in payload.get("tables", []) if all(k in p.get("fields", []) for k in keys)]
    if not tables or market == "TWSE" and len(tables) != 1:
        raise ValueError("OFFICIAL_CLOSE_TABLE")
    rows, seen = {}, set()
    for table in tables:
        for code, price, volume in columns(table, *keys, count_required=market == "TPEx"):
            if not isinstance(code, str) or not ID.fullmatch(code):
                continue
            if code in seen:
                raise ValueError("DUPLICATE_OFFICIAL_INSTRUMENT")
            seen.add(code)
            try:
                price, volume = Decimal(price.replace(",", "")), Decimal(volume.replace(",", ""))
            except (AttributeError, InvalidOperation):
                continue  # dash/no trade is never a real close
            if price.is_finite() and volume.is_finite() and price > 0 and volume > 0 and volume == volume.to_integral():
                rows[code] = price
    return rows


def actions(client, market, start, end):
    lo, hi = start.replace("-", ""), end.replace("-", "")
    found, sources = {}, []
    reports = TWSE_ACTIONS if market == "TWSE" else TPEX_ACTIONS
    for report in reports:
        if market == "TWSE":
            path, start_key, date_key, code_key = report
            url = f"{TWSE}{path}?response=json&startDate={lo}&endDate={hi}"
            e = client.get(url)
            p = e["payload"]
            if p.get("stat") != "OK" or p.get(start_key) != lo or p.get("endDate") != hi:
                raise ValueError("ACTION_WINDOW_UNVERIFIED:" + path)
            rows = columns(p, date_key, code_key)
        else:
            path, date_key, code_key = report
            url = f"{TPEX}/www/zh-tw/bulletin/{path}?startDate={date_query(start)}&endDate={date_query(end)}&response=json"
            e = client.get(url)
            p = e["payload"]
            if p.get("stat") != "ok" or p.get("date") != f"{lo}~{hi}" or len(p.get("tables", [])) != 1:
                raise ValueError("ACTION_WINDOW_UNVERIFIED:" + path)
            rows = columns(p["tables"][0], date_key, code_key, count_required=True)
        for raw_date, code in rows:
            if not isinstance(code, str) or not ID.fullmatch(code) or not start <= roc(raw_date) <= end:
                raise ValueError("ACTION_ROW_UNVERIFIED:" + path)
            # All cash/rights/unit changes in the pair interval require a separate
            # verified action path. An audit never guesses the ratio/entitlement.
            if roc(raw_date) > start:
                found.setdefault(code, []).append(path)
        sources.append({"url": url, "sha256": e["sha256"], "rows": len(rows)})
    return found, sources


def gather_market(client, market, previous, target):
    days, calendar, closes, price_refs = [], [], [], []
    for month in sorted({previous[:7].replace("-", ""), target[:7].replace("-", "")}):
        sessions, ref = official_sessions(client, MARKETS[market]["venue"], month, target)
        days.extend(sessions)
        calendar.append(ref)
    if days[-2:] != [previous, target]:
        raise ValueError("CLOSE_PAIR_NOT_CONSECUTIVE")
    for d in (previous, target):
        if market == "TWSE":
            url = f"{TWSE}/exchangeReport/MI_INDEX?response=json&date={d.replace('-', '')}&type=ALLBUT0999"
        else:
            url = f"{TPEX}/www/zh-tw/afterTrading/dailyQuotes?date={date_query(d)}&response=json"
        e = client.get(url)
        closes.append(traded_rows(e["payload"], market, d))
        price_refs.append({"url": url, "sha256": e["sha256"]})
    events, event_refs = actions(client, market, previous, target)
    return closes, events, {"prices": price_refs, "calendar": calendar, "actions": event_refs}


def audit(client, cache, target, symbols):
    when = dt.datetime.combine(dt.date.fromisoformat(target), dt.time(18), TZ)
    actual, _, _ = expected_day(client, when)
    if actual != target:
        raise ValueError("REQUESTED_DATE_NOT_TRADING_SESSION")
    previous, _, _ = expected_day(client, when - dt.timedelta(days=1))
    next_day = next_trading_session(client, target)
    snapshot = cache.get("official_close_cache", cache)
    items = snapshot.get("items")
    if snapshot.get("version") != 2 or not isinstance(items, list) or any(not isinstance(r, dict) for r in items):
        raise ValueError("PORTFOLIO_CLOSE_CACHE_SCHEMA")
    by_symbol = {s: sum(r.get("code") == s for r in items) for s in symbols}
    output = dict(date=target, previous_date=previous, next_date=next_day, markets={}, rows={})
    for market in MARKETS:
        selected = [r for r in items if r.get("market") == market and r.get("code") in symbols]
        if not selected:
            continue
        try:
            (prior, current), events, refs = gather_market(client, market, previous, target)
            output["markets"][market] = refs
        except (ValueError, OSError, KeyError, TypeError, IndexError) as exc:
            for r in selected:
                output["rows"][r["code"]] = {"status": "UNKNOWN", "reason": str(exc)}
            continue
        for r in selected:
            s = r["code"]
            reason = None
            if by_symbol[s] != 1:
                reason = "DUPLICATE_PORTFOLIO_QUOTE"
            elif r.get("quote_mode") != "close" or r.get("date") != target or snapshot.get("source_dates", {}).get(market) != target or snapshot.get("official_source_dates", {}).get(market) != target or snapshot.get("source_status", {}).get(market) not in ("official_closing_data", "official_closing_data_daily_report"):
                reason = "PORTFOLIO_CLOSE_UNVERIFIED"
            elif s not in prior or s not in current:
                reason = "MISSING_ACTUAL_TRADE_CLOSE"
            elif events.get(s):
                reason = "ACTION_REVIEW_REQUIRED:" + ",".join(events[s])
            elif not same_reported_price(r.get("price"), current[s]) or not same_reported_price(r.get("previous_close"), prior[s]):
                reason = "PRICE_OR_COMPARISON_CONFLICT"
            output["rows"][s] = ({"status": "UNKNOWN", "reason": reason} if reason else {
                "status": "VERIFIED_FOR_READ_ONLY_AUDIT", "market": market,
                "previous_close": format(prior[s], "f"), "close": format(current[s], "f")})
    for s in symbols:
        output["rows"].setdefault(s, {"status": "UNKNOWN", "reason": "NO_UNIQUE_OFFICIAL_PORTFOLIO_QUOTE"})
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", required=True)
    parser.add_argument("--cache", type=Path, default=Path("market-quotes.json"))
    parser.add_argument("--symbol", action="append", required=True, help="Public exchange code only")
    args = parser.parse_args()
    if not all(ID.fullmatch(s) for s in args.symbol):
        parser.error("Invalid public instrument code")
    now = dt.datetime.now(TZ)
    if dt.datetime.combine(dt.date.fromisoformat(args.date), dt.time(18), TZ) > now:
        parser.error("Date has not passed the existing completed-session cutoff")
    result = audit(ReadOnlyClient(), json.loads(args.cache.read_text(encoding="utf-8")), args.date, set(args.symbol))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result["next_date"] and all(
        r["status"] == "VERIFIED_FOR_READ_ONLY_AUDIT" for r in result["rows"].values()) else 2)
