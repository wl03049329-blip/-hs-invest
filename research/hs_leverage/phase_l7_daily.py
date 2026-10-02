"""Daily, completed-bar-only automation around the unchanged frozen L7 engine.

Historical research inputs remain immutable. Only the operational data snapshot,
append-only ledgers and status are published. No date override/backfill interface.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import subprocess
import tempfile
import time
import urllib.request
from datetime import date, datetime, time as day_time, timedelta, timezone
from pathlib import Path

import phase_l7_shadow as shadow
import phase_l7_incidents as incidents

TAIPEI = timezone(timedelta(hours=8))
BASE = "research/hs_leverage"
FORWARD = BASE + "/forward"
SNAPSHOT = FORWARD + "/00631L-adjusted-daily.json"
STATUS = FORWARD + "/daily-status.json"
INCIDENTS = FORWARD + "/daily-incidents.jsonl"
CALENDAR_URL = "https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule"
DAILY_URL = "https://www.twse.com.tw/exchangeReport/STOCK_DAY"
ACTION_URL = "https://api.finmindtrade.com/api/v4/data"
FIELDS = ("open", "high", "low", "close")
REPORT_HORIZONS = (20, 40, 60)
REVIEW_MARKERS = ("CORPORATE_ACTION", "REVISION", "ADJUSTMENT", "DISCONTINUITY", "BASIS",
                  "SYMBOL", "NONFINITE", "OHLC_CONFLICT", "DUPLICATE", "HASH_CHAIN")
Error = shadow.IntegrityError


def require(condition, reason):
    if not condition:
        raise Error(reason)


def digest(value):
    return hashlib.sha256(shadow.canonical(value).encode()).hexdigest()


def fetch_json(url):
    # Transport retries never substitute another instrument, frequency or quote.
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 HS-Forward-Shadow/1.0"})
            with urllib.request.urlopen(request, timeout=30) as response:
                require(response.status == 200, "SOURCE_HTTP_ERROR")
                return json.loads(response.read().decode("utf-8-sig"))
        except (OSError, ValueError):
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def iso_roc(value):
    digits = str(value).replace("/", "").replace("-", "")
    require(digits.isdigit() and len(digits) in (7, 8), "INVALID_SOURCE_DATE")
    if len(digits) == 7:
        digits = str(int(digits[:3]) + 1911) + digits[3:]
    result = f"{digits[:4]}-{digits[4:6]}-{digits[6:]}"
    date.fromisoformat(result)
    return result


def calendar_days(payload, year):
    require(isinstance(payload, list) and len(payload) >= 10, "CALENDAR_UNAVAILABLE")
    seen, closed = set(), set()
    for row in payload:
        day = iso_roc(row["Date"])
        require(day not in seen, "CALENDAR_DUPLICATE_DATE")
        seen.add(day)
        text = row.get("Name", "") + " " + row.get("Description", "")
        if any(word in text for word in ("開始交易", "最後交易")):
            continue
        require(any(word in text for word in ("無交易", "休市", "放假", "補假")), "CALENDAR_UNKNOWN_EVENT")
        closed.add(day)
    require(f"{year}-01-01" in seen and any(x.startswith(f"{year}-12") for x in seen), "CALENDAR_YEAR_UNCOVERED")
    return closed


def expected_day(now, holidays):
    local = now.astimezone(TAIPEI)
    # Conservative publication boundary; never treat the current quote as FINAL.
    day = local.date()
    if local.time() < day_time(16, 30):
        day -= timedelta(days=1)
    for _ in range(20):
        if day.weekday() < 5 and day.isoformat() not in holidays:
            return day.isoformat()
        day -= timedelta(days=1)
    raise Error("CALENDAR_LATEST_SESSION_UNRESOLVED")


def validate_rows(rows):
    require(bool(rows), "EMPTY_HISTORY")
    require(shadow.validate_history(rows, "00631L") is None, "INVALID_OR_DUPLICATE_OHLC")
    for row in rows:
        require(date.fromisoformat(row["date"]).isoformat() == row["date"], "INVALID_BAR_DATE")
        require(all(not isinstance(row[k], bool) and math.isfinite(float(row[k])) for k in FIELDS), "NONFINITE_OHLC")


def parse_yahoo(payload, historical, expected, latest_fallback=None, previous_anchor=None):
    require(payload.get("chart", {}).get("error") is None, "YAHOO_SOURCE_ERROR")
    results = payload.get("chart", {}).get("result")
    require(isinstance(results, list) and len(results) == 1, "YAHOO_SCHEMA_ERROR")
    result = results[0]
    meta = result["meta"]
    require(meta.get("symbol") == "00631L.TW", "SYMBOL_MISMATCH")
    require(meta.get("dataGranularity") == "1d", "DAILY_FREQUENCY_REQUIRED")
    require(meta.get("exchangeTimezoneName") == "Asia/Taipei", "EXCHANGE_TIMEZONE_MISMATCH")
    require(meta.get("currency") == "TWD" and meta.get("instrumentType") == "ETF", "INSTRUMENT_MISMATCH")
    # The frozen input already contains the reviewed 22:1 split. No new action
    # may be silently accepted, including dividends or a different split ratio.
    for kind, events in result.get("events", {}).items():
        for event in events.values():
            day = datetime.fromtimestamp(event["date"], TAIPEI).date().isoformat()
            require(kind == "splits" and day == "2026-03-31"
                    and event.get("numerator") == 22 and event.get("denominator") == 1,
                    "CORPORATE_ACTION_REVIEW_REQUIRED")
    timestamps = result["timestamp"]
    quotes = result["indicators"]["quote"][0]
    adjusted = result["indicators"]["adjclose"][0]["adjclose"]
    require(all(len(quotes[k]) == len(timestamps) for k in (*FIELDS, "volume"))
            and len(adjusted) == len(timestamps), "YAHOO_ARRAY_LENGTH_MISMATCH")
    old = {r["date"]: r for r in historical["item"]["rows"]}
    first = min(old)
    rows = []
    for i, timestamp in enumerate(timestamps):
        day = datetime.fromtimestamp(timestamp, TAIPEI).date().isoformat()
        if day < first or day > expected:
            continue  # Never persist a current, incomplete provider bar.
        if day == expected and latest_fallback is not None:
            rows.append(latest_fallback)
            continue
        volume = quotes["volume"][i]
        if volume is None or volume == 0:
            # Vendor placeholders on holidays/suspensions are not trading bars.
            # Frozen overlap and TWSE session equality below reject missing real
            # sessions; no synthetic OHLC or trading-day clock is introduced.
            continue
        raw = {k: quotes[k][i] for k in FIELDS}
        require(all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v > 0 for v in raw.values()), "MISSING_SOURCE_OHLC:" + day)
        require(isinstance(adjusted[i], (int, float)) and not isinstance(adjusted[i], bool) and math.isfinite(adjusted[i]) and adjusted[i] > 0, "MISSING_ADJUSTED_CLOSE:" + day)
        factor = adjusted[i] / raw["close"]
        restored = {k: raw[k] * factor for k in FIELDS}
        # Apply only the already-reviewed legacy source repair, and only when
        # all four fields independently agree with the frozen reference bytes.
        if day < "2015-01-05" and day in old:
            if not all(math.isclose(restored[k], old[day][k], rel_tol=2e-5, abs_tol=2e-6) for k in FIELDS):
                repaired = {k: restored[k] / 22 for k in FIELDS}
                require(all(math.isclose(repaired[k], old[day][k], rel_tol=2e-5, abs_tol=2e-6) for k in FIELDS), "LEGACY_ADJUSTMENT_REVIEW_REQUIRED")
                restored = repaired
                factor /= 22
        require(isinstance(volume, (int, float)) and math.isfinite(volume) and volume > 0, "INVALID_SOURCE_VOLUME")
        rows.append({"date": day, **restored, "volume": volume, "raw_close": raw["close"],
                     "adjustment_factor": factor, "provider_ohlc": raw})
    if latest_fallback is not None and not any(r["date"] == expected for r in rows):
        rows.append(latest_fallback)
    if previous_anchor is not None:
        require(not any(r["date"] == previous_anchor["date"] for r in rows),
                "FALLBACK_PREVIOUS_ANCHOR_CONFLICT")
        rows.append(previous_anchor)
        rows.sort(key=lambda row: row["date"])
    validate_rows(rows)
    require(rows[-1]["date"] == expected, "STALE_ADJUSTED_OHLC")
    compare_history(historical, rows)
    return rows


def compare_history(prior, rows):
    current = {r["date"]: r for r in rows}
    for old in prior["item"]["rows"]:
        require(old["date"] in current, "HISTORICAL_DATE_REMOVED")
        new = current[old["date"]]
        if old.get("source_provenance", {}).get("fallback_used"):
            require(new.get("adjustment_factor") == 1, "FALLBACK_ADJUSTMENT_REVISION_REVIEW_REQUIRED:" + old["date"])
        require(all(math.isclose(old[k], new[k], rel_tol=2e-5, abs_tol=2e-6) for k in FIELDS),
                "HISTORICAL_REVISION_REVIEW_REQUIRED:" + old["date"])


def parse_official(payload, month):
    require(payload.get("stat") == "OK" and payload.get("date", "")[:6] == month,
            "OFFICIAL_MONTH_UNAVAILABLE:" + month)
    require("00631L" in payload.get("title", ""), "OFFICIAL_SYMBOL_MISMATCH")
    fields = payload.get("fields", [])
    required = ("日期", "成交股數", "開盤價", "最高價", "最低價", "收盤價")
    require(all(k in fields for k in required), "OFFICIAL_SCHEMA_MISMATCH")
    output = []
    for values in payload["data"]:
        row = dict(zip(fields, values))
        day = iso_roc(row["日期"])
        require(day.replace("-", "")[:6] == month, "OFFICIAL_MONTH_MISMATCH")
        volume = float(row["成交股數"].replace(",", ""))
        require(math.isfinite(volume) and volume > 0 and volume.is_integer(), "INVALID_OFFICIAL_VOLUME:" + day)
        output.append({"date": day, "volume": volume, **{k: float(row[label].replace(",", "")) for k, label in
                        zip(FIELDS, ("開盤價", "最高價", "最低價", "收盤價"))}})
    validate_rows(output)
    return output


def months_between(first, last):
    day = date.fromisoformat(first).replace(day=1)
    while day.isoformat() <= last:
        yield day.strftime("%Y%m")
        day = (day.replace(day=28) + timedelta(days=4)).replace(day=1)


def verified_previous_bar(root, prior, policy, official, expected):
    """Attest the immediately previous bar against a successful tracked run.

    Old operational rows predate per-bar provenance. Their price blob, source
    receipts, successful same-day status and bot publication must coincide in
    Git history. A dirty checkout or fixture cannot impersonate that history.
    """
    require(prior is not None and len(official) >= 2, "FALLBACK_PREVIOUS_ANCHOR_MISSING")
    anchor = prior["item"]["rows"][-1]
    require(anchor["date"] == official[-2]["date"] and anchor["date"] < expected,
            "FALLBACK_PREVIOUS_ANCHOR_NOT_ADJACENT")
    relative = SNAPSHOT

    def git(*args):
        try:
            return subprocess.check_output(("git", "-C", str(root), *args), stderr=subprocess.DEVNULL)
        except (OSError, subprocess.CalledProcessError) as exc:
            raise Error("FALLBACK_PREVIOUS_ANCHOR_UNVERIFIED") from exc

    require(not git("status", "--porcelain", "--", relative).strip(), "FALLBACK_PREVIOUS_ANCHOR_UNVERIFIED")
    published = git("log", "-1", "--format=%H", "HEAD", "--", relative).decode().strip()
    require(len(published) == 40, "FALLBACK_PREVIOUS_ANCHOR_UNVERIFIED")
    author = git("show", "-s", "--format=%an <%ae>", published).decode().strip()
    require(author == "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
            "FALLBACK_PREVIOUS_ANCHOR_UNVERIFIED")
    try:
        published_price = json.loads(git("show", published + ":" + relative))
        published_status = json.loads(git("show", published + ":" + STATUS))
        head_price = json.loads(git("show", "HEAD:" + relative))
        published_ledger = [json.loads(line) for line in
            git("show", published + ":" + policy["paths"]["forward_ledger"]).decode().splitlines()
            if line.strip()]
    except (ValueError, Error) as exc:
        raise Error("FALLBACK_PREVIOUS_ANCHOR_UNVERIFIED") from exc
    require(prior == published_price == head_price, "FALLBACK_PREVIOUS_ANCHOR_UNVERIFIED")
    previous_hash = None
    for record in published_ledger:
        require(record.get("previous_record_hash") == previous_hash
                and record.get("record_hash") == shadow.payload_hash(record, previous_hash),
                "FALLBACK_PREVIOUS_ANCHOR_UNVERIFIED")
        previous_hash = record["record_hash"]
    evaluations = [record for record in published_ledger
                   if record.get("record_type") == "SIGNAL_EVALUATION"]
    require(len(evaluations) == published_status.get("forward_observations")
            and all(record.get("evaluation_date", "9999") <= anchor["date"] for record in evaluations),
            "FALLBACK_PREVIOUS_ANCHOR_UNVERIFIED")
    metadata = prior.get("metadata", {})
    receipts = metadata.get("source_receipts_sha256", {})
    require(metadata.get("price_basis") == "Adjusted OHLC"
            and metadata.get("corporate_action_status") == "REVALIDATED"
            and metadata.get("expected_completed_bar") == anchor["date"]
            and metadata.get("data_version") == published_status.get("data_version")
            and all(isinstance(receipts.get(key), str) and len(receipts[key]) == 64
                    for key in ("yahoo", "calendar", "twse_" + anchor["date"].replace("-", "")[:6]))
            and published_status.get("status") in ("APPENDED", "NOOP_ALREADY_RECORDED",
                                                     "NO_CURRENT_COMPLETED_SESSION_NO_BACKFILL")
            and published_status.get("data_integrity") == "PASS"
            and published_status.get("dry_run") is False
            and published_status.get("latest_data_date") == anchor["date"]
            and str(published_status.get("workflow_run_id", "")).isdigit(),
            "FALLBACK_PREVIOUS_ANCHOR_UNVERIFIED")
    try:
        checked = datetime.fromisoformat(published_status["checked_at"])
    except (KeyError, ValueError, TypeError) as exc:
        raise Error("FALLBACK_PREVIOUS_ANCHOR_UNVERIFIED") from exc
    require(checked.tzinfo is not None
            and checked >= datetime.combine(date.fromisoformat(anchor["date"]), day_time(16, 30), TAIPEI),
            "FALLBACK_PREVIOUS_ANCHOR_UNVERIFIED")
    try:
        generated = datetime.fromisoformat(metadata["generated_at"])
    except (KeyError, ValueError, TypeError) as exc:
        raise Error("FALLBACK_PREVIOUS_ANCHOR_UNVERIFIED") from exc
    require(generated.tzinfo is not None and timedelta(0) <= checked - generated <= timedelta(minutes=5),
            "FALLBACK_PREVIOUS_ANCHOR_UNVERIFIED")
    require(anchor.get("adjustment_factor") == 1, "FALLBACK_ADJUSTMENT_UNRESOLVED")
    source = anchor.get("source_provenance")
    require(source is None or (source.get("integrity_status") == "PASS"
            and source.get("trading_date") == anchor["date"]
            and source.get("adjustment_factor") == 1
            and source.get("effective_source") in ("YAHOO", "TWSE_FALLBACK")),
            "FALLBACK_PREVIOUS_ANCHOR_UNVERIFIED")
    restored = dict(anchor)
    if source is None:
        restored["source_provenance"] = {
            "trading_date": anchor["date"], "primary_source": "YAHOO", "effective_source": "YAHOO",
            "raw_source": "YAHOO", "fallback_used": False, "fallback_reason": None,
            "adjustment_factor": 1, "adjustment_status": "PERSISTED_VERIFIED_FACTOR_ONE",
            "collected_at": metadata["generated_at"], "integrity_status": "PASS"}
    restored["source_provenance"] = {**restored["source_provenance"],
        "evidence_mode": "PERSISTED_VERIFIED_PREVIOUS_BAR", "verified_commit": published,
        "verified_workflow_run_id": published_status["workflow_run_id"]}
    return restored


def latest_twse_fallback(yahoo, historical, prior, official, expected, now, fetcher, receipts,
                         previous_anchor=None):
    """Only a missing/null latest bar, with independent corporate-action proof.

    Check distribution, split, reduction and par-value action datasets.
    An empty *validated* event response plus unchanged factor-one anchors is
    evidence; a missing response or a prior raw price alone is not evidence.
    """
    result = yahoo["chart"]["result"][0]
    quotes = result["indicators"]["quote"][0]
    adjusted = result["indicators"]["adjclose"][0]["adjclose"]
    indices = [i for i, stamp in enumerate(result["timestamp"])
               if datetime.fromtimestamp(stamp, TAIPEI).date().isoformat() == expected]
    require(len(indices) <= 1, "DUPLICATE_SOURCE_DATE")
    index = indices[0] if indices else None
    require(index is not None, "FALLBACK_CURRENT_SOURCE_EVIDENCE_MISSING")
    values = [quotes[k][index] for k in (*FIELDS, "volume")] + [adjusted[index]]
    require(any(v is None for v in values), "LATEST_PRIMARY_NOT_NULL")
    require(all(v is None or (isinstance(v, (int, float)) and not isinstance(v, bool)
                and math.isfinite(v) and v > 0) for v in values), "INVALID_PRIMARY_FALLBACK_VALUE")
    require(all(isinstance(quotes[k][index], (int, float)) and not isinstance(quotes[k][index], bool)
                and math.isfinite(quotes[k][index]) and quotes[k][index] > 0 for k in ("open", "high", "low")),
            "FALLBACK_CURRENT_SOURCE_EVIDENCE_MISSING")
    require(official[-1]["date"] == expected, "LATEST_OFFICIAL_BAR_UNAVAILABLE")
    latest = official[-1]
    # A reviewed, restored OHLC anchor is mandatory, not a guessed multiplier.
    anchor_data = prior or historical
    require(anchor_data["metadata"].get("price_basis") == "Adjusted OHLC", "FALLBACK_ADJUSTMENT_BASIS_REQUIRED")
    anchors = [r for r in anchor_data["item"]["rows"] if r["date"] < expected]
    require(bool(anchors), "FALLBACK_ADJUSTMENT_ANCHOR_REQUIRED")
    anchor = previous_anchor if previous_anchor is not None else anchors[-1]
    require(anchor.get("adjustment_factor") == 1 and len(official) >= 2
            and anchor["date"] == official[-2]["date"], "FALLBACK_ADJUSTMENT_UNRESOLVED")
    # Validate current Yahoo factors too: a new retroactive adjustment must fail.
    complete = [i for i, stamp in enumerate(result["timestamp"])
                if anchor["date"] <= datetime.fromtimestamp(stamp, TAIPEI).date().isoformat() < expected
                and quotes["close"][i] is not None and adjusted[i] is not None]
    require(bool(complete) or previous_anchor is not None, "FALLBACK_CURRENT_SOURCE_EVIDENCE_MISSING")
    require(all(quotes["close"][i] > 0 and adjusted[i] / quotes["close"][i] == 1 for i in complete),
            "FALLBACK_ADJUSTMENT_FACTOR_UNPROVEN")
    for dataset in ("TaiwanStockDividendResult", "TaiwanStockSplitPrice",
                    "TaiwanStockCapitalReductionReferencePrice", "TaiwanStockParValueChange"):
        # Par-value changes are an all-market FinMind dataset (no data_id).
        symbol_filter = "" if dataset == "TaiwanStockParValueChange" else "&data_id=00631L"
        url = (f"{ACTION_URL}?dataset={dataset}{symbol_filter}"
               f"&start_date={anchor['date']}&end_date={expected}")
        events = fetcher(url)
        require(events.get("status") == 200 and events.get("msg") == "success"
                and isinstance(events.get("data"), list), "CORPORATE_ACTION_SOURCE_UNAVAILABLE")
        receipts[dataset] = digest(events)
        for event in events["data"]:
            require(isinstance(event.get("stock_id"), str) and isinstance(event.get("date"), str),
                    "CORPORATE_ACTION_SCHEMA_REVIEW_REQUIRED")
            require(date.fromisoformat(event["date"]).isoformat() == event["date"]
                    and anchor["date"] <= event["date"] <= expected, "CORPORATE_ACTION_DATE_REVIEW_REQUIRED")
            if dataset != "TaiwanStockParValueChange":
                require(event["stock_id"] == "00631L", "CORPORATE_ACTION_SCHEMA_REVIEW_REQUIRED")
        require(not any(event["stock_id"] == "00631L" for event in events["data"]),
                "CORPORATE_ACTION_REVIEW_REQUIRED")
    require(all(abs(quotes[k][index] - latest[k]) <= .011 for k in ("open", "high", "low")),
            "FALLBACK_CURRENT_CROSSCHECK_FAILED:" + expected)
    require(quotes["close"][index] is None or abs(quotes["close"][index] - latest["close"]) <= .011,
            "FALLBACK_CURRENT_CROSSCHECK_FAILED:" + expected)
    if adjusted[index] is not None:
        require(abs(adjusted[index] - latest["close"]) <= .011, "FALLBACK_ADJUSTMENT_UNRESOLVED")
        if quotes["close"][index] is not None:
            require(adjusted[index] / quotes["close"][index] == 1, "FALLBACK_ADJUSTMENT_UNRESOLVED")
    raw = {k: latest[k] for k in FIELDS}
    return {"date": expected, **raw, "volume": latest["volume"], "raw_close": latest["close"],
            "adjustment_factor": 1, "provider_ohlc": raw,
            "source_provenance": {"trading_date": expected, "primary_source": "YAHOO",
                "effective_source": "TWSE_FALLBACK", "raw_source": "TWSE", "fallback_used": True,
                "primary_source_status": "NULL",
                "fallback_reason": ("YAHOO_CURRENT_CLOSE_ADJCLOSE_NULL"
                                    if quotes["close"][index] is None and adjusted[index] is None
                                    else "LATEST_COMPLETED_PRIMARY_NULL"),
                "evidence_mode": ("PERSISTED_VERIFIED_PREVIOUS_BAR" if previous_anchor is not None
                                  else "CURRENT_YAHOO_FACTOR_ONE"),
                "yahoo_volume": quotes["volume"][index], "twse_volume": latest["volume"],
                "volume_discrepancy": (quotes["volume"][index] != latest["volume"]),
                "adjustment_factor": 1, "adjustment_status": "VERIFIED_FACTOR_ONE_NO_ACTION",
                "adjustment_anchor_date": anchor["date"], "collected_at": now.isoformat(),
                "integrity_status": "PASS"}}


def collect(historical, prior, policy, now, fetcher=fetch_json, root=shadow.ROOT):
    local = now.astimezone(TAIPEI)
    holidays_payload = fetcher(CALENDAR_URL)
    holidays = calendar_days(holidays_payload, local.year)
    expected = expected_day(now, holidays)
    require(expected[:4] == str(local.year), "CALENDAR_YEAR_BOUNDARY_REVIEW_REQUIRED")
    start = int(datetime(2014, 10, 23, tzinfo=TAIPEI).timestamp())
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/00631L.TW?period1={start}"
           f"&period2={int(now.timestamp())}&interval=1d&events=div%2Csplits")
    yahoo = fetcher(url)
    # Verify the complete current-year sequence against official instrument
    # sessions (including suspensions), not merely a weekday approximation.
    official = []
    receipts = {"yahoo": digest(yahoo), "calendar": digest(holidays_payload)}
    first = f"{local.year}-01-01"
    for month in months_between(first, expected):
        payload = fetcher(f"{DAILY_URL}?response=json&date={month}01&stockNo=00631L")
        receipts["twse_" + month] = digest(payload)
        official.extend(r for r in parse_official(payload, month) if r["date"] <= expected)
    validate_rows(official)
    previous_anchor = None
    if prior and len(official) >= 2:
        previous = official[-2]["date"]
        yahoo_dates = {datetime.fromtimestamp(stamp, TAIPEI).date().isoformat()
                       for stamp in yahoo["chart"]["result"][0]["timestamp"]}
        if previous not in yahoo_dates:
            previous_anchor = verified_previous_bar(root, prior, policy, official, expected)
    try:
        rows = parse_yahoo(yahoo, historical, expected, previous_anchor=previous_anchor)
    except Error as exc:
        # Do not turn any historical/schema/action failure into a fallback.
        require(str(exc) in ("MISSING_SOURCE_OHLC:" + expected,
                            "MISSING_ADJUSTED_CLOSE:" + expected, "STALE_ADJUSTED_OHLC"), str(exc))
        fallback = latest_twse_fallback(yahoo, historical, prior, official, expected, now, fetcher,
                                        receipts, previous_anchor)
        rows = parse_yahoo(yahoo, historical, expected, latest_fallback=fallback,
                           previous_anchor=previous_anchor)
    if prior:
        compare_history(prior, rows)
    relevant = [r for r in rows if r["date"] >= first]
    require([r["date"] for r in relevant] == [r["date"] for r in official], "OFFICIAL_SESSION_CONTINUITY_FAIL")
    for adjusted, raw in zip(relevant, official):
        # Yahoo quotes are already split-restored before 2026-03-31.
        split_factor = 22 if raw["date"] < "2026-03-31" else 1
        require(all(abs(adjusted["provider_ohlc"][k] * split_factor - raw[k]) <= 0.011 for k in FIELDS),
                "OFFICIAL_OHLC_CONFLICT:" + raw["date"])
    for before, after in zip(rows, rows[1:]):
        # 00631L has a 20% daily limit; allow a small numeric margin. This is
        # an integrity guard, never a new strategy entry threshold.
        require(after["date"] < policy["forward_start_date"] or abs(after["close"] / before["close"] - 1) <= .205,
                "PRICE_DISCONTINUITY_REVIEW_REQUIRED:" + after["date"])
    require(rows[-1]["date"] == expected, "LATEST_OFFICIAL_BAR_UNAVAILABLE")
    # Collection timestamps are audit data, not price-series identity.
    version = "adjusted_daily_v1:" + digest([{k: v for k, v in r.items() if k != "source_provenance"} for r in rows])
    old_rows = {r["date"]: r for r in prior["item"]["rows"]} if prior else {}
    for row in rows:
        if "source_provenance" not in row:
            row["source_provenance"] = {"trading_date": row["date"], "primary_source": "YAHOO",
                "effective_source": "YAHOO", "raw_source": "YAHOO", "fallback_used": False,
                "fallback_reason": None, "adjustment_factor": row["adjustment_factor"],
                "adjustment_status": "VALIDATED_ADJUSTED", "collected_at": now.isoformat(), "integrity_status": "PASS"}
        previous = old_rows.get(row["date"], {}).get("source_provenance")
        if previous and previous.get("fallback_used") and not row["source_provenance"]["fallback_used"]:
            row["source_provenance"].update(reconciliation_status="MATCHED_FACTOR_ONE", previous_source=previous)
        elif previous and previous.get("previous_source"):
            row["source_provenance"].update(reconciliation_status=previous["reconciliation_status"],
                                            previous_source=previous["previous_source"])
    return {"metadata": {"version": 1, "ticker": "00631L", "source_symbol": "00631L.TW",
                         "price_basis": "Adjusted OHLC", "frequency": "1d", "generated_at": now.isoformat(),
                         "expected_completed_bar": expected, "data_version": version,
                         "corporate_action_status": "REVALIDATED", "completed_bar_required": True,
                         "official_validation_from": first, "source_receipts_sha256": receipts,
                         "source_url": url, "official_source_url": DAILY_URL,
                         "source_repairs": historical["metadata"].get("source_repairs", {})},
            "item": {"rows": rows}}, holidays


def validate_ledgers(ledger, outcomes, policy):
    for path in (ledger, outcomes):
        require(shadow.validate_hash_chain(path)["status"] == "PASS", "LEDGER_HASH_CHAIN_INVALID")
    records, realized = shadow.read_jsonl(ledger), shadow.read_jsonl(outcomes)
    evaluations = [r for r in records if r.get("record_type") == "SIGNAL_EVALUATION"]
    dates = [r["evaluation_date"] for r in evaluations]
    require(dates == sorted(set(dates)), "DUPLICATE_OR_NONCHRONOLOGICAL_EVALUATION")
    for r in evaluations:
        require(not r.get("test_mode") and r.get("live_capital") is False, "NON_SHADOW_RECORD")
        require(r.get("strategy_id") == policy["strategy_id"] and r["evaluation_date"] >= policy["forward_start_date"], "INVALID_FORWARD_RECORD")
        when = datetime.fromisoformat(r["calculated_at"])
        require(when.tzinfo is not None and when.astimezone(TAIPEI).date().isoformat() == r["evaluation_date"], "HISTORICAL_BACKFILL_REJECTED")
        require(when.astimezone(TAIPEI).time() >= day_time(16, 30), "INTRADAY_RECORD_REJECTED")
    entries = [r for r in records if r.get("record_type") == "SHADOW_ENTRY"]
    triggers = {r["record_id"]: r for r in evaluations if r["signal_triggered"] and not r["repeat_signal"]}
    require(len(entries) <= 1, "UNRESOLVED_HOLDING_POLICY_MULTIPLE_ENTRIES")
    for entry in entries:
        require(entry["trigger_record_id"] in triggers, "ORPHAN_ENTRY")
        require(not entry.get("test_mode") and entry.get("live_capital") is False, "NON_SHADOW_ENTRY")
        require(entry["evaluation_date"] > triggers[entry["trigger_record_id"]]["evaluation_date"], "INVALID_NEXT_OPEN_DATE")
    keys = [(r["signal_record_id"], r["horizon"]) for r in realized]
    require(len(keys) == len(set(keys)), "DUPLICATE_OUTCOME")
    for outcome in realized:
        require(outcome["signal_record_id"] in {e["record_id"] for e in entries}
                and outcome["horizon"] in shadow.HORIZONS and not outcome.get("test_mode"), "ORPHAN_OR_INVALID_OUTCOME")
    return records, realized


def require_incident_review(root, records):
    path = root / INCIDENTS
    require(shadow.validate_hash_chain(path)["status"] == "PASS", "INCIDENT_HASH_CHAIN_INVALID")
    reviewed = {r.get("incident_id") for r in records
                if r.get("record_type") == "CORPORATE_ACTION_RECOVERY"
                and r.get("integrity_review_status") == "PASS"
                and r.get("approved_by") and r.get("new_data_version")
                and len(r.get("recovery_steps_completed", [])) >= 8}
    for incident in shadow.read_jsonl(path):
        require(not incident.get("requires_integrity_review") or incident["record_id"] in reviewed,
                "EXPLICIT_INTEGRITY_REVIEW_REQUIRED:" + incident["record_id"])


def summarize(records, realized):
    evaluations = [r for r in records if r.get("record_type") == "SIGNAL_EVALUATION"]
    eligible = [r for r in evaluations if r.get("signal_triggered") and not r.get("repeat_signal") and not r.get("fail_closed_reason")]
    entries = [r for r in records if r.get("record_type") == "SHADOW_ENTRY"]
    report = [r for r in realized if r["horizon"] in REPORT_HORIZONS]
    return {"forward_observations": len(evaluations), "eligible_observations": len(eligible),
            "signal_trigger_count": sum(bool(r["signal_triggered"]) for r in evaluations),
            "repeat_signal_count": sum(bool(r["repeat_signal"]) for r in evaluations),
            "forward_samples": len(entries), "pending_entries": len(eligible) - len(entries),
            "first_eligible_observation_date": eligible[0]["evaluation_date"] if eligible else None,
            "pending_outcomes": len(eligible) * 3 - len(report), "completed_outcomes": len(report),
            "all_horizons_completed_outcomes": len(realized),
            "outcomes_by_horizon": {str(h): {"completed": sum(r["horizon"] == h for r in realized),
                                                   "pending": len(eligible) - sum(r["horizon"] == h for r in realized)} for h in REPORT_HORIZONS},
            "holding_policy": "HOLDING_HORIZON_UNRESOLVED", "live_capital": False,
            "production_signal": False, "capital_allocation_pct": 0}


def update_ledgers(root, policy, data, now, holidays):
    ledger = root / policy["paths"]["forward_ledger"]
    outcomes = root / policy["paths"]["outcomes_ledger"]
    records, realized = validate_ledgers(ledger, outcomes, policy)
    rows = data["item"]["rows"]
    validate_rows(rows)
    metadata = data["metadata"]
    generated = datetime.fromisoformat(metadata["generated_at"])
    require(generated.tzinfo is not None and 0 <= (now - generated).total_seconds() <= policy["data_contract"]["maximum_source_age_hours"] * 3600, "STALE_SOURCE_TIMESTAMP")
    require(metadata.get("frequency") == "1d" and metadata.get("corporate_action_status") == "REVALIDATED"
            and metadata.get("price_basis") == "Adjusted OHLC" and metadata.get("ticker") == "00631L", "DATA_CONTRACT_INVALID")
    require(rows[-1]["date"] == expected_day(now, holidays) == metadata["expected_completed_bar"], "STALE_OR_INCOMPLETE_BAR")
    today = now.astimezone(TAIPEI).date().isoformat()
    threshold = policy["threshold"]
    require(threshold["threshold_effective_from"] <= today <= threshold["threshold_effective_to"], "FROZEN_ANNUAL_THRESHOLD_EXPIRED")
    require(today >= policy["forward_start_date"], "BEFORE_FORWARD_START")
    require(not policy["live_capital"] and not policy["production_signal"] and policy["capital_allocation_pct"] == 0, "SHADOW_ONLY_REQUIRED")
    by_date = {r["date"]: i for i, r in enumerate(rows)}
    state = shadow.latest_state(records)
    require(state != "FAIL_CLOSED", "EXPLICIT_INTEGRITY_RECOVERY_REQUIRED")
    entries = [r for r in records if r.get("record_type") == "SHADOW_ENTRY"]
    # Resolve NEXT_OPEN only from a trigger that was actually recorded before
    # that session opened. A missed daily job never shifts the entry to today.
    for trigger in records:
        if trigger.get("record_type") != "SIGNAL_EVALUATION" or not trigger.get("signal_triggered") or trigger.get("repeat_signal"):
            continue
        idx = by_date[trigger["evaluation_date"]] + 1
        if idx >= len(rows) or any(e["trigger_record_id"] == trigger["record_id"] for e in entries):
            continue
        entry_row = rows[idx]
        require(datetime.fromisoformat(trigger["calculated_at"]) < datetime.fromisoformat(entry_row["date"] + "T09:00:00+08:00"), "LATE_SIGNAL_NOT_FORWARD")
        entry = {"record_type": "SHADOW_ENTRY", "record_id": "ENTRY:" + trigger["record_id"],
                 "trigger_record_id": trigger["record_id"], "signal_date": trigger["evaluation_date"],
                 "evaluation_date": entry_row["date"], "planned_entry_reference": "NEXT_OPEN",
                 "shadow_entry_reference": entry_row["open"], "strategy_id": policy["strategy_id"],
                 "strategy_version": policy["strategy_version"], "market_regime": trigger["market_regime"],
                 "threshold_version": trigger["threshold_version"], "data_version": metadata["data_version"],
                 "calculated_at": now.isoformat(), "live_capital": False, "test_mode": False}
        shadow.append_record(ledger, entry)
        entries.append(entry)
    if entries:
        state = "COOLDOWN_HOLDING"  # No holding horizon is silently selected.
    for entry in entries:
        idx = by_date[entry["evaluation_date"]]
        require(math.isclose(entry["shadow_entry_reference"], rows[idx]["open"], rel_tol=2e-5), "ENTRY_BASIS_REVISION")
        for outcome in shadow.mature_outcomes(entry, rows, idx, policy):
            outcome.update({"outcome_calculated_at": now.isoformat(), "data_version": metadata["data_version"],
                            "trigger_record_id": entry["trigger_record_id"], "trigger_date": entry["signal_date"]})
            shadow.append_record(outcomes, outcome)
    # Strict same-Taipei-date capture. Past bars are data context only.
    can_observe = rows[-1]["date"] == today and now.astimezone(TAIPEI).time() >= day_time(16, 30)
    if can_observe and not any(r.get("evaluation_date") == today and r.get("record_type") == "SIGNAL_EVALUATION" for r in records):
        record = shadow.evaluate(rows, len(rows) - 1, policy, state_before=state)
        record.update({"calculated_at": now.isoformat(), "data_as_of": today + "T13:30:00+08:00",
                       "data_source": SNAPSHOT, "data_version": metadata["data_version"],
                       "holding_policy_version": "L6_HOLDING_HORIZON_UNRESOLVED",
                       "risk_policy_version": "L6_FINAL_ALLOCATION_UNRESOLVED",
                       "production_signal": False, "shadow_entry_reference": None,
                       "source_receipts_sha256": metadata["source_receipts_sha256"]})
        require(record["fail_closed_reason"] is None, "EVALUATION_FAILED_CLOSED")
        shadow.append_record(ledger, record)
        status = "APPENDED"
    elif can_observe:
        status = "NOOP_ALREADY_RECORDED"
    else:
        status = "NO_CURRENT_COMPLETED_SESSION_NO_BACKFILL"
    records, realized = validate_ledgers(ledger, outcomes, policy)
    return {"status": status, "latest_data_date": rows[-1]["date"], **summarize(records, realized)}


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=".daily-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def run(root=shadow.ROOT, now=None, fetcher=fetch_json, dry_run=False):
    live_clock = now is None
    now = now or datetime.now(timezone.utc)
    require(now.tzinfo is not None, "AWARE_CLOCK_REQUIRED")
    policy, historical = shadow.load_context(root)
    ledger = root / policy["paths"]["forward_ledger"]
    outcomes = root / policy["paths"]["outcomes_ledger"]
    records, realized = validate_ledgers(ledger, outcomes, policy)
    prior = shadow.read_json(root / SNAPSHOT) if (root / SNAPSHOT).exists() else None
    probe = {}
    def read_source(url):
        payload = fetcher(url)
        if url == CALENDAR_URL:
            probe["holidays"] = calendar_days(payload, now.astimezone(TAIPEI).year)
            probe["target"] = expected_day(now, probe["holidays"])
        elif "query1.finance.yahoo.com/" in url:
            probe["yahoo"] = payload
        elif url.startswith(DAILY_URL):
            month = url.split("date=")[1][:6]
            probe.setdefault("official", []).extend(parse_official(payload, month))
        return payload
    awaiting_review = False
    # All mutations are computed in isolation. A failure cannot leave a partial
    # official entry/outcome. Publication is one Git commit in the workflow.
    try:
        try:
            require_incident_review(root, records)
        except Error as exc:
            if not str(exc).startswith("EXPLICIT_INTEGRITY_REVIEW_REQUIRED:"):
                raise
            awaiting_review = True
        # Review latch blocks publication, not a read-only recovery probe.
        data, holidays = collect(historical, prior, policy, now, read_source, root=root)
        probe.update(target=data["metadata"]["expected_completed_bar"], holidays=holidays,
                     data_version=data["metadata"]["data_version"])
        if awaiting_review:
            return operational_failure(root, policy, prior, historical, records, realized, now,
                                       dry_run, probe, "RECOVERY_EVIDENCE_AVAILABLE", True)
        if live_clock:
            finished = datetime.now(timezone.utc)
            require(finished.astimezone(TAIPEI).date() == now.astimezone(TAIPEI).date(), "CAPTURE_WINDOW_CLOSED")
            now = finished
        with tempfile.TemporaryDirectory() as tmp:
            staged = Path(tmp)
            for source, relative in ((ledger, policy["paths"]["forward_ledger"]), (outcomes, policy["paths"]["outcomes_ledger"])):
                target = staged / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source.read_bytes() if source.exists() else b"")
            if not records:
                shadow.append_record(staged / policy["paths"]["forward_ledger"], {
                    "record_type": "FORWARD_AUTOMATION_INITIALIZATION", "record_id": "DAILY_AUTOMATION_INIT_V1",
                    "strategy_id": policy["strategy_id"], "strategy_version": "V1", "initialized_at": now.isoformat(),
                    "forward_start_date": policy["forward_start_date"], "historical_shadow_backfill": False,
                    "live_capital": False, "production_signal": False, "capital_allocation_pct": 0})
            status = update_ledgers(staged, policy, data, now, holidays)
            status.update({"checked_at": now.isoformat(), "data_integrity": "PASS", "dry_run": dry_run,
                           "data_version": data["metadata"]["data_version"],
                           "workflow_run_id": os.environ.get("GITHUB_RUN_ID"),
                           "threshold_valid_through": policy["threshold"]["threshold_effective_to"]})
            if not dry_run:
                atomic_json(root / SNAPSHOT, data)
                for relative in policy["paths"].values():
                    target = root / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    # Preserve append-only bytes; never rewrite existing records.
                    old = target.read_bytes() if target.exists() else b""
                    new = (staged / relative).read_bytes()
                    require(new.startswith(old), "APPEND_ONLY_PUBLICATION_REQUIRED")
                    with target.open("ab") as handle:
                        handle.write(new[len(old):])
                atomic_json(root / STATUS, status)
            return status
    except Exception as exc:
        reason = (str(exc) if isinstance(exc, Error) else "SOURCE_TRANSPORT_ERROR"
                  if isinstance(exc, OSError) else "UNEXPECTED_VALIDATION_ERROR")
        # Corrupt incident chains cannot be appended to or notification-deduped.
        if shadow.validate_hash_chain(root / INCIDENTS)["status"] != "PASS":
            return {"status": "FAIL_CLOSED", "reason": "INCIDENT_HASH_CHAIN_INVALID",
                    "data_integrity": "FAIL", "requires_integrity_review": True,
                    "workflow_classification": "NEW_FAIL_CLOSED"}
        return operational_failure(root, policy, prior, historical, records, realized, now,
                                   dry_run, probe, reason, awaiting_review)


def operational_failure(root, policy, prior, historical, records, realized, now,
                        dry_run, probe, reason, awaiting_review):
    anchor = (prior or historical)["item"]["rows"][-1]["date"]
    target = probe.get("target")
    recovery = reason == "RECOVERY_EVIDENCE_AVAILABLE"
    history = shadow.read_jsonl(root / INCIDENTS)
    reviewed = {r.get("incident_id") for r in records
                if r.get("record_type") == "CORPORATE_ACTION_RECOVERY"
                and r.get("integrity_review_status") == "PASS" and r.get("approved_by")
                and r.get("new_data_version") and len(r.get("recovery_steps_completed", [])) >= 8}
    unresolved = [r for r in history if r["record_id"] not in reviewed
                  and r.get("requires_integrity_review")]
    pending_p0 = next((r["reason"] for r in unresolved if incidents.p0_reason(r["reason"])), None)
    root_reason = pending_p0 or (unresolved[-1]["reason"] if recovery and unresolved else reason)
    context = incidents.identity(target, root_reason, anchor, policy)
    evidence = source_probe_evidence(probe, anchor, target)
    if recovery:
        evidence.update(validation="PASS", data_version=probe.get("data_version"))
    classification, key = incidents.classify(
        context, evidence, history, reviewed, expected_day, probe.get("holidays", set()),
        recovery=recovery, legacy_progress=any(not row["missing"] for row in evidence.get("sessions", [])))
    if pending_p0:
        classification = "NEW_FAIL_CLOSED"  # A pending P0 review is never a green known failure.
    status = {"status": "FAIL_CLOSED", "system_state": "FAIL_CLOSED", "signal_status": "NO_SIGNAL",
              "reason": root_reason, "checked_at": now.isoformat(), "latest_data_date": anchor,
              "expected_completed_bar": target, "freshness": "STALE" if target and anchor < target else "UNKNOWN",
              "data_integrity": "FAIL", "dry_run": dry_run,
              "requires_integrity_review": awaiting_review or recovery or reason != "SOURCE_TRANSPORT_ERROR",
              "workflow_classification": classification, "incident_identity": context,
              "incident_fingerprint": key, "source_probe_evidence": evidence, **summarize(records, realized)}
    if not dry_run and classification != "KNOWN_FAIL_CLOSED_DEDUPED":
        shadow.append_record(root / INCIDENTS, {"record_type": "DAILY_VALIDATION_FAILURE",
                            "record_id": "OPERATIONAL:" + key, **status})
        atomic_json(root / STATUS, status)
    return status


def source_probe_evidence(probe, anchor, target):
    """Stable field availability/values only, not raw payload or transport metadata."""
    sessions = sorted({r["date"] for r in probe.get("official", []) if target and anchor < r["date"] <= target})
    if not sessions:
        return {"sessions": [], "availability": "UNKNOWN"}
    try:
        result = probe["yahoo"]["chart"]["result"][0]
        quote = result["indicators"]["quote"][0]
        adjusted = result["indicators"]["adjclose"][0]["adjclose"]
        by_date = {datetime.fromtimestamp(stamp, TAIPEI).date().isoformat(): i
                   for i, stamp in enumerate(result["timestamp"])}
        evidence = []
        for day in sessions:
            i = by_date.get(day)
            values, missing = {}, []
            for field in (*FIELDS, "volume", "adjclose"):
                series = adjusted if field == "adjclose" else quote.get(field, [])
                value = series[i] if i is not None and i < len(series) else None
                if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or value < 0 or (field != "volume" and value == 0):
                    missing.append(field)
                else:
                    values[field] = value
            evidence.append({"date": day, "missing": missing, "values": values})
        return {"sessions": evidence}
    except (KeyError, IndexError, TypeError, ValueError, OverflowError):
        return {"sessions": [], "availability": "INVALID_SCHEMA"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Validate live sources without writing any operational state.")
    args = parser.parse_args()
    lock = shadow.ROOT / FORWARD / ".daily.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        raise SystemExit("FAIL_CLOSED: DAILY_RUN_ALREADY_ACTIVE")
    try:
        os.close(fd)
        try:
            status = run(dry_run=args.dry_run)
        except Exception as exc:
            status = {"status": "FAIL_CLOSED", "system_state": "FAIL_CLOSED",
                      "reason": str(exc) if isinstance(exc, Error) else "UNEXPECTED_VALIDATION_ERROR",
                      "data_integrity": "FAIL", "requires_integrity_review": True,
                      "workflow_classification": "NEW_FAIL_CLOSED",
                      "live_capital": False, "production_signal": False}
        print(json.dumps(status, ensure_ascii=False, indent=2))
        classification = status.get("workflow_classification", "VALIDATED" if status["status"] != "FAIL_CLOSED" else "NEW_FAIL_CLOSED")
        output = os.environ.get("GITHUB_OUTPUT")
        if output:
            with open(output, "a", encoding="utf-8") as handle:
                handle.write("classification=" + classification + "\n")
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a", encoding="utf-8") as handle:
                handle.write("## 00631L Forward Shadow\n\n```json\n" + json.dumps(status, indent=2) + "\n```\n")
                if classification == "KNOWN_FAIL_CLOSED_DEDUPED":
                    handle.write("\n" + incidents.WARNING)
        return incidents.exit_code(status)
    finally:
        lock.unlink()


if __name__ == "__main__":
    raise SystemExit(main())
