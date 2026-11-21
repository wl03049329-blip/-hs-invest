"""Bounded fresh public-source capture. No tokens, approvals, retries-on-402 or writes."""
from datetime import datetime
import json
import urllib.error
import urllib.request

import phase_l7_bridge as bridge
import phase_l7_daily as daily
import phase_l7_exact_recovery as exact


def transport(url):
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 HS-Forward-Shadow/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.status, response.read()


def refresh(root, now, *, request=transport, clock=None):
    """Return NEW raw receipts and unsigned draft. NEVER renew an old manifest.

    One request per TWSE/action endpoint; Yahoo gets at most three identical
    requests. Any required failure returns INCOMPLETE, never an empty payload.
    Newer completed sessions are probed separately, never added to recovery scope.
    """
    daily.require(now.tzinfo is not None, "EVIDENCE_CLOCK_REQUIRED")
    clock = clock or (lambda: datetime.now(daily.timezone.utc))
    evidence = {"captured_at": now.isoformat(), "receipts": [], "selected_yahoo_payload": None}
    errors = []

    def capture(name, url, coverage):
        received = clock()
        try:
            status, raw = request(url)
            daily.require(status == 200, "HTTP_" + str(status))
            payload = json.loads(raw.decode("utf-8-sig"))
            evidence["receipts"].append({"name": name, "source_url": url,
                "retrieved_at": received.isoformat(), "coverage": coverage, "http_status": status,
                "sha256": exact.sha(raw), "raw": raw})
            return payload
        except urllib.error.HTTPError as exc:
            errors.append({"source": name, "http_status": exc.code, "reason": "SOURCE_RESTRICTED_OR_UNAVAILABLE"})
        except Exception as exc:
            # Do not include credential-bearing exception URLs or payloads.
            errors.append({"source": name, "reason": type(exc).__name__})
        return None

    calendar = capture("twse-calendar", daily.CALENDAR_URL, {"year": now.astimezone(daily.TAIPEI).year})
    if calendar is None:
        return {"status": "EVIDENCE_INCOMPLETE", "errors": errors, "evidence": evidence, "draft": None}
    try:
        holidays = daily.calendar_days(calendar, now.astimezone(daily.TAIPEI).year)
        expected = daily.expected_day(now, holidays)
        daily.require(expected[:4] == exact.TARGET[:4] == str(now.astimezone(daily.TAIPEI).year),
                      "EXACT_CROSS_YEAR_REVIEW_REQUIRED")
    except Exception as exc:
        return {"status": "EVIDENCE_INCOMPLETE", "errors": [{"source": "calendar", "reason": str(exc)}],
                "evidence": evidence, "draft": None}
    official = []
    for month in daily.months_between(expected[:4] + "-01-01", expected):
        url = f"{daily.DAILY_URL}?response=json&date={month}01&stockNo=00631L"
        payload = capture("twse-" + month, url, {"month": month, "symbol": "00631L"})
        if payload is None:
            break
        try:
            official.extend(daily.parse_official(payload, month))
        except Exception as exc:
            errors.append({"source": "twse-" + month, "reason": str(exc)})
            break
    if errors:
        return {"status": "EVIDENCE_INCOMPLETE", "errors": errors, "evidence": evidence, "draft": None}
    start = int(datetime(2014, 10, 23, tzinfo=daily.TAIPEI).timestamp())
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/00631L.TW?period1={start}"
           f"&period2={int(now.timestamp())}&interval=1d&events=div%2Csplits")
    best_key = None
    for i in range(3):
        name = "yahoo-" + str(i + 1)
        payload = capture(name, url, {"start": "2014-10-23", "end": expected, "symbol": "00631L.TW"})
        if payload is None:
            continue
        try:
            key = daily.yahoo_candidate_key(payload, expected)
        except daily.Error as exc:
            if str(exc) in ("YAHOO_SOURCE_ERROR", "YAHOO_SCHEMA_ERROR", "YAHOO_ARRAY_LENGTH_MISMATCH"):
                continue
            return {"status": "EVIDENCE_INCOMPLETE", "errors": [{"source": name, "reason": str(exc)}],
                    "evidence": evidence, "draft": None}
        if best_key is None or key > best_key:
            best_key = key
            evidence["selected_yahoo_payload"] = name
    if best_key is None:
        return {"status": "EVIDENCE_INCOMPLETE", "errors": errors, "evidence": evidence, "draft": None}
    # Successful whole Yahoo payload can supersede transport errors within budget.
    errors = []
    for dataset in bridge.ACTION_DATASETS:
        symbol = "" if dataset == "TaiwanStockParValueChange" else "&data_id=00631L"
        url = f"{daily.ACTION_URL}?dataset={dataset}{symbol}&start_date={exact.ANCHOR}&end_date={exact.TARGET}"
        payload = capture(dataset, url, {"start": exact.ANCHOR, "end": exact.TARGET, "symbol": "00631L"})
        if payload is None or payload.get("status") != 200 or payload.get("msg") != "success" or not isinstance(payload.get("data"), list):
            errors.append({"source": dataset, "reason": "CORPORATE_ACTION_SOURCE_UNAVAILABLE"})
            break  # Never loop/retry 402 or fake an empty action response.
    if errors:
        return {"status": "EVIDENCE_INCOMPLETE", "errors": errors, "evidence": evidence, "draft": None}
    if expected > exact.TARGET:
        for dataset in bridge.ACTION_DATASETS:
            url = exact.scope.action_url(dataset,exact.ANCHOR,expected)
            payload = capture('post-'+dataset,url,{"start":exact.ANCHOR,"end":expected,"symbol":"00631L"})
            if payload is None or payload.get('status') != 200 or payload.get('msg') != 'success' or not isinstance(payload.get('data'),list):
                errors.append({'source':'post-'+dataset,'reason':'CORPORATE_ACTION_SOURCE_UNAVAILABLE'})
                break
        if errors:
            return {'status':'EVIDENCE_INCOMPLETE','errors':errors,'evidence':evidence,'draft':None}
    try:
        unsigned = exact.draft(root, evidence, clock())
    except Exception as exc:
        return {"status": "EVIDENCE_INCOMPLETE", "errors": [{"reason": str(exc)}], "evidence": evidence, "draft": None}
    return {"status": "FRESH_VALIDATED_UNSIGNED", "latest_completed_day": expected,
            "actual_latest_completed_session":expected,"recovery_target":exact.TARGET,
            "evidence": evidence, "draft": unsigned, "errors": []}
