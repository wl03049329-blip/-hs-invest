"""Read-only C4 operations check. Never captures quotes, scores, or backfills.

Can run on GitHub or an existing independently scheduled host. Only the
hobby-always-on profile permits backend probes; no Serverless keep-alive.
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import os
import re
import urllib.error
import urllib.request
from urllib.parse import urlsplit
from datetime import datetime, time

from backend.live_quotes import REQUIRED_SYMBOLS, TAIPEI
from backend.trading_calendar import TradingCalendar

REPO = "wl03049329-blip/-hs-invest"
FILE = "intraday-core-snapshots-v1.json"
SITE = "https://wl03049329-blip.github.io/-hs-invest/"
API = "https://api.github.com/repos/" + REPO
BACKEND = "https://hs-invest-production.up.railway.app"
VERSION = "FINAL_CORE_WEIGHT_V1"


def age_seconds(value, now):
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            return None
        return (now - stamp).total_seconds()
    except (TypeError, ValueError, AttributeError):
        return None


def current_snapshot(artifact):
    rows = artifact.get("snapshots", []) if isinstance(artifact, dict) else []
    rows = [r for r in rows if isinstance(r, dict) and r.get("status") == "SUCCESS"]
    return max(rows, key=lambda r: (r.get("trading_date", ""), r.get("market_as_of", ""), r.get("slot", "")), default=None)


def identity(snapshot):
    if not isinstance(snapshot, dict):
        return None
    return (snapshot.get("trading_date"), snapshot.get("slot"), snapshot.get("source", {}).get("input_fingerprint"))


def valid_snapshot(snapshot, now):
    if not isinstance(snapshot, dict):
        return False
    day = now.date().isoformat()
    if (snapshot.get("trading_date") != day or snapshot.get("schema_version") != 1
            or snapshot.get("snapshot_type") != "INTRADAY_CORE"
            or snapshot.get("status") != "SUCCESS" or snapshot.get("source_completeness") != "5/5"
            or snapshot.get("score_version") != VERSION):
        return False
    fingerprint = snapshot.get("source", {}).get("input_fingerprint")
    if not isinstance(fingerprint, str) or len(fingerprint) != 64:
        return False
    source = snapshot.get("source", {})
    snapshot_at = snapshot.get("market_as_of")
    snapshot_age = age_seconds(snapshot_at, now)
    if not isinstance(snapshot_at, str) or not snapshot_at.startswith(day + "T") or snapshot_age is None or not 0 <= snapshot_age <= 600:
        return False
    for symbol in REQUIRED_SYMBOLS:
        row = snapshot.get("items", {}).get(symbol, {})
        score, display, stamp = row.get("score"), row.get("display_score"), row.get("market_as_of")
        age = age_seconds(stamp, now)
        if (row.get("status") != "SUCCESS" or row.get("score_version") != VERSION
                or type(score) not in (int, float) or not math.isfinite(score) or not 0 <= score <= 100
                or type(display) not in (int, float) or not math.isfinite(display) or not 0 <= display <= 100
                or not isinstance(stamp, str) or not stamp.startswith(day + "T")
                or age is None or not 0 <= age <= 600
                or row.get("freshness") not in ("FRESH", "DELAYED")
                or ("quote_sources" in source and source.get("quote_sources", {}).get(symbol)
                    not in ("MIS_Z", "MIS_PZ", "FUGLE_LAST_TRADE"))
                or ("quote_sources" not in source and not
                    (source.get("provider") == "TWSE_MIS" and source.get("required_symbols") == "5/5"))):
            return False
    return True


def publication_verification(evidence):
    """Dispatch 204 / Actions success alone never constitute publication proof."""
    repo = current_snapshot(evidence.get("repo_artifact"))
    public = current_snapshot(evidence.get("public_artifact"))
    deployed = current_snapshot(evidence.get("deployed_artifact"))
    pages = evidence.get("pages", {})
    commit = evidence.get("artifact_commit_sha")
    if not repo or not isinstance(commit, str) or len(commit) != 40:
        return "ARTIFACT_COMMIT_UNVERIFIED"
    try:
        anchor = datetime.fromisoformat(repo["market_as_of"].replace("Z", "+00:00"))
        if anchor.tzinfo is None or not valid_snapshot(repo, anchor.astimezone(TAIPEI)):
            return "ARTIFACT_CONTRACT_INVALID"
    except (KeyError, TypeError, ValueError):
        return "ARTIFACT_CONTRACT_INVALID"
    if pages.get("state") != "success" or not pages.get("sha") or not pages.get("commit_included"):
        return "PAGES_DEPLOYMENT_UNVERIFIED"
    if not public or not deployed or repo != deployed or repo != public:
        return "PUBLIC_ARTIFACT_UNVERIFIED"
    fingerprint = identity(repo)[2]
    if not fingerprint:
        return "FINGERPRINT_UNVERIFIED"
    return "PUBLISHED_VERIFIED"


def evaluate(evidence, now, calendar_status):
    local = now.astimezone(TAIPEI)
    active = calendar_status == "TRADING_DAY" and time(9, 0) <= local.time() <= time(13, 30, 59)
    alerts = []
    for name in ("health", "live"):
        status = evidence.get(name, {}).get("http")
        if status != 200:
            alerts.append(name.upper() + "_ENDPOINT_UNAVAILABLE")
    health = evidence.get("health", {}).get("body", {})
    if health.get("scheduler", {}).get("status") in ("STOPPED", "STALLED", "DISABLED"):
        alerts.append("SCHEDULER_STOPPED")
    if calendar_status == "UNKNOWN":
        alerts.append("TRADING_CALENDAR_UNKNOWN")
    public = current_snapshot(evidence.get("public_artifact"))
    if active:
        # A bounded opening grace, not a relaxed quote freshness rule.
        elapsed = (local - local.replace(hour=9, minute=0, second=0, microsecond=0)).total_seconds()
        if elapsed > 600 and not valid_snapshot(public, local):
            alerts.append("NO_VALID_SNAPSHOT_OVER_600S")
        if health.get("scheduler", {}).get("status") not in ("HEALTHY", "STARTING"):
            alerts.append("SCHEDULER_HEARTBEAT_UNVERIFIED")
        if health.get("data_status") == "UNAVAILABLE":
            alerts.append("LIVE_DATA_UNAVAILABLE")
        api = evidence.get("live", {}).get("body", {})
        rows = api.get("tickers", {})
        api_snapshot = {"schema_version": api.get("schema_version"), "snapshot_type": "INTRADAY_CORE",
            "status": "SUCCESS" if api.get("status") == "AVAILABLE" and api.get("market_state") == "OPEN" else "UNAVAILABLE",
            "trading_date": api.get("trading_date"), "source_completeness": api.get("completeness"),
            "market_as_of": api.get("as_of"),
            "score_version": api.get("c4_version"), "source": {"input_fingerprint": health.get("input_fingerprint"),
                "quote_sources": {s: rows.get(s, {}).get("quote_source") for s in REQUIRED_SYMBOLS}},
            "items": {s: {**rows.get(s, {}), "status": "SUCCESS" if rows.get(s, {}).get("status") == "AVAILABLE" else "UNAVAILABLE",
                "market_as_of": rows.get(s, {}).get("quote_as_of"), "score_version": api.get("c4_version")} for s in REQUIRED_SYMBOLS}}
        native = rows.get("009815", {})
        if elapsed > 600 and (not valid_snapshot(api_snapshot, local)
                or native.get("status") != "WAIT_NATIVE" or native.get("freshness") != "WAIT_NATIVE"):
            alerts.append("LIVE_API_DATA_INVALID")
    publication = publication_verification(evidence)
    repo = current_snapshot(evidence.get("repo_artifact"))
    if active and repo and publication != "PUBLISHED_VERIFIED":
        repo_age = age_seconds(repo.get("calculated_at"), local)
        if repo_age is None or repo_age > 600:
            alerts.append(publication)
    # Accepted dispatch with no repo change must also time out.
    if active and health.get("publication_status") == "DISPATCH_ACCEPTED":
        expected = health.get("input_fingerprint")
        age = age_seconds(health.get("last_successful_live_snapshot_at"), local)
        repo_age = age_seconds(repo.get("calculated_at"), local) if repo else None
        if expected and (not repo or identity(repo)[2] != expected) and (age is None or age > 600 or repo_age is None or repo_age > 600):
            alerts.append("DISPATCH_WITHOUT_ARTIFACT_COMMIT")
    schedules = evidence.get("schedule_runs", [])
    if active and (local.hour * 60 + local.minute) > 9 * 60 + 40:
        in_session = [r for r in schedules if r.get("event") == "schedule"
                      and age_seconds(r.get("created_at"), local) is not None
                      and 0 <= age_seconds(r["created_at"], local) <= 1200]
        if not in_session:
            alerts.append("GITHUB_SCHEDULE_DELAY_OR_MISSING")
    return {"schema_version": 1, "checked_at": local.isoformat(),
            "trading_date": local.date().isoformat(), "market_check": "OPEN" if active else "OFF_SESSION",
            "calendar_status": calendar_status, "alerts": sorted(set(alerts)),
            "publication_verification": publication, "artifact_commit_sha": evidence.get("artifact_commit_sha"),
            "pages_sha": evidence.get("pages", {}).get("sha"),
            "public_snapshot_identity": identity(public),
            "status": "ALERT" if alerts else "HEALTHY" if active else "OFF_SESSION",
            "scope": "OPERATIONS_ONLY_NOT_PRODUCTION_ACCEPTANCE"}


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        redirected = super().redirect_request(request, fp, code, message, headers, new_url)
        if redirected is not None and (urlsplit(request.full_url).netloc != urlsplit(new_url).netloc
                                       or urlsplit(new_url).scheme != "https"):
            for field, _ in list(redirected.header_items()):
                if field.lower() in ("authorization", "cookie", "proxy-authorization"):
                    redirected.remove_header(field)
        return redirected


def get_json(url, token=None):
    headers = {"Accept": "application/vnd.github+json" if url.startswith(API) else "application/json",
               "User-Agent": "HS-C4-Operations/1"}
    if token:
        if not url.startswith(API + "/"):
            raise ValueError("GitHub token must remain on the repository API")
        headers["Authorization"] = "Bearer " + token
    try:
        opener = urllib.request.build_opener(SafeRedirect())
        with opener.open(urllib.request.Request(url, headers=headers), timeout=12) as response:
            body = response.read(20 * 1024 * 1024 + 1)
            if len(body) > 20 * 1024 * 1024:
                raise ValueError("monitor_response_too_large")
            return {"http": response.status, "body": json.loads(body)}
    except urllib.error.HTTPError as error:
        return {"http": error.code, "body": {}}
    except (OSError, ValueError):
        return {"http": None, "body": {}}


def content_json(response):
    try:
        return json.loads(base64.b64decode(response["body"]["content"]))
    except (KeyError, ValueError, TypeError):
        return {}


def artifact_at_ref(ref, token):
    response = get_json(API + "/contents/" + FILE + "?ref=" + ref, token)
    body = response.get("body", {})
    if isinstance(body, dict) and body.get("encoding") == "none":
        # Contents API omits content for files above 1 MB. Use the immutable
        # Git blob on the same authenticated API origin, never a download URL.
        sha = body.get("sha")
        if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha):
            return {}
        response = get_json(API + "/git/blobs/" + sha, token)
    return content_json(response)


def collect(token):
    if os.getenv("HS_OPS_RUNTIME_PROFILE") != "hobby-always-on":
        raise RuntimeError("MONITOR_PROFILE_NOT_APPROVED: backend probes require an always-on profile")
    evidence = {name: get_json(BACKEND + path) for name, path in (("health", "/healthz"), ("live", "/api/live-scores"))}
    evidence["public_artifact"] = get_json(SITE + FILE)["body"]
    evidence["repo_artifact"] = artifact_at_ref("main", token)
    commits = get_json(API + "/commits?path=" + FILE + "&per_page=1", token)["body"]
    evidence["artifact_commit_sha"] = commits[0].get("sha") if isinstance(commits, list) and commits else None
    deployments = get_json(API + "/deployments?environment=github-pages&per_page=10", token)["body"]
    if isinstance(deployments, list):
        for deployment in deployments:
            statuses = get_json(API + "/deployments/" + str(deployment["id"]) + "/statuses", token)["body"]
            if not isinstance(statuses, list) or not statuses or statuses[0].get("state") != "success":
                continue
            sha = deployment.get("sha")
            commit = evidence["artifact_commit_sha"]
            compare = get_json(API + "/compare/" + commit + "..." + sha, token)["body"] if commit and sha else {}
            evidence["pages"] = {"state": "success", "sha": sha,
                "commit_included": compare.get("status") in ("ahead", "identical")}
            evidence["deployed_artifact"] = artifact_at_ref(sha, token)
            break
    runs = get_json(API + "/actions/workflows/intraday-scheduler-watchdog.yml/runs?event=schedule&per_page=20", token)["body"]
    evidence["schedule_runs"] = runs.get("workflow_runs", []) if isinstance(runs, dict) else []
    return evidence


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", help="Local simulation evidence; no HTTP requests.")
    parser.add_argument("--now", help="Only allowed with --fixture.")
    parser.add_argument("--calendar-status", choices=("TRADING_DAY", "HOLIDAY", "UNKNOWN"))
    parser.add_argument("--fail-on-alert", action="store_true", help="Exit 2 for an external monitor's notification handler.")
    args = parser.parse_args()
    if (args.now or args.calendar_status) and not args.fixture:
        parser.error("Time/calendar overrides are simulation-only")
    now = datetime.fromisoformat(args.now) if args.now else datetime.now(TAIPEI)
    if args.fixture:
        with open(args.fixture, encoding="utf-8") as handle:
            evidence = json.load(handle)
        calendar = args.calendar_status or "UNKNOWN"
    else:
        evidence = collect(os.getenv("GH_TOKEN"))
        calendar = TradingCalendar().check(now.astimezone(TAIPEI).date()).status
    report = evaluate(evidence, now, calendar)
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    if args.fail_on_alert and report["alerts"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
