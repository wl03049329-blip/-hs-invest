"""Read-only historical target proof plus independent, non-publishable follow-on.

No clock substitution, source splicing, grants, ledger or snapshot writes.
Post-target sessions require complete PRIMARY evidence: no post-target bridge.
"""
import math
import copy
from datetime import date, timedelta

import phase_l7_bridge as bridge
import phase_l7_daily as daily


def actual_session(now, captured, calendar, anchor, target):
    year = now.astimezone(daily.TAIPEI).year
    # Current calendar/collector only attests one complete year. Do not guess a
    # cross-year historical calendar or silently drop its official sessions.
    daily.require(year == int(target[:4]) == captured.astimezone(daily.TAIPEI).year,
                  "EXACT_CROSS_YEAR_REVIEW_REQUIRED")
    holidays = daily.calendar_days(calendar, year)
    latest = daily.expected_day(now, holidays)
    daily.require(latest == daily.expected_day(captured, holidays), "EXACT_LATEST_SESSION_CHANGED_RECAPTURE")
    daily.require(anchor == "2026-10-13" and target == "2026-10-16" and target not in holidays
                  and date.fromisoformat(target).weekday() < 5 and latest >= target,
                  "EXACT_HISTORICAL_SCOPE_NOT_COMPLETED")
    return latest, holidays


def action_url(dataset, anchor, target):
    symbol = "" if dataset == "TaiwanStockParValueChange" else "&data_id=00631L"
    return f"{daily.ACTION_URL}?dataset={dataset}{symbol}&start_date={anchor}&end_date={target}"


def post_target(yahoo, official, holidays, read, raw_hashes, anchor, target, latest):
    if latest == target:
        return {"status": "NOT_REQUIRED", "actual_latest_completed_session": latest,
                "recovery_target": target, "sessions": [], "publication": "NOT_AUTHORIZED"}
    expected, cursor = [], date.fromisoformat(target) + timedelta(days=1)
    while cursor.isoformat() <= latest:
        if cursor.weekday() < 5 and cursor.isoformat() not in holidays:
            expected.append(cursor.isoformat())
        cursor += timedelta(days=1)
    observed = [r for r in official if target < r["date"] <= latest]
    daily.require(expected and [r["date"] for r in observed] == expected, "EXACT_POST_OFFICIAL_SESSION_MISSING")
    daily.validate_rows(official)
    # Checks instrument, frequency, actions, ordering and all parallel arrays.
    daily.yahoo_candidate_key(yahoo, latest)
    result = yahoo["chart"]["result"][0]
    quotes = result["indicators"]["quote"][0]
    adjusted = result["indicators"]["adjclose"][0]["adjclose"]
    indices = {daily.datetime.fromtimestamp(t, daily.TAIPEI).date().isoformat(): i
               for i,t in enumerate(result["timestamp"])}
    sessions = []
    previous = next((r for r in official if r['date'] == target),None)
    daily.require(previous is not None, 'EXACT_POST_OFFICIAL_ANCHOR_MISSING')
    for raw in observed:
        day = raw["date"]
        index = indices.get(day)
        daily.require(index is not None, "EXACT_POST_PRIMARY_MISSING:" + day)
        values = {k: quotes[k][index] for k in (*daily.FIELDS, "volume")}
        values["adjclose"] = adjusted[index]
        daily.require(all(isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v) and v > 0
                          for v in values.values()), "EXACT_POST_PRIMARY_INCOMPLETE:" + day)
        daily.require(daily.shadow.valid_bar({"date": day, **{k:values[k] for k in daily.FIELDS}}) is None,
                      "EXACT_POST_INVALID_BAR:" + day)
        daily.require(all(abs(values[k] - raw[k]) <= .011 for k in daily.FIELDS), "EXACT_POST_OHLC_CONFLICT:" + day)
        daily.require(math.isclose(values["adjclose"] / values["close"],1,rel_tol=2e-5,abs_tol=2e-6)
                      and abs(values["adjclose"] - raw["close"]) <= .011, "EXACT_POST_FACTOR_CONFLICT:" + day)
        daily.require(abs(raw['close'] / previous['close'] - 1) <= .205, 'EXACT_POST_PRICE_DISCONTINUITY:' + day)
        previous = raw
        sessions.append({"date":day,"source":"YAHOO_PRIMARY_CROSSCHECKED_TWSE", "factor":1,
                         "yahoo_volume":values["volume"],"twse_volume":raw["volume"]})
    actions = {}
    for dataset in bridge.ACTION_DATASETS:
        name = "post-" + dataset
        url = action_url(dataset,anchor,latest)
        payload = read(url)
        daily.require(name in raw_hashes and payload.get("status") == 200 and payload.get("msg") == "success"
                      and isinstance(payload.get("data"),list), "EXACT_POST_ACTION_EVIDENCE_INCOMPLETE")
        for event in payload["data"]:
            daily.require(isinstance(event.get("stock_id"),str) and isinstance(event.get("date"),str),
                          "EXACT_POST_ACTION_SCHEMA")
            day = date.fromisoformat(event["date"]).isoformat()
            daily.require(anchor <= day <= latest and (dataset == "TaiwanStockParValueChange"
                          or event["stock_id"] == "00631L"), "EXACT_POST_ACTION_SCOPE")
            daily.require(event["stock_id"] != "00631L", "EXACT_POST_CORPORATE_ACTION_CONFLICT")
        actions[dataset] = {"source_url":url, "raw_sha256":raw_hashes[name], "payload_sha256":daily.digest(payload)}
    return {"status":"PASS", "actual_latest_completed_session":latest, "recovery_target":target,
            "sessions":sessions, "corporate_actions":actions, "publication":"NOT_AUTHORIZED"}


def candidate(historical, prior, policy, captured, latest, holidays, read, raw_hashes, root, anchor, target):
    official = []
    for month in daily.months_between(target[:4] + "-01-01",latest):
        payload = read(f"{daily.DAILY_URL}?response=json&date={month}01&stockNo=00631L")
        official.extend(r for r in daily.parse_official(payload,month) if r["date"] <= latest)
    daily.validate_rows(official)
    start = int(daily.datetime(2014,10,23,tzinfo=daily.TAIPEI).timestamp())
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/00631L.TW?period1={start}"
           f"&period2={int(captured.timestamp())}&interval=1d&events=div%2Csplits")
    yahoo = read(url)  # Same single selected whole payload for BOTH validations.
    follow_on = post_target(yahoo,official,holidays,read,raw_hashes,anchor,target,latest)
    data, _ = daily._validated_session(historical,prior,policy,captured,target,read(daily.CALENDAR_URL),holidays,
                                      read,root,True,True,{"SOURCE_COLLECTION":"FAILED"})
    # Independent post sessions cannot conceal historical revisions. Above uses
    # the existing overlap/factor/continuity/P0 guards through target, unchanged.
    daily.require(data["item"]["rows"][-1]["date"] == target and
                  all(r["date"] <= target for r in data["item"]["rows"]), "EXACT_CANDIDATE_OUTSIDE_TARGET")
    daily.require(next(r for r in data["item"]["rows"] if r["date"] == anchor) == prior["item"]["rows"][-1],
                  "EXACT_ANCHOR_BYTES_CHANGED")
    before = {r['date']:r for r in prior['item']['rows']}
    for row in data['item']['rows']:
        old = before.get(row['date'])
        if old:
            daily.require(all(old[k] == row[k] for k in (*daily.FIELDS,'adjustment_factor')),
                          'EXACT_HISTORICAL_PRICE_MUTATION')
    # Retain ALL persisted rows verbatim (including volume/source provenance),
    # after checking current source prices/factors. Append only 10/14..10/16.
    data['item']['rows'] = [copy.deepcopy(before.get(r['date'],r)) for r in data['item']['rows']]
    data['metadata']['data_version'] = 'adjusted_daily_v1:' + daily.digest([
        {k:v for k,v in r.items() if k != 'source_provenance'} for r in data['item']['rows']])
    data["metadata"]["historical_recovery"] = {"anchor_date":anchor,"recovery_target":target,
        "actual_latest_completed_session":latest,"post_target_validation_sha256":daily.digest(follow_on),
        "scope":"HISTORICAL_PRICES_ONLY_NO_SIGNAL_BACKFILL"}
    return data, follow_on
