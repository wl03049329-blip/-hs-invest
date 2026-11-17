"""Evidence for the single reviewed 00662 split; no fabricated candles."""
import re
from html import unescape
from decimal import Decimal
from scripts.collect_radar_twse import number

SYMBOL, LAST, START, RESUME = "00662", "2026-11-10", "2026-11-11", "2026-11-17"
SCHEDULE = "https://www.twse.com.tw/zh/ETFortune/announcement?company=A00010&date=20260910&fund=00662&seq=1&type=all"
REFERENCE = "https://www.twse.com.tw/rwd/zh/split/TWTCAU?response=json&startDate=20261101&endDate=20261130"

def schedule(client):
    entry = client.get(SCHEDULE, html=True)
    body = re.sub(r"\s+", "", unescape(re.sub(r"<[^>]+>", "", entry["payload"])))
    patterns = {"受益憑證最後交易日期": "115年11月10日",
                "受益憑證停止交易期間": "115年11月11日至115年11月16日",
                "新受益憑證上市買賣日": "115年11月17日"}
    if "00662" not in body or any(set(re.findall(label + r"：([0-9年月日至]+)", body)) != {value}
                                   for label, value in patterns.items()):
        raise ValueError("00662_SPLIT_SCHEDULE_CHANGED_OR_UNVERIFIED")
    return entry

def reference(client, previous_close):
    entry = client.get(REFERENCE)
    payload = entry["payload"]
    rows = [r for r in payload.get("data", []) if len(r) == 9 and r[1] == SYMBOL]
    if payload.get("stat") != "OK" or payload.get("fields", [])[:6] != ["恢復買賣日期","ETF代號","名稱","分割(反分割)","停止買賣前收盤價格","恢復買賣參考價"] or len(rows) != 1 or rows[0][0] != "115/11/17" or rows[0][3] != "分割":
        raise ValueError("00662_SPLIT_REFERENCE_UNVERIFIED")
    before, after = [Decimal(v.replace(",", "")) for v in rows[0][4:6]]
    if before != Decimal(str(previous_close)) or not (after.is_finite() and after > 0 and before == 5 * after):
        raise ValueError("00662_SPLIT_REFERENCE_CONFLICT")
    return entry, float(before), float(after)

def daily(client, date, monthly=None):
    entry = client.get("https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=" + date.replace("-", "") + "&type=ALLBUT0999")
    data = entry["payload"]
    names = ("證券代號", "開盤價", "最高價", "最低價", "收盤價", "成交股數")
    tables = [t for t in data.get("tables", []) if all(t.get("fields", []).count(n) == 1 for n in names)]
    if data.get("stat") != "OK" or data.get("date") != date.replace("-", "") or len(tables) != 1:
        raise ValueError("00662_DAILY_REPORT_UNVERIFIED:" + date)
    table = tables[0]
    rows = table["data"]
    if not rows or any(len(r) != len(table["fields"]) for r in rows):
        raise ValueError("00662_DAILY_REPORT_SCHEMA:" + date)
    cols = [table["fields"].index(n) for n in names]
    matches = [r for r in rows if r[cols[0]] == SYMBOL]
    if monthly is None:
        # Absence must come from a dated market-wide report, not an empty response.
        if matches or not any(r[cols[0]] == "0050" and number(r[cols[-1]], True) > 0 for r in rows):
            raise ValueError("00662_SUSPENSION_CONFLICT:" + date)
    elif len(matches) != 1 or any(number(matches[0][i], k == "Trading_Volume") != monthly[k]
          for i, k in zip(cols[1:], ("open", "max", "min", "close", "Trading_Volume"))):
        raise ValueError("00662_RESUMPTION_OHLC_CONFLICT:" + date)
    return entry
