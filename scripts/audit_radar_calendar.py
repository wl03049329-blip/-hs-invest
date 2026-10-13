"""Read-only OHLC audit against official observed market sessions, no quote repair.

Evidence/output live outside the public checkout. One request per missing month,
three seconds apart; stop on any HTTP/schema failure, resume from hashed evidence.
FMTQIK provides actual TWSE trading sessions, not a guessed weekday calendar.
"""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
FIELDS = ["日期", "成交股數", "成交金額", "成交筆數", "發行量加權股價指數", "漲跌點數"]
SYMBOLS = ("0050", "00662", "00757", "00830", "00935", "009815")
SUSPENDED = {"0050": {"2025-06-11", "2025-06-12", "2025-06-13", "2025-06-16", "2025-06-17"}}

def sha(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

def parse_market(payload, month, cutoff):
    if payload.get("stat") != "OK" or payload.get("date") != month + "01" or payload.get("fields") != FIELDS:
        raise ValueError("CALENDAR_SCHEMA")
    result = []
    for row in payload.get("data", []):
        if len(row) != 6 or not re.fullmatch(r"\s*\d{2,3}/\d{2}/\d{2}", row[0]):
            raise ValueError("CALENDAR_ROW")
        y, m, d = map(int, row[0].strip().split("/"))
        date = dt.date(y + 1911, m, d).isoformat()
        if date.replace("-", "")[:6] != month or date in result or int(row[1].replace(",", "")) <= 0:
            raise ValueError("CALENDAR_SESSION")
        if date <= cutoff:
            result.append(date)
    if not result:
        raise ValueError("CALENDAR_EMPTY")
    return result

def collect(destination, cutoff):
    destination = Path(destination).resolve()
    if destination == ROOT or ROOT in destination.parents:
        raise ValueError("AUDIT_MUST_BE_OUTSIDE_PUBLIC_CHECKOUT")
    destination.mkdir(parents=True, exist_ok=True)
    dates, refs = set(), []
    y, m = 2003, 6
    while f"{y:04}-{m:02}" <= cutoff[:7]:
        month = f"{y:04}{m:02}"
        path = destination / ("calendar-" + month + ".json")
        url = f"https://www.twse.com.tw/exchangeReport/FMTQIK?response=json&date={month}01"
        if path.exists():
            entry = json.loads(path.read_text(encoding="utf-8"))
            if entry["url"] != url or sha(entry["payload"]) != entry["sha256"]:
                raise ValueError("CALENDAR_EVIDENCE_HASH")
        else:
            time.sleep(3)
            with urlopen(url, timeout=30) as response:
                p = json.loads(response.read())
            parse_market(p, month, cutoff)
            entry = {"url": url, "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(), "payload": p, "sha256": sha(p)}
            path.write_text(json.dumps(entry, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        sessions = parse_market(entry["payload"], month, cutoff)
        dates.update(sessions)
        refs.append({"file": path.name, "sha256": entry["sha256"]})
        print(month, len(dates), flush=True)
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    results = []
    universe=json.loads((ROOT/'etf-universe.json').read_text(encoding='utf-8'))
    listings={r['code']:r.get('listed_date') for r in universe['items']}
    for symbol in SYMBOLS:
        rows = []
        seed = ROOT / f"research/c4_historical/source/{symbol}.json"
        if seed.exists():
            p = json.loads(seed.read_text(encoding="utf-8"))
            meta = json.loads((seed.parent.parent / seed.name).read_text(encoding="utf-8"))
            if sha(p) != meta["metadata"]["provenance"]["source_ohlc_sha256"]:
                raise ValueError("SEED_PROVENANCE")
            rows += p["price"]
        exchange = 'tpex' if symbol == '009815' else 'twse'
        archive = ROOT / f"data/radar-history/{exchange}/{symbol}.json"
        if archive.exists():
            p = json.loads(archive.read_text(encoding="utf-8"))
            content = {k: v for k, v in p.items() if k != "content_sha256"}
            if sha(content) != p["content_sha256"]:
                raise ValueError("ARCHIVE_HASH")
            rows += p["price"]
        available = {r["date"] for r in rows if r["date"] <= cutoff}
        first, last = min(available), max(available)
        expected = {d for d in dates if first <= d <= cutoff}
        calendar_source='TWSE/FMTQIK'
        if symbol=='009815':
            from scripts.audit_radar_tpex import evidence
            tpex=json.loads((destination/'tpex/009815-audit.json').read_text(encoding='utf-8'))
            if tpex['as_of']!=cutoff: raise ValueError('TPEX_CALENDAR_CUTOFF')
            tpex_dates=set()
            for m in range(1,int(cutoff[5:7])+1):
                url=f'https://www.tpex.org.tw/www/zh-tw/indexInfo/inx?date=2026%2F{m:02}%2F01&response=json'
                e=evidence(destination/'tpex','calendar-2026'+str(m).zfill(2),url)
                tpex_dates.update(r[0].replace('/','-') for r in e['payload']['tables'][0]['data'] if first<=r[0].replace('/','-')<=cutoff)
            if tpex_dates != set(tpex['sessions']): raise ValueError('TPEX_CALENDAR_EVIDENCE')
            expected=tpex_dates;calendar_source='TPEx/indexInfo/inx'
        suspended = SUSPENDED.get(symbol, set()) & expected
        missing = sorted(expected - available - suspended)
        unexpected = sorted(available - expected)
        result = {"symbol": symbol, "listing_metadata": listings.get(symbol), "listing_start_conflict": listings.get(symbol)!=first, "first_saved_date": first, "latest": last, "cutoff": cutoff, "valid_bars": len(available), "expected_market_sessions": len(expected), "confirmed_suspensions": sorted(suspended), "unresolved_missing": missing, "unexpected_price_dates": unexpected, "classification": {d: "VALID_OHLC" if d in available else "OFFICIAL_SUSPENSION" if d in suspended else "SOURCE_MISSING" for d in sorted(expected)}, "calendar_source": calendar_source}
        results.append(result)
    report = {"schema": 1, "as_of": cutoff, "source": "TWSE/FMTQIK", "monthly_evidence": refs, "results": results}
    (destination / "h1-audit.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps([{k:v for k,v in r.items() if k != "classification"} for r in results], ensure_ascii=False), flush=True)

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--evidence-dir", required=True)
    p.add_argument("--as-of", required=True)
    args = p.parse_args()
    collect(args.evidence_dir, args.as_of)
