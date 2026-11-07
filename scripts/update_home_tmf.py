"""Publish only the homepage TMF estimate, from dated TAIFEX reports."""
import argparse
import hashlib
import json
import re
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path

from update_futures_position import ROOT, TAIPEI, TAIWAN_MARKET_HOLIDAYS, expected_trading_date, institutional_positions

OUTPUT = ROOT / "home-tmf-net.json"
KINDS = ("futContractsDate", "futDailyMarketReport")


def url(kind, day):
    params = {"doQuery": 1, "queryDate": day.replace("-", "/")}
    params.update({"queryType": 1, "commodityId": "TMF"} if kind == KINDS[0]
                  else {"queryType": 2, "commodity_id": "TMF", "MarketCode": 0})
    return "https://www.taifex.com.tw/cht/3/" + kind + "?" + urllib.parse.urlencode(params)


class Tables(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.tables, self.stack = [], []
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.stack.append([[], None, None])
        elif self.stack:
            if tag == "tr":
                self.stack[-1][1:] = [[], None]
            elif tag in {"td", "th"} and self.stack[-1][1] is not None:
                self.stack[-1][2] = []

    def handle_data(self, text):
        if self.stack and self.stack[-1][2] is not None:
            self.stack[-1][2].append(text)

    def handle_endtag(self, tag):
        if not self.stack:
            return
        table, row, cell = self.stack[-1]
        if tag in {"td", "th"} and cell is not None:
            row.append("".join("".join(cell).split()))
            self.stack[-1][2] = None
        elif tag == "tr" and row:
            table.append(row)
            self.stack[-1][1:] = [None, None]
        elif tag == "table":
            self.tables.append(self.stack.pop()[0])


def parse(day, institutional, daily):
    market_day = day.replace("-", "/")
    left = institutional.decode("utf-8-sig")
    right = daily.decode("utf-8-sig")
    if not re.search(r"日期\s*" + market_day + r"\s*</span>", left):
        raise ValueError("institutional report date mismatch")
    if not re.search(market_day + r"(?:&nbsp;|\s)+08:45~13:45\s*一般交易時段行情表", right):
        raise ValueError("market report date/session mismatch")
    inst = [t for t in Tables(left).tables if ["交易口數與契約金額", "未平倉餘額"] == [c for r in t for c in r if c in {"交易口數與契約金額", "未平倉餘額"}]
            and any("微型臺指期貨" in r for r in t)]
    market = [t for t in Tables(right).tables if any("*未沖銷契約量" in r for r in t) and any(r[0] == "TMF" for r in t)]
    if len(inst) != 1 or len(market) != 1:
        raise ValueError("ambiguous TAIFEX table")
    starts = [i for i, r in enumerate(inst[0]) if len(r) == 15 and r[1] == "微型臺指期貨"]
    if len(starts) != 1:
        raise ValueError("ambiguous TMF institutional group")
    inst_rows = inst[0][starts[0]:starts[0]+3]
    if [len(r) for r in inst_rows] != [15, 13, 13] or [r[-13] for r in inst_rows] not in (
        ["自營商", "投信", "外資"], ["自營商", "投信", "外資及陸資"]
    ):
        raise ValueError("institutional rows are incomplete, duplicated or wrong product")
    positions = institutional_positions([
        {"ContractCode": "微型臺指期貨", "Item": "外資及陸資" if r[-13] == "外資" else r[-13], "OpenInterest(Long)": r[-6],
         "OpenInterest(Short)": r[-4], "OpenInterest(Net)": r[-2]} for r in inst_rows
    ], "微型臺指期貨")
    header, *rows = market[0]
    if header[:2] != ["契約", "到期月份(週別)"] or header.count("*未沖銷契約量") != 1:
        raise ValueError("invalid market report headers")
    idx = header.index("*未沖銷契約量")
    months = {}
    if not rows or rows[-1][:2] != ["", ""] or len(rows[-1]) != len(header):
        raise ValueError("missing market report total")
    for row in rows[:-1]:
        if row[0] != "TMF" or len(row) != len(header):
            raise ValueError("unexpected market row")
        month, oi = row[1], row[idx]
        if not re.fullmatch(r"\d{4}(?:0[1-9]|1[0-2])", month) or month in months or not re.fullmatch(r"\d+", oi):
            raise ValueError("missing, duplicate or invalid TMF month")
        months[month] = int(oi)
    start = date.fromisoformat(day)
    base = start.year * 12 + start.month - 1
    def delivery(first):
        quarters = [n for n in range(first+3, first+16) if (n+1) % 3 == 0][:3]
        return {f"{n//12:04d}{n%12+1:02d}" for n in [first, first+1, first+2, *quarters]}
    # Report may roll the expiring month out at settlement. Do not accept
    # arbitrary six rows or a weekly/monthly mixture.
    expiry = next(start.replace(day=n) for n in range(15,22) if start.replace(day=n).weekday() == 2)
    while expiry.weekday() >= 5 or expiry.isoformat() in TAIWAN_MARKET_HOLIDAYS:
        expiry += timedelta(days=1)
    allowed = [delivery(base if start <= expiry else base+1)]
    if set(months) not in allowed:
        raise ValueError("expected six standard TMF delivery months; retain previous verified snapshot")
    raw_total = sum(months.values())
    if str(raw_total) != rows[-1][idx].replace(",", ""):
        raise ValueError("market month rows do not reconcile with official total")
    settlement = {}
    if start == expiry:
        # The market table may retain the pre-settlement OI row. TAIFEX's
        # institutional publication explicitly excludes the expiring month.
        month = day[:7].replace("-", "")
        settlement = {"excluded_expiry": {"month": month, "open_interest": months.pop(month), "raw_total": raw_total}}
    total = sum(months.values())
    long = sum(row["long"] for row in positions.values())
    short = sum(row["short"] for row in positions.values())
    totals = [r for r in inst[0] if len(r) == 13 and r[0] == "期貨合計"]
    if len(totals) != 1 or [int(totals[0][i].replace(",", "")) for i in (-6, -4, -2)] != [long, short, long-short]:
        raise ValueError("institutional total does not reconcile")
    if not total or max(long, short) > total:
        raise ValueError("institutional and market scopes do not reconcile")
    return {"date": day, "months": months, "institutional": positions, "market_open_interest": total,
            "net": short - long, **settlement,
            "evidence": [{"url": url(kind, day), "sha256": hashlib.sha256(blob).hexdigest()}
                         for kind, blob in zip(KINDS, (institutional, daily))]}


def previous_session(day):
    # Same reviewed TAIFEX holiday calendar as the existing futures updater.
    d = date.fromisoformat(day)
    if d.year != 2026:
        raise ValueError("update reviewed TAIFEX trading calendar before using a new year")
    return expected_trading_date(datetime.combine(d, datetime.min.time(), TAIPEI))


def snapshot(day, read, now):
    previous = previous_session(day)
    days = [parse(d, *(read(k, d) for k in KINDS)) for d in (previous, day)]
    return {"schema": "HS_HOME_TMF_V1", "source": "TAIFEX", "contract": "TMF", "session": "REGULAR",
            "validation": "VERIFIED", "trade_date": day, "previous_trade_date": previous,
            "net": days[1]["net"], "net_change": days[1]["net"] - days[0]["net"],
            "retrieved_at": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"), "observations": days}


def fetch(kind, day):
    with urllib.request.urlopen(url(kind, day), timeout=20) as response:
        if response.status != 200 or urllib.parse.urlparse(response.url).hostname != "www.taifex.com.tw":
            raise ValueError("unexpected TAIFEX response")
        return response.read(1_000_001)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("--date")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    now = datetime.now(timezone.utc)
    day = expected_trading_date(now)
    if args.date and args.date != day and not args.check:
        raise ValueError("historical reads are check-only")
    def read(kind, d):
        data = (args.evidence / f"{d}-{kind}.html").read_bytes() if args.evidence else fetch(kind, d)
        if len(data) > 1_000_000:
            raise ValueError("TAIFEX report exceeds size bound")
        return data
    if args.evidence and not args.check:
        raise ValueError("fixture files are check-only")
    if now < datetime.fromisoformat((args.date or day) + "T13:45:00+08:00"):
        raise ValueError("general session has not closed")
    result = snapshot(args.date or day, read, now)
    if args.check:
        print(json.dumps(result, ensure_ascii=True, indent=2))
        return
    if OUTPUT.exists():
        old = json.loads(OUTPUT.read_text(encoding="utf-8"))
        if old["trade_date"] >= result["trade_date"]:
            signature = lambda item: [{k: v for k, v in row.items() if k != "evidence"} for row in item["observations"]]
            if old["trade_date"] > result["trade_date"] or signature(old) != signature(result):
                raise ValueError("older/conflicting TAIFEX snapshot; retained existing data")
            return
    temp = OUTPUT.with_suffix(".tmp")
    with temp.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    temp.replace(OUTPUT)


if __name__ == "__main__":
    main()
