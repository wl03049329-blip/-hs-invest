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
from scripts.update_radar_daily import Client, expected_day, TZ

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
    if daily.get("expected_completed_bar") != expected or not daily.get("next_expected_trading_day"):
        reasons.append("DAILY_CALENDAR_NOT_CURRENT")
    symbols = daily.get("symbols", {})
    if len(symbols) != 6 or any(r.get("status") != "CURRENT" or r.get("latest_verified_date") != expected for r in symbols.values()):
        reasons.append("DAILY_BARS_INCOMPLETE")
    if not any(r.get("date") == expected and r.get("finalized") is True for r in scores.get("snapshots", [])):
        reasons.append("CORE_CLOSE_NOT_CURRENT")
    return dict(expected_completed_session=expected, official_source_dates=dates,
                daily_expected=daily.get("expected_completed_bar"), reasons=reasons,
                healthy=not reasons)


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


def repair(now, reasons=None):
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
        raw = subprocess.check_output(["gh", "api", f"repos/{REPO}/actions/workflows/{workflow}/runs?branch=main&per_page=10"], text=True)
        runs = json.loads(raw)["workflow_runs"]
        if any(r["status"] != "completed" for r in runs):
            result.append(workflow + ":ALREADY_RUNNING")
            continue
        if any(r["event"] == "workflow_dispatch" and (now - dt.datetime.fromisoformat(r["created_at"].replace("Z", "+00:00"))).total_seconds() < 1800 for r in runs):
            result.append(workflow + ":BOUNDED_COOLDOWN")
            continue
        subprocess.run(["gh", "workflow", "run", workflow, "--repo", REPO, "--ref", "main"], check=True)
        result.append(workflow + ":REQUESTED_NOT_YET_VERIFIED")
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repair", action="store_true")
    parser.add_argument("--expected-only", action="store_true")
    parser.add_argument("--final-expected-only", action="store_true",
                        help="Calendar-verified candidate after13:30; NOT proof of official source readiness")
    args = parser.parse_args()
    now = dt.datetime.now(TZ)
    # Pages also publishes LIVE snapshots. During the session / pre18:00 gap,
    # an event is not evidence of a completed day and must not dispatch another
    # producer. Scheduled off-hours and pre-open audits remain unchanged.
    if not args.final_expected_only and os.environ.get("HS_COMPLETED_AUDIT_TRIGGER") == "workflow_run" and 9 <= now.hour < 18:
        print(json.dumps(dict(healthy=None, deferred=True, reasons=["WAIT_COMPLETED_SESSION_GATE"], repair=[])))
        return
    with tempfile.TemporaryDirectory(prefix="hs-market-calendar-") as directory, contextlib.redirect_stdout(sys.stderr):
        expected, _, _ = expected_day(Client(directory), now, minimum_time=(13, 30) if args.final_expected_only else (18, 0))
    if args.expected_only or args.final_expected_only:
        print(expected)
        return
    report = inspect(expected, public_json("market-quotes.json"), public_json("data/radar-history/status-v1.json"), public_json("finalized-core-score-snapshots-v1.json"))
    if args.repair and not report["healthy"]:
        report["repair"] = repair(now, report["reasons"])
    print(json.dumps(report, ensure_ascii=False))
    if not report["healthy"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
