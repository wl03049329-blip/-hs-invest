"""Public completed-session audit; never reads local portfolio or financial data.

Raw historical bars retain the18:00 gate. --final-expected-only selects an
official-calendar candidate after13:30; only the independent official OHLC and
adjusted-history validation may finalize it. A successful job or a recent
generated_at is not evidence that the expected date was publicly published.
"""
from __future__ import annotations
import argparse
import contextlib
import datetime as dt
import json
import os
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen
from scripts.update_radar_daily import Client, expected_day, SYMBOLS, TZ

SITE = "https://wl03049329-blip.github.io/-hs-invest/"
REPO = "wl03049329-blip/-hs-invest"


def inspect(expected, quotes, daily, scores):
    dates = quotes.get("official_source_dates", {})
    reasons = []
    for market in ("TWSE", "TPEx"):
        if dates.get(market) != expected:
            reasons.append("OFFICIAL_CLOSE_NOT_CURRENT_" + market)
        if quotes.get("source_status", {}).get(market) not in (
            "official_closing_data", "official_closing_data_daily_report"
        ):
            reasons.append("OFFICIAL_SOURCE_UNVERIFIED_" + market)
    # The next session is a forecast, not evidence about the completed one.
    # Accept an explicit null; do not treat a missing/empty field as verified.
    next_day = daily.get("next_expected_trading_day", False)
    if daily.get("expected_completed_bar") != expected or (next_day is not None and not next_day):
        reasons.append("DAILY_CALENDAR_NOT_CURRENT")
    symbols = daily.get("symbols", {})
    if set(symbols) != set(SYMBOLS) or any(r.get("status") != "CURRENT" or r.get("latest_verified_date") != expected for r in symbols.values()):
        reasons.append("DAILY_BARS_INCOMPLETE")
    if not any(r.get("date") == expected and r.get("finalized") is True for r in scores.get("snapshots", [])):
        reasons.append("CORE_CLOSE_NOT_CURRENT")
    return dict(expected_completed_session=expected, official_source_dates=dates,
                daily_expected=daily.get("expected_completed_bar"),
                daily_next_expected=daily.get("next_expected_trading_day"), reasons=reasons,
                daily_calendar_shape_valid=next_day is None or isinstance(next_day, str) and bool(next_day),
                daily_unverified={
                    symbol: {key: row.get(key) for key in ("status", "latest_verified_date", "provider", "reason")}
                    for symbol, row in symbols.items()
                    if row.get("status") != "CURRENT" or row.get("latest_verified_date") != expected
                },
                healthy=not reasons)


def daily_publication_evidence(run, now, expected):
    """A real matching producer, not dispatch acceptance or a fresh timestamp.

    The existing 20-minute handoff bound starts at creation (including queue
    time), never at a later start/retry. A historical/as-of job cannot stand in
    for this session. Legacy/unrecognized metadata stays unverified.
    """
    try:
        created = dt.datetime.fromisoformat(run["created_at"].replace("Z", "+00:00"))
        title = run.get("display_title")
        if (not isinstance(run.get("id"), int) or run["id"] <= 0
                or run.get("head_branch") != "main"
                or run.get("path") != ".github/workflows/update-radar-daily.yml"
                or run.get("event") not in ("schedule", "workflow_dispatch")
                or run.get("status") not in ("queued", "pending", "waiting", "requested", "in_progress")
                or not 0 <= (now-created).total_seconds() < 1200
                or title not in ("HS daily close " + expected, "HS daily close calendar-current")
                or title.endswith("calendar-current") and created.astimezone(TZ).date().isoformat() != expected):
            return None
        return {key: run[key] for key in ("id", "created_at", "head_branch", "path", "event", "status", "display_title")} | {
            "expected_session": expected, "deadline": (created+dt.timedelta(minutes=20)).isoformat()}
    except (KeyError, TypeError, ValueError):
        return None


def waiting_for_daily_publication(report, now):
    """Allow only a bounded handoff from a complete previous daily release."""
    prior = report["daily_expected"]
    rows = report["daily_unverified"]
    return (
        set(report["reasons"]) == {"DAILY_CALENDAR_NOT_CURRENT", "DAILY_BARS_INCOMPLETE"}
        and isinstance(prior, str) and prior < report["expected_completed_session"]
        and report.get("daily_calendar_shape_valid") is True
        and report["daily_next_expected"] in (None, report["expected_completed_session"])
        and len(rows) == len(SYMBOLS) and set(rows) == set(SYMBOLS)
        and all(row["status"] == "CURRENT" and row["latest_verified_date"] == prior
                and not row["reason"] for row in rows.values())
        and report.get("repair") in (["update-radar-daily.yml:PUBLICATION_IN_PROGRESS"],
                                     ["update-radar-daily.yml:REQUESTED_NOT_YET_VERIFIED"])
        and daily_publication_evidence(report.get("repair_evidence", {}).get("update-radar-daily.yml", {}),
                                       now, report["expected_completed_session"]) is not None
    )


def public_json(name):
    for attempt in range(3):
        try:
            with urlopen(SITE + name + "?audit=" + str(time.time_ns()), timeout=25) as r:
                if r.status != 200:
                    raise ValueError("PUBLIC_HTTP_" + str(r.status))
                return json.load(r)
        except (OSError, ValueError):
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def repair(now, reasons=None, *, evidence=None, expected=None):
    # Dispatch the existing, serialized producers only. This monitor never writes
    # quotes or competes with Railway's intraday producer. At most one request
    # per producer per 30min; running/queued work is never duplicated.
    result = []
    workflows = []
    if reasons is None or any(r.startswith(("OFFICIAL_", "CORE_")) for r in reasons):
        workflows.append("update-market-quotes.yml")
    if reasons is None or any(r.startswith("DAILY_") for r in reasons):
        workflows.append("update-radar-daily.yml")
    for workflow in workflows:
        def query():
            return json.loads(subprocess.check_output(["gh", "api", f"repos/{REPO}/actions/workflows/{workflow}/runs?branch=main&per_page=10"], text=True))["workflow_runs"]
        runs = query()
        def observe(rows):
            candidates = [item for r in rows if (item := daily_publication_evidence(r, now, expected or now.date().isoformat()))]
            if workflow == "update-radar-daily.yml" and candidates:
                if evidence is not None:
                    evidence[workflow] = min(candidates, key=lambda r: r["created_at"])
                return True
            return False
        active = [r for r in runs if r["status"] != "completed"]
        if active:
            if observe(active):
                result.append(workflow + ":PUBLICATION_IN_PROGRESS")
                continue
            result.append(workflow + ":ALREADY_RUNNING")
            continue
        if any(r["event"] == "workflow_dispatch" and (now - dt.datetime.fromisoformat(r["created_at"].replace("Z", "+00:00"))).total_seconds() < 1800 for r in runs):
            result.append(workflow + ":BOUNDED_COOLDOWN")
            continue
        command = ["gh", "workflow", "run", workflow, "--repo", REPO, "--ref", "main"]
        if workflow == "update-radar-daily.yml" and expected:
            command += ["-f", "as_of=" + expected]
        # CLI may print the newly created Run URL. Never mix it with JSON stdout.
        subprocess.run(command, check=True, stdout=sys.stderr)
        result.append(workflow + ":REQUESTED_NOT_YET_VERIFIED")
        if workflow == "update-radar-daily.yml" and evidence is not None:
            for attempt in range(3):
                if observe(query()):
                    break
                if attempt < 2:
                    time.sleep(1)
    return result


def emit_report(report, destination):
    # A separate exclusive report file is the machine contract. Diagnostic CLI
    # output cannot corrupt it; an existing audit report is never overwritten.
    text = json.dumps(report, ensure_ascii=False)
    if destination:
        with open(destination, "x", encoding="utf-8") as output:
            output.write(text + "\n")
    print(text)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repair", action="store_true")
    parser.add_argument("--report", help="Exclusive JSON audit artifact, independent of subprocess stdout")
    parser.add_argument("--expected-only", action="store_true")
    parser.add_argument("--final-expected-only", action="store_true",
                        help="Calendar-verified candidate after13:30; NOT proof of official source readiness")
    args = parser.parse_args()
    now = dt.datetime.now(TZ)
    # All triggers use actual market time. A delayed scheduled audit during the
    # session/pre18:00 handoff must not compare newly published market closes
    # to yesterday's expected bar. Pre-open/off-hours and date-only callers keep
    # their existing strict contracts; waiting cannot close a prior incident.
    if not (args.expected_only or args.final_expected_only) and 9 <= now.hour < 18:
        emit_report(dict(healthy=None, deferred=True, reasons=["WAIT_COMPLETED_SESSION_GATE"], repair=[]), args.report)
        return
    with tempfile.TemporaryDirectory(prefix="hs-market-calendar-") as directory, contextlib.redirect_stdout(sys.stderr):
        expected, _, _ = expected_day(Client(directory), now, minimum_time=(13, 30) if args.final_expected_only else (18, 0))
    if args.expected_only or args.final_expected_only:
        print(expected)
        return
    report = inspect(expected, public_json("market-quotes.json"), public_json("data/radar-history/status-v1.json"), public_json("finalized-core-score-snapshots-v1.json"))
    if args.repair and not report["healthy"]:
        report["repair_evidence"] = {}
        report["repair"] = repair(now, report["reasons"], evidence=report["repair_evidence"], expected=expected)
        # A producer-completion audit must prove publication, never wait for
        # the producer that is notifying us. Independent schedules retain the
        # same finite creation-time deadline; waiting is not healthy success.
        if not os.environ.get("HS_COMPLETED_PRODUCER_RESULT") and waiting_for_daily_publication(report, dt.datetime.now(TZ)):
            report.update(healthy=None, deferred=True, waiting="WAIT_DAILY_PUBLICATION")
    emit_report(report, args.report)
    if report["healthy"] is False:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
