"""Incremental RAW daily candles only; no scores, holdings or Forward writes.

Existing FinMind sources and verified official rows are immutable. Official
monthly overlap + observed sessions + corporate actions must all validate before
an atomic per-symbol promotion. Evidence is private; public files retain hashes.
"""
from __future__ import annotations
import argparse
import copy
import datetime as dt
import json
import math
import os
from pathlib import Path
import subprocess
import time
from http.client import IncompleteRead, RemoteDisconnected
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from backend.trading_calendar import TradingCalendar
from scripts.fetch_official_eod_market import HOLIDAY_URL, iso_date
from scripts.collect_radar_twse import digest, months, parse_month, roc, number
from scripts.audit_radar_calendar import parse_market
from scripts.audit_radar_tpex import monthly, daily

ROOT = Path(__file__).resolve().parents[1]
SYMBOLS = ("0050", "00662", "00757", "00830", "00935", "009815")
FIELDS = ("open", "max", "min", "close", "Trading_Volume")
ACTIONS = ("exDailyQ", "etfSplitRslt", "etfRvsRslt", "revivt", "pvChgRslt")
TZ = dt.timezone(dt.timedelta(hours=8))
PUBLIC_STATUS = "data/radar-history/status-v1.json"

def log(event, **fields):
    print(json.dumps(dict(event=event, **fields), ensure_ascii=False), flush=True)

def path_for(root, symbol):
    return root / "data/radar-history" / ("tpex" if symbol == "009815" else "twse") / (symbol + ".json")

def atomic_json(path, payload):
    encoded = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode()
    if path.exists() and path.read_bytes() == encoded:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    try:
        with temporary.open("wb") as stream:
            stream.write(encoded); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists(): temporary.unlink()
    return True

class Client:
    """One complete response per URL/run; at most 3 transport attempts, paced.

    Partial bodies are discarded, never combined or cached. Semantic validation
    and quota errors are not retried; no alternate provider is introduced.
    """
    def __init__(self, evidence_dir, root=ROOT, delay=3, opener=urlopen):
        self.directory = Path(evidence_dir).resolve()
        root = Path(root).resolve()
        if self.directory == root or root in self.directory.parents:
            raise ValueError("EVIDENCE_MUST_BE_OUTSIDE_PUBLIC_CHECKOUT")
        self.directory.mkdir(parents=True, exist_ok=True)
        self.entries, self.delay, self.opener, self.requests = {}, delay, opener, 0
        # Evidence from this invocation can be supplied for a bounded offline run.
        # Never read a stale date's cache as fresh. CI uses a new RUNNER_TEMP dir.
        today = dt.datetime.now(TZ).date()
        for path in self.directory.glob("*.json"):
            e = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(e, dict) or not {"url", "payload", "sha256", "fetched_at"} <= e.keys(): continue
            if digest(e["payload"]) != e["sha256"]: raise ValueError("EVIDENCE_HASH")
            if dt.datetime.fromisoformat(e["fetched_at"]).astimezone(TZ).date() == today:
                self.entries[e["url"]] = e

    def get(self, url):
        if url in self.entries: return self.entries[url]
        for attempt in range(1, 4):
            if self.requests >= 120: raise ValueError("BOUNDED_REQUEST_BUDGET_EXCEEDED")
            self.requests += 1
            time.sleep(self.delay * attempt)
            try:
                with self.opener(Request(url, headers={"User-Agent": "HS-Radar-Official-Daily/1", "Accept": "application/json"}), timeout=30) as response:
                    if response.status != 200: raise ValueError("SOURCE_HTTP_" + str(response.status))
                    payload = json.loads(response.read().decode("utf-8-sig"))
                break
            except (IncompleteRead, RemoteDisconnected, TimeoutError, URLError, ConnectionError) as exc:
                if isinstance(exc, HTTPError) and exc.code not in (500, 502, 503, 504): raise
                log("SOURCE_TRANSPORT_FAILURE", url=url, attempt=attempt, maximum=3, reason=str(exc))
                if attempt == 3: raise
        e = dict(url=url, fetched_at=dt.datetime.now(dt.timezone.utc).isoformat(), payload=payload, sha256=digest(payload))
        atomic_json(self.directory / (digest(url) + ".json"), e)
        self.entries[url] = e
        log("SOURCE_FETCH", url=url, sha256=e["sha256"])
        return e

def ref(entry):
    return {key: entry[key] for key in ("url", "fetched_at", "sha256")}

def verify_archive(root, symbol):
    p = json.loads(path_for(root, symbol).read_text(encoding="utf-8"))
    content = {k: v for k, v in p.items() if k != "content_sha256"}
    provider = "TPEx/dailyQuotes" if symbol == "009815" else "TWSE/STOCK_DAY"
    if digest(content) != p.get("content_sha256") or p.get("schema_version") != 1 or p.get("verified") is not True or p.get("symbol") != symbol or p.get("provider") != provider or p.get("price_type") != "RAW_UNADJUSTED" or p.get("volume_unit") != "SHARES" or p.get("currency") != "TWD":
        raise ValueError("ARCHIVE_INTEGRITY")
    seed_path = root / "research/c4_historical/source" / (symbol + ".json")
    if seed_path.exists():
        seed = json.loads(seed_path.read_text(encoding="utf-8"))
        metadata = json.loads((seed_path.parent.parent / seed_path.name).read_text(encoding="utf-8"))
        if digest(seed) != metadata["metadata"]["provenance"]["source_ohlc_sha256"] or digest(seed) != p.get("base_source_sha256") or seed["price"][-1]["date"] != p.get("base_last_date"):
            raise ValueError("FINMIND_PROVENANCE")
    elif symbol != "00757" or p.get("base_source_sha256") is not None:
        raise ValueError("FINMIND_SOURCE_MISSING")
    previous = ""
    for r in p["price"]:
        dt.date.fromisoformat(r["date"])
        if r["date"] <= previous or r["date"] < p["requested_start"] or r["date"] > p["requested_end"] or r["stock_id"] != symbol or p.get("base_last_date") and r["date"] <= p["base_last_date"]:
            raise ValueError("ARCHIVE_DATE_OR_SYMBOL")
        if any(isinstance(r[k], bool) or not isinstance(r[k], (int, float)) or not math.isfinite(r[k]) or r[k] <= 0 for k in FIELDS) or int(r["Trading_Volume"]) != r["Trading_Volume"] or not r["min"] <= min(r["open"], r["close"]) <= max(r["open"], r["close"]) <= r["max"]:
            raise ValueError("ARCHIVE_OHLC")
        previous = r["date"]
    if not previous or previous != p["requested_end"] or p["action_coverage"] != dict(start=p["requested_start"], end=p["requested_end"]):
        raise ValueError("ARCHIVE_COVERAGE")
    if symbol == "009815" and ({a["source"] for a in p["action_checks"]} != set(ACTIONS) or any(a["matches"] for a in p["action_checks"]) or p["overlap"].get("volume_differences")):
        raise ValueError("TPEX_ACTION_INTEGRITY")
    return p

def expected_day(client, now, as_of=None):
    local = now.astimezone(TZ)
    limit = local.date() if local.hour >= 18 else local.date() - dt.timedelta(days=1)
    target = dt.date.fromisoformat(as_of) if as_of else limit
    if target > limit: raise ValueError("UNCOMPLETED_DAY_1800_TAIPEI")
    e = client.get(HOLIDAY_URL)
    holidays = e["payload"]
    if not isinstance(holidays, list) or not holidays or not any(iso_date(r.get("Date")).startswith(str(target.year)) for r in holidays):
        raise ValueError("HOLIDAY_CALENDAR_COVERAGE")
    calendar = TradingCalendar(fetcher=lambda: holidays)
    for _ in range(28):
        result = calendar.check(target)
        if result.status == "UNKNOWN": raise ValueError(result.reason)
        if result.status == "TRADING_DAY": return target.isoformat(), limit.isoformat(), ref(e)
        target -= dt.timedelta(days=1)
    raise ValueError("EXPECTED_SESSION_UNRESOLVED")

def official_sessions(client, exchange, month, cutoff):
    if exchange == "twse":
        e = client.get(f"https://www.twse.com.tw/exchangeReport/FMTQIK?response=json&date={month}01")
        return parse_market(e["payload"], month, cutoff), ref(e)
    e = client.get(f"https://www.tpex.org.tw/www/zh-tw/indexInfo/inx?date={month[:4]}%2F{month[4:]}%2F01&response=json")
    p = e["payload"]; t = p["tables"][0]
    if p.get("stat") != "ok" or p.get("date") != month + "01" or t.get("fields") != ["日期", "開市", "最高", "最低", "收市", "漲/跌"] or t.get("totalCount") != len(t["data"]):
        raise ValueError("TPEX_CALENDAR_SCHEMA")
    dates = [dt.date.fromisoformat(r[0].replace("/", "-")).isoformat() for r in t["data"]]
    if len(set(dates)) != len(dates) or any(d.replace("-", "")[:6] != month for d in dates): raise ValueError("TPEX_CALENDAR_DATE")
    return sorted(d for d in dates if d <= cutoff), ref(e)

def twse_actions(client, symbol, start, end):
    lo, hi = start.replace("-", ""), end.replace("-", "")
    e = client.get(f"https://www.twse.com.tw/exchangeReport/TWT49U?response=json&startDate={lo}&endDate={hi}")
    p = e["payload"]
    if p.get("stat") != "OK" or p.get("strDate") != lo or p.get("endDate") != hi or p.get("fields", [])[:7] != ["資料日期", "股票代號", "股票名稱", "除權息前收盤價", "除權息參考價", "權值+息值", "權/息"]:
        raise ValueError("TWSE_ACTION_COVERAGE")
    events = []
    for row in p["data"]:
        date = roc(row[0])
        if not start <= date <= end: raise ValueError("TWSE_ACTION_DATE")
        if row[1] == symbol:
            if row[6] != "息": raise ValueError("UNREVIEWED_CORPORATE_ACTION:" + date)
            events.append(dict(date=date, amount=number(row[5]), source="TWSE/TWT49U"))
    return events, [ref(e)], None

def tpex_actions(client, start, end):
    checks, refs = [], []
    for name in ACTIONS:
        e = client.get(f"https://www.tpex.org.tw/www/zh-tw/bulletin/{name}?startDate={start.replace('-', '%2F')}&endDate={end.replace('-', '%2F')}&response=json")
        p = e["payload"]; t = p["tables"][0]
        field = next((f for f in ("代號", "證券代號", "股票代號") if f in t["fields"]), None)
        if p.get("stat") != "ok" or p.get("date") != start.replace("-", "") + "~" + end.replace("-", "") or not field or t["fields"].count(field) != 1 or t.get("totalCount") != len(t["data"]):
            raise ValueError("TPEX_ACTION_COVERAGE")
        matches = [r for r in t["data"] if r[t["fields"].index(field)] == "009815"]
        if matches: raise ValueError("UNREVIEWED_CORPORATE_ACTION:" + name)
        checks.append(dict(source=name, matches=[], sha256=e["sha256"])); refs.append(ref(e))
    return [], refs, checks

def unique_refs(original, added):
    out, seen = [], set()
    for e in [*original, *added]:
        key = (e["url"], e["sha256"])
        if key not in seen: out.append(e); seen.add(key)
    return out

def update_symbol(root, client, symbol, target, holiday_ref, repair_from=None):
    old = verify_archive(root, symbol)
    if old["requested_end"] > target: return old, False, "VERIFIED_NEWER_THAN_REQUEST"
    # A replay of an already verified date must be byte-identical (no timestamps).
    if old["requested_end"] == target and not repair_from: return old, False, "ALREADY_CURRENT"
    exchange = "tpex" if symbol == "009815" else "twse"
    anchor_month = old["price"][-1]["date"][:7] + "-01"
    start = min(repair_from or anchor_month, anchor_month)
    start = start[:7] + "-01"
    start = max(start, old["requested_start"])
    queried = list(months(start, target))
    if len(queried) > 24: raise ValueError("REPAIR_WINDOW_TOO_LARGE")
    rows, sessions, refs, calendar_refs = [], [], [], []
    for month in queried:
        dates, calendar_ref = official_sessions(client, exchange, month, target)
        calendar_refs.append(calendar_ref); sessions.extend(dates)
        if exchange == "twse":
            e = client.get(f"https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date={month}01&stockNo={symbol}")
            rows.extend(parse_month(e["payload"], symbol, month, target)); refs.append(ref(e))
        else:
            e = client.get(f"https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=009815&date={month[:4]}%2F{month[4:]}%2F01&response=json")
            monthly_rows = monthly(e["payload"], month); refs.append(ref(e))
            # Recheck exact official shares at the anchor, plus each missing day.
            prior = {r["date"]: r for r in old["price"]}
            for date in dates:
                if date not in monthly_rows: raise ValueError("OFFICIAL_MONTH_MISSING:" + date)
                if date < old["price"][-1]["date"] and date in prior:
                    if any(abs(prior[date][key]-monthly_rows[date][key])>1e-8 for key in FIELDS[:-1]) or abs(prior[date]["Trading_Volume"]/1000-monthly_rows[date]["displayed_lots"])>0.50000001:
                        raise ValueError("TPEX_MONTH_OVERLAP_CONFLICT:" + date)
                    continue
                e = client.get(f"https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date={date.replace('-', '%2F')}&response=json")
                rows.append(daily(e["payload"], date, monthly_rows[date])); refs.append(ref(e))
    sessions = sorted(set(d for d in sessions if start <= d <= target))
    if target not in sessions: raise ValueError("OFFICIAL_CALENDAR_DELAY:" + target)
    previous = {r["date"]: r for r in old["price"]}
    if not any(r["date"] == old["price"][-1]["date"] for r in rows): raise ValueError("OVERLAP_ANCHOR_MISSING")
    overlap = 0
    for row in rows:
        if row["date"] not in sessions: raise ValueError("UNEXPECTED_TRADING_DATE:" + row["date"])
        prior = previous.get(row["date"])
        if prior:
            for key in FIELDS:
                if abs(prior[key] - row[key]) > (0 if key == "Trading_Volume" else 1e-8): raise ValueError("OFFICIAL_OVERLAP_CONFLICT:" + row["date"] + ":" + key)
            overlap += 1
        elif not old.get("base_last_date") or row["date"] > old["base_last_date"]:
            previous[row["date"]] = row
    missing = [d for d in sessions if (not old.get("base_last_date") or d > old["base_last_date"]) and d not in previous]
    if missing: raise ValueError("OFFICIAL_SESSION_MISSING:" + ",".join(missing))
    action_start = old["requested_start"] if exchange == "tpex" else start
    events, action_refs, checks = tpex_actions(client, action_start, target) if exchange == "tpex" else twse_actions(client, symbol, start, target)
    old_events = {e["date"]: e for e in old["dividends"]}
    observed_events = {e["date"]: e for e in events}
    for date, event in old_events.items():
        if start <= date <= target and observed_events.get(date) != event: raise ValueError("DIVIDEND_OVERLAP_CONFLICT:" + date)
    old_events.update(observed_events)
    new_rows = sorted(previous.values(), key=lambda r: r["date"])
    if new_rows == old["price"] and list(old_events.values()) == old["dividends"] and target == old["requested_end"]:
        return old, False, "ALREADY_CURRENT"
    result = copy.deepcopy(old)
    result.update(price=new_rows, requested_end=target, dividends=sorted(old_events.values(), key=lambda e:e["date"]),
                  action_coverage=dict(start=old["requested_start"], end=target),
                  fetched_at=max(e["fetched_at"] for e in [*refs, *action_refs, *calendar_refs]),
                  evidence=unique_refs(old["evidence"], [*refs, *calendar_refs, holiday_ref]))
    action_key = "evidence" if exchange == "tpex" else "action_evidence"
    result[action_key] = unique_refs(result.get(action_key, []), action_refs)
    if checks is not None:
        result["action_checks"] = checks
        result["expected_session_count"] = old["expected_session_count"] + len(new_rows) - len(old["price"])
    result["incremental_verification"] = dict(start=start, end=target, sessions=sessions,
        provider=old["provider"], overlap_count=overlap, parent_content_sha256=old["content_sha256"],
        corporate_actions="VERIFIED", calendar_evidence=calendar_refs)
    del result["content_sha256"]; result["content_sha256"] = digest(result)
    atomic_json(path_for(root, symbol), result)
    return result, True, "UPDATED"

def run(root, client, now, as_of=None, repair_from=None):
    try:
        target, cutoff, holiday_ref = expected_day(client, now, as_of)
    except Exception as exc:
        if as_of: raise
        local=now.astimezone(TZ);cutoff=(local.date() if local.hour>=18 else local.date()-dt.timedelta(days=1)).isoformat()
        result=dict(schema_version=1,price_type="RAW_UNADJUSTED",price_cutoff=cutoff,expected_completed_bar=None,next_expected_trading_day=None,symbols={})
        for symbol in SYMBOLS:
            try:
                archive=verify_archive(root,symbol)
                row=dict(status="STALE",reason="CALENDAR_GATE_UNAVAILABLE:"+str(exc),provider=archive["provider"],latest_verified_date=archive["price"][-1]["date"],verified_at=archive["fetched_at"],archive_sha256=archive["content_sha256"])
            except Exception as integrity:
                row=dict(status="UNAVAILABLE",reason=str(integrity),provider=None,latest_verified_date=None,verified_at=None,archive_sha256=None)
            result["symbols"][symbol]=row
        result["content_sha256"]=digest(result);atomic_json(root/PUBLIC_STATUS,result)
        log("CALENDAR_FAIL_CLOSED",reason=str(exc));return result,False
    if repair_from == "LATEST_MONTH": repair_from = target[:7] + "-01"
    holidays = client.get(HOLIDAY_URL)["payload"]
    calendar = TradingCalendar(fetcher=lambda: holidays)
    next_date = dt.date.fromisoformat(target)
    next_session = None
    for _ in range(28):
        next_date += dt.timedelta(days=1)
        if not any(iso_date(r.get("Date")).startswith(str(next_date.year)) for r in holidays): break
        check = calendar.check(next_date)
        if check.status == "UNKNOWN": break
        if check.status == "TRADING_DAY": next_session = next_date.isoformat(); break
    result = dict(schema_version=1, price_type="RAW_UNADJUSTED", price_cutoff=cutoff,
                  expected_completed_bar=target, next_expected_trading_day=next_session, cutoff_policy="18:00 Asia/Taipei; official completed sessions only",
                  symbols={})
    failed = False
    for symbol in SYMBOLS:
        try:
            archive, changed, operation = update_symbol(root, client, symbol, target, holiday_ref, repair_from)
            row = dict(status="CURRENT", reason=None, provider=archive["provider"], latest_verified_date=archive["price"][-1]["date"],
                       verified_at=archive["fetched_at"], archive_sha256=archive["content_sha256"])
            log("SYMBOL_VERIFIED", symbol=symbol, operation=operation, changed=changed, **row)
        except Exception as exc:
            failed = True
            try:
                archive = verify_archive(root, symbol)
                row = dict(status="STALE", reason=str(exc), provider=archive["provider"], latest_verified_date=archive["price"][-1]["date"],
                           verified_at=archive["fetched_at"], archive_sha256=archive["content_sha256"])
            except Exception as integrity:
                row = dict(status="UNAVAILABLE", reason=str(integrity), provider=None, latest_verified_date=None, verified_at=None, archive_sha256=None)
            log("SYMBOL_RETAINED_FAIL_CLOSED", symbol=symbol, **row)
        result["symbols"][symbol] = row
    result["content_sha256"] = digest(result)
    atomic_json(root / PUBLIC_STATUS, result)
    log("RADAR_DAILY_RESULT", expected_completed_bar=target, price_cutoff=cutoff, result="PARTIAL" if failed else "VERIFIED_6_OF_6")
    return result, not failed

def verify_publication(root, base_url, attempts=6, delay=20, fetcher=urlopen):
    """Actual public JSON, plus a successful Pages build; dispatch != published."""
    expected = {str(path_for(root, s).relative_to(root)).replace("\\", "/"): json.loads(path_for(root,s).read_text(encoding="utf-8")) for s in SYMBOLS}
    expected[PUBLIC_STATUS] = json.loads((root / PUBLIC_STATUS).read_text(encoding="utf-8"))
    for attempt in range(attempts):
        try:
            build = json.loads(subprocess.check_output(["gh", "api", "repos/" + os.environ["GITHUB_REPOSITORY"] + "/pages/builds/latest"], text=True))
            if build.get("status") != "built": raise ValueError("PAGES_BUILD_NOT_SUCCESSFUL")
            for name, payload in expected.items():
                with fetcher(base_url.rstrip("/") + "/" + name + "?v=" + payload["content_sha256"], timeout=25) as response:
                    public = json.loads(response.read())
                if public != payload: raise ValueError("PUBLICATION_MISMATCH:" + name)
            log("PUBLICATION_VERIFIED", files=len(expected), pages_commit=build.get("commit"))
            return True
        except Exception as exc:
            log("PUBLICATION_PENDING", attempt=attempt+1, reason=str(exc))
            if attempt+1 < attempts: time.sleep(delay)
    return False

if __name__ == "__main__":
    p=argparse.ArgumentParser();p.add_argument("--as-of");p.add_argument("--from-date");p.add_argument("--revalidate",action="store_true");p.add_argument("--evidence-dir");p.add_argument("--verify-public")
    args=p.parse_args()
    if args.verify_public:
        raise SystemExit(0 if verify_publication(ROOT,args.verify_public) else 1)
    if not args.evidence_dir: p.error("--evidence-dir is required outside the public checkout")
    try:
        _, ok=run(ROOT,Client(args.evidence_dir),dt.datetime.now(dt.timezone.utc),args.as_of,"LATEST_MONTH" if args.revalidate else args.from_date)
        raise SystemExit(0 if ok else 1)
    except Exception as error:
        log("RADAR_DAILY_FAILED_CLOSED", reason=str(error));raise SystemExit(1)
