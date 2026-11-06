"""Read-only official market totals; never reads or writes the margin-cost model."""
import argparse
from datetime import date, datetime, timedelta, timezone
from hashlib import sha256
import json
from pathlib import Path
import re
import time
from urllib.request import Request, urlopen

TZ = timezone(timedelta(hours=8))
SCHEMA = "HS_OFFICIAL_MARGIN_BALANCE_V1"
TWSE = "https://www.twse.com.tw/exchangeReport/MI_MARGN?date={compact}&selectType=ALL&response=json"
TPEX = "https://www.tpex.org.tw/www/zh-tw/margin/balance?date={encoded}&response=json"
BOARD = "https://info.tpex.org.tw/api/mktInfo"
CALENDAR = "https://www.tpex.org.tw/www/zh-tw/indexInfo/inx?date={month}%2F01&response=json"


def integer(x):
    s = str(x).strip().replace(",", "")
    if not re.fullmatch(r"[0-9]+", s):
        raise ValueError("invalid integer")
    return int(s)


def get(url):
    for n in range(2):
        try:
            with urlopen(Request(url, headers={"Accept": "application/json", "User-Agent": "HS official margin/1"}), timeout=15) as r:
                raw = r.read(4_000_001)
                if r.status != 200 or len(raw) > 4_000_000:
                    raise ValueError("invalid response")
            return json.loads(raw), sha256(raw).hexdigest()
        except (OSError, ValueError):
            if n:
                raise
            time.sleep(1)


def trade_dates(payload, month):
    t, = payload["tables"]
    if payload.get("stat") != "ok" or payload.get("date") != month.replace("/", "")+"01" or t["totalCount"] != len(t["data"]):
        raise ValueError("official calendar date/count mismatch")
    days = [date.fromisoformat(r[0].replace("/", "-")) for r in t["data"]]
    if days != sorted(set(days)) or any(d.strftime("%Y/%m") != month for d in days):
        raise ValueError("official calendar invalid")
    return days


def dated(payload, day):
    if payload.get("date") != day.replace("-", "") or str(payload.get("stat")).upper() != "OK":
        raise ValueError("official report date/status mismatch")


def sum_lots(payload, first, field):
    t, = [t for t in payload["tables"] if t.get("fields", [])[:2] == [first, "名稱"] and field in t["fields"]]
    values = {}
    for r in t["data"]:
        code = str(r[0]).strip()
        if not code or code in values:
            raise ValueError("duplicate/empty security")
        values[code] = integer(r[t["fields"].index(field)])
    if not sum(values.values()):
        raise ValueError("zero total margin")
    return sum(values.values())


def twse_row(payload, day, digest):
    dated(payload, day)
    lots = sum_lots(payload, "代號", "今日餘額")
    t, = [t for t in payload["tables"] if t.get("fields", [])[:1] == ["項目"] and "今日餘額" in t["fields"]]
    labels = {}
    for r in t["data"]:
        if r[0] in labels:
            raise ValueError("duplicate margin totals")
        labels[r[0]] = integer(r[t["fields"].index("今日餘額")])
    amount = labels["融資金額(仟元)"]
    if not amount or labels["融資(交易單位)"] != lots:
        raise ValueError("TWSE totals do not reconcile")
    return {"date": day, "amount_ntd": amount*1000, "sha256": digest}


def board_pairs(payload, sessions):
    def indexed(name):
        out = {}
        for r in payload[name]:
            if r["date"] in out or not integer(r["count"]):
                raise ValueError("invalid TPEx board row")
            out[r["date"]] = integer(r["count"])
        return out
    amount, lots = indexed("marginPurchaseValue"), indexed("marginPurchaseShares")
    if not amount or list(amount) != list(lots):
        raise ValueError("TPEx board rows disagree")
    n = len(amount)
    days = [d for d in sessions if f"{d.month}/{d.day}" == list(amount)[-1]]
    if len(days) != 1:
        raise ValueError("TPEx board anchor is ambiguous or absent")
    end = sessions.index(days[0])+1
    span = sessions[max(0,end-n):end]
    if [f"{d.month}/{d.day}" for d in span] != list(amount):
        raise ValueError("TPEx board window not aligned to official sessions")
    return {d.isoformat(): (amt, lots[md]) for d,(md,amt) in zip(span,amount.items(),strict=True)}


def tpex_row(payload, day, digest, board, board_digest):
    dated(payload, day)
    amount, lots = board[day]
    if sum_lots(payload, "代號", "資餘額") != lots:
        raise ValueError("TPEx board/dated lots mismatch")
    return {"date": day, "amount_ntd": amount*1000, "sha256": digest, "board_sha256": board_digest}


def saved(root, stem, host):
    raw = (root/(stem+".json")).read_bytes()
    meta = json.loads((root/(stem+".source.json")).read_text(encoding="utf-8-sig"))
    digest = sha256(raw).hexdigest()
    if digest != meta["sha256"] or not meta["url"].startswith(host):
        raise ValueError("snapshot provenance mismatch")
    return json.loads(raw), digest


def seed(sessions, raw, alternates):
    board_obj, board_digest = saved(raw,"tpex-board-amount","https://info.tpex.org.tw/api/mktInfo")
    board = board_pairs(board_obj,sessions)
    out = {"schema":SCHEMA,"sessions":[],"twse":[],"tpex":[]}
    for d in sessions:
        if not date(2026,8,7)<=d<=date(2026,11,5):
            continue
        day = d.isoformat()
        try:
            report, digest = saved(raw,day+"-twse_margin","https://www.twse.com.tw/")
        except FileNotFoundError:
            report, digest = saved(alternates,d.strftime("%Y%m%d")+"-twse-margin","https://www.twse.com.tw/")
        out["sessions"].append(day)
        out["twse"].append(twse_row(report,day,digest))
        if day in board:
            report, digest = saved(raw,day+"-tpex_margin","https://www.tpex.org.tw/")
            out["tpex"].append(tpex_row(report,day,digest,board,board_digest))
    if (len(out["twse"]),len(out["tpex"])) != (60,30):
        raise ValueError("seed history count mismatch")
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("official-margin-balance.json"))
    parser.add_argument("--seed", nargs=2, type=Path, metavar=("RAW","ALTERNATES"))
    args = parser.parse_args()
    today = datetime.now(TZ).date()
    months = ["2026/08","2026/09","2026/10","2026/11"] if args.seed else sorted({(today-timedelta(days=d)).strftime("%Y/%m") for d in range(95)})
    sessions = [d for m in months for d in trade_dates(get(CALENDAR.format(month=m.replace("/","%2F")))[0],m) if d<=today]
    if not sessions or sessions != sorted(set(sessions)):
        raise ValueError("missing or inconsistent market sessions")
    if args.seed:
        if args.output.exists():
            raise ValueError("seed will not replace an existing archive")
        data = seed(sessions,*args.seed)
        args.output.write_text(json.dumps(data, ensure_ascii=False, indent=2)+"\n",encoding="utf-8",newline="\n")
        return
    archive = json.loads(args.output.read_text(encoding="utf-8"))
    if archive["schema"] != SCHEMA:
        raise ValueError("unexpected archive schema")
    all_days = sorted(set(archive["sessions"]) | {d.isoformat() for d in sessions})[-72:]
    data = {"schema": SCHEMA, "sessions": all_days, "twse": archive["twse"], "tpex": archive["tpex"], "source_status": {}}
    failures = []
    for market in ("twse", "tpex"):
        by_day = {r["date"]:r for r in data[market]}
        current_failed = False
        try:
            board, board_digest = ({},None)
            if market == "tpex":
                raw, board_digest = get(BOARD)
                board = board_pairs(raw,sessions)
            for d in sessions[-5:]:
                day = d.isoformat()
                if day in by_day or (market=="tpex" and day not in board):
                    continue
                try:
                    payload, digest = get((TWSE if market=="twse" else TPEX).format(compact=d.strftime("%Y%m%d"),encoded=d.strftime("%Y%%2F%m%%2F%d")))
                    by_day[day] = twse_row(payload,day,digest) if market=="twse" else tpex_row(payload,day,digest,board,board_digest)
                except (OSError, ValueError, KeyError, TypeError) as exc:
                    failures.append(f"{market} {day}: {exc}")
                    current_failed |= d == sessions[-1]
            if sessions[-1].isoformat() not in by_day:
                failures.append(f"{market}: most recent official session not yet verified")
        except (OSError, ValueError, KeyError, TypeError) as exc:
            failures.append(f"{market}: {exc}")
            current_failed = True
        data[market] = [by_day[d] for d in all_days if d in by_day]
        data["source_status"][market] = "failed" if current_failed else "ready" if all_days[-1] in by_day else "waiting"
    temp = args.output.with_suffix(".pending")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2)+"\n",encoding="utf-8",newline="\n")
    temp.replace(args.output)
    for failure in failures:
        print("::warning::"+failure)


if __name__ == "__main__":
    main()
