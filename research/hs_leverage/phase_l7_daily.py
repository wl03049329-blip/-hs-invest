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
import tempfile
import time
import urllib.request
from datetime import date, datetime, time as day_time, timedelta, timezone
from pathlib import Path

import phase_l7_shadow as shadow

TAIPEI = timezone(timedelta(hours=8))
BASE = "research/hs_leverage"
FORWARD = BASE + "/forward"
SNAPSHOT = FORWARD + "/00631L-adjusted-daily.json"
STATUS = FORWARD + "/daily-status.json"
INCIDENTS = FORWARD + "/daily-incidents.jsonl"
CALENDAR_URL = "https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule"
DAILY_URL = "https://www.twse.com.tw/exchangeReport/STOCK_DAY"
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


def parse_yahoo(payload, historical, expected):
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
        volume = quotes["volume"][i]
        if volume is None or volume == 0:
            # Vendor placeholders on holidays/suspensions are not trading bars.
            # Frozen overlap and TWSE session equality below reject missing real
            # sessions; no synthetic OHLC or trading-day clock is introduced.
            continue
        raw = {k: quotes[k][i] for k in FIELDS}
        require(all(isinstance(v, (int, float)) and math.isfinite(v) and v > 0 for v in raw.values()), "MISSING_SOURCE_OHLC")
        require(isinstance(adjusted[i], (int, float)) and math.isfinite(adjusted[i]) and adjusted[i] > 0, "MISSING_ADJUSTED_CLOSE")
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
    validate_rows(rows)
    require(rows[-1]["date"] == expected, "STALE_ADJUSTED_OHLC")
    compare_history(historical, rows)
    return rows


def compare_history(prior, rows):
    current = {r["date"]: r for r in rows}
    for old in prior["item"]["rows"]:
        require(old["date"] in current, "HISTORICAL_DATE_REMOVED")
        new = current[old["date"]]
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
        output.append({"date": day, **{k: float(row[label].replace(",", "")) for k, label in
                        zip(FIELDS, ("開盤價", "最高價", "最低價", "收盤價"))}})
    validate_rows(output)
    return output


def months_between(first, last):
    day = date.fromisoformat(first).replace(day=1)
    while day.isoformat() <= last:
        yield day.strftime("%Y%m")
        day = (day.replace(day=28) + timedelta(days=4)).replace(day=1)


def collect(historical, prior, policy, now, fetcher=fetch_json):
    local = now.astimezone(TAIPEI)
    holidays_payload = fetcher(CALENDAR_URL)
    holidays = calendar_days(holidays_payload, local.year)
    expected = expected_day(now, holidays)
    require(expected[:4] == str(local.year), "CALENDAR_YEAR_BOUNDARY_REVIEW_REQUIRED")
    start = int(datetime(2014, 10, 23, tzinfo=TAIPEI).timestamp())
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/00631L.TW?period1={start}"
           f"&period2={int(now.timestamp())}&interval=1d&events=div%2Csplits")
    yahoo = fetcher(url)
    rows = parse_yahoo(yahoo, historical, expected)
    if prior:
        compare_history(prior, rows)
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
    version = "adjusted_daily_v1:" + digest(rows)
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
    # All mutations are computed in isolation. A failure cannot leave a partial
    # official entry/outcome. Publication is one Git commit in the workflow.
    try:
        require_incident_review(root, records)
        data, holidays = collect(historical, prior, policy, now, fetcher)
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
        awaiting_review = str(exc).startswith("EXPLICIT_INTEGRITY_REVIEW_REQUIRED:")
        status = {"status": "FAIL_CLOSED", "signal_status": "NO_SIGNAL", "reason": str(exc),
                  "checked_at": now.isoformat(), "latest_data_date": prior["item"]["rows"][-1]["date"] if prior else historical["item"]["rows"][-1]["date"],
                  "data_integrity": "FAIL", "dry_run": dry_run,
                  "requires_integrity_review": awaiting_review or any(marker in str(exc) for marker in REVIEW_MARKERS),
                  **summarize(records, realized)}
        if not dry_run:
            atomic_json(root / STATUS, status)
            if not awaiting_review:
                shadow.append_record(root / INCIDENTS, {"record_type": "DAILY_VALIDATION_FAILURE",
                                     "record_id": "FAIL:" + now.astimezone(TAIPEI).date().isoformat() + ":" + digest(str(exc)), **status})
        return status


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
            status = {"status": "FAIL_CLOSED", "reason": str(exc), "live_capital": False, "production_signal": False}
        print(json.dumps(status, ensure_ascii=False, indent=2))
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a", encoding="utf-8") as handle:
                handle.write("## 00631L Forward Shadow\n\n```json\n" + json.dumps(status, indent=2) + "\n```\n")
        return 2 if status["status"] == "FAIL_CLOSED" else 0
    finally:
        lock.unlink()


if __name__ == "__main__":
    raise SystemExit(main())
