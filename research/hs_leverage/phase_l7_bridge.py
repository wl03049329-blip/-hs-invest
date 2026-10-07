"""Bounded official factor-one continuity proof, never a V1 signal or score."""
from __future__ import annotations

import math
from datetime import date, timedelta

import phase_l7_shadow as shadow

MAX_SESSIONS = 10
ACTION_DATASETS = (
    "TaiwanStockDividendResult", "TaiwanStockSplitPrice",
    "TaiwanStockCapitalReductionReferencePrice", "TaiwanStockParValueChange",
)
APPROVED_BY = "USER_AUTHORIZED_REPAIR_2026-10-08"
AUTHORIZED_TARGET = "2026-10-07"
SOURCE_GAP_REASONS = {
    "MISSING_SOURCE_OHLC", "MISSING_ADJUSTED_CLOSE", "STALE_ADJUSTED_OHLC",
    "FALLBACK_ADJUSTMENT_UNRESOLVED", "FALLBACK_CURRENT_SOURCE_EVIDENCE_MISSING",
    "OFFICIAL_SESSION_CONTINUITY_FAIL",
}
REVIEW_STEPS = (
    "verified previous published anchor", "verified anchor factor one",
    "verified TWSE trading-session continuity", "verified TWSE OHLC",
    "verified Yahoo symbol/frequency/timezone", "verified no dividend",
    "verified no split", "verified no capital reduction", "verified no par-value change",
    "verified Yahoo/TWSE non-null field cross-check", "verified forward ledger hash chain",
    "verified outcomes ledger hash chain", "verified incident hash chain",
    "verified protected artifacts and provenance", "verified unchanged historical OHLC",
)


def prepare(root, prior, policy, yahoo, official, expected, holidays, now, fetcher, receipts):
    import phase_l7_daily as daily
    daily.require(prior is not None, "BRIDGE_PUBLISHED_ANCHOR_REQUIRED")
    anchor = daily.verified_previous_bar(root, prior, policy, official, expected, allow_gap=True)
    day = anchor["date"]
    daily.require(not isinstance(anchor["adjustment_factor"], bool) and anchor["adjustment_factor"] == 1,
                  "BRIDGE_ANCHOR_FACTOR_NOT_ONE")
    daily.require(anchor["source_provenance"]["integrity_status"] == "PASS", "BRIDGE_ANCHOR_UNVERIFIED")
    official_by_day = {r["date"]: r for r in official}
    daily.require(expected in official_by_day and day in official_by_day, "BRIDGE_OFFICIAL_SESSION_MISSING")
    daily.require(all(abs(anchor[k] - official_by_day[day][k]) <= .011 for k in daily.FIELDS),
                  "BRIDGE_ANCHOR_OHLC_CONFLICT")
    # A series of bridge-based anchors cannot silently reset the ten-session
    # limit each day. Only a fresh Yahoo reconciliation ends this bridge span.
    origin = anchor["source_provenance"].get("bridge_anchor_date", day)
    sessions, cursor = [], date.fromisoformat(origin) + timedelta(days=1)
    while cursor.isoformat() <= expected:
        if cursor.weekday() < 5 and cursor.isoformat() not in holidays:
            sessions.append(cursor.isoformat())
        cursor += timedelta(days=1)
    daily.require(len(sessions) <= MAX_SESSIONS, "BRIDGE_WINDOW_REVIEW_REQUIRED")
    daily.require(all(d in official_by_day for d in sessions), "BRIDGE_OFFICIAL_SESSION_MISSING")
    actions = {}
    for dataset in ACTION_DATASETS:
        symbol = "" if dataset == "TaiwanStockParValueChange" else "&data_id=00631L"
        payload = fetcher(f"{daily.ACTION_URL}?dataset={dataset}{symbol}&start_date={origin}&end_date={expected}")
        daily.require(payload.get("status") == 200 and payload.get("msg") == "success"
                      and isinstance(payload.get("data"), list), "CORPORATE_ACTION_SOURCE_UNAVAILABLE")
        for event in payload["data"]:
            daily.require(isinstance(event.get("stock_id"), str) and isinstance(event.get("date"), str),
                          "CORPORATE_ACTION_SCHEMA_REVIEW_REQUIRED")
            daily.require(date.fromisoformat(event["date"]).isoformat() == event["date"]
                          and origin <= event["date"] <= expected, "CORPORATE_ACTION_DATE_REVIEW_REQUIRED")
            daily.require(dataset == "TaiwanStockParValueChange" or event["stock_id"] == "00631L",
                          "CORPORATE_ACTION_SCHEMA_REVIEW_REQUIRED")
            daily.require(event["stock_id"] != "00631L", "CORPORATE_ACTION_REVIEW_REQUIRED")
        actions[dataset] = receipts[dataset] = daily.digest(payload)
    daily.yahoo_candidate_key(yahoo, expected)  # Same instrument/action validation as primary.
    result = yahoo["chart"]["result"][0]
    quote = result["indicators"]["quote"][0]
    adjusted = result["indicators"]["adjclose"][0]["adjclose"]
    by_day = {daily.datetime.fromtimestamp(stamp, daily.TAIPEI).date().isoformat(): i
              for i, stamp in enumerate(result["timestamp"])}
    bridge, checked = {}, []
    published_rows = {r["date"]: r for r in prior["item"]["rows"]}
    for session in sorted({day, *sessions}):
        raw, index = official_by_day[session], by_day.get(session)
        values = {k: (quote[k][index] if index is not None else None)
                  for k in (*daily.FIELDS, "volume")}
        values["adjclose"] = adjusted[index] if index is not None else None
        missing = [k for k, value in values.items() if value is None]
        for field, value in values.items():
            if value is None:
                continue
            daily.require(isinstance(value, (int, float)) and not isinstance(value, bool)
                          and math.isfinite(value) and value > 0, "BRIDGE_INVALID_PRIMARY_VALUE:" + session)
            if field == "volume":
                continue  # Valid volume discrepancies are provenance, not price conflicts.
            reference = raw["close"] if field == "adjclose" else raw[field]
            daily.require(abs(value - reference) <= .011, "BRIDGE_PRIMARY_CONFLICT:" + session + ":" + field)
        if values["close"] is not None and values["adjclose"] is not None:
            daily.require(math.isclose(values["adjclose"] / values["close"], 1, rel_tol=2e-5, abs_tol=2e-6),
                          "BRIDGE_NON_ONE_ADJUSTMENT:" + session)
        if missing:
            daily.require(index is None or values["close"] is None or values["adjclose"] is None,
                          "BRIDGE_UNSUPPORTED_PRIMARY_GAP:" + session)
            if session <= day:
                # Re-read exact already-published bridge bytes, never rebuild
                # a historical price from a new source or extend its authority.
                published = published_rows.get(session)
                provenance = published.get("source_provenance", {}) if published else {}
                daily.require(published is not None and published.get("adjustment_factor") == 1
                              and provenance.get("effective_source") == "TWSE_FACTOR_ONE_BRIDGE"
                              and provenance.get("integrity_status") == "PASS"
                              and provenance.get("bridge_anchor_date") == origin
                              and all(abs(published[k] - raw[k]) <= .011 for k in daily.FIELDS),
                              "BRIDGE_HISTORICAL_GAP_REVIEW_REQUIRED:" + session)
                bridge[session] = published
                checked.append({"date": session, "missing_primary_fields": missing,
                                "effective_source": "PUBLISHED_VERIFIED_BRIDGE"})
                continue
            source = {k: raw[k] for k in daily.FIELDS}
            bridge[session] = {"date": session, **source, "volume": raw["volume"],
                "raw_close": raw["close"], "provider_ohlc": source, "adjustment_factor": 1,
                "source_provenance": {"trading_date": session, "primary_source": "YAHOO",
                    "effective_source": "TWSE_FACTOR_ONE_BRIDGE", "raw_source": "TWSE",
                    "fallback_used": True, "fallback_reason": "PRIMARY_COMPLETED_SESSION_MISSING",
                    "adjustment_status": "VERIFIED_FACTOR_ONE_NO_ACTION",
                    "evidence_mode": "OFFICIAL_FACTOR_ONE_BRIDGE", "adjustment_factor": 1,
                    "bridge_anchor_date": origin, "verified_anchor_date": day,
                    "verified_commit": anchor["source_provenance"]["verified_commit"],
                    "yahoo_volume": values["volume"], "twse_volume": raw["volume"],
                    "volume_discrepancy": (values["volume"] != raw["volume"]
                                           if values["volume"] is not None else None),
                    "volume_difference": (raw["volume"] - values["volume"]
                                          if values["volume"] is not None else None),
                    "corporate_action_receipts_sha256": actions, "collected_at": now.isoformat(),
                    "integrity_status": "PASS"}}
        if session == day:
            continue  # Persisted anchor is evidence, never a replacement price.
        checked.append({"date": session, "missing_primary_fields": missing,
                        "effective_source": "TWSE_FACTOR_ONE_BRIDGE" if missing else "YAHOO"})
    proof = {"mode": "OFFICIAL_FACTOR_ONE_BRIDGE", "anchor_date": day,
             "bridge_anchor_date": origin, "target_date": expected, "maximum_sessions": MAX_SESSIONS,
             "verified_anchor_commit": anchor["source_provenance"]["verified_commit"],
             "verified_anchor_workflow_run_id": anchor["source_provenance"]["verified_workflow_run_id"],
             "corporate_action_receipts_sha256": actions, "sessions": checked,
             "bridge_sessions": sorted(bridge), "fresh_validation_at": now.isoformat()}
    return bridge, proof


def approved(records):
    return any(r.get("record_type") == "CORPORATE_ACTION_RECOVERY"
               and r.get("approved_by") == APPROVED_BY and r.get("recovery_mode") == "OFFICIAL_FACTOR_ONE_BRIDGE"
               and r.get("integrity_review_status") == "PASS" and r.get("new_data_version")
               and len(r.get("recovery_steps_completed", [])) >= 8 for r in records)


def needed(yahoo, prior, official, expected):
    """A fully restored primary goes back to normal Yahoo validation."""
    import phase_l7_daily as daily
    anchor = prior["item"]["rows"][-1]
    origin = anchor.get("source_provenance", {}).get("bridge_anchor_date", anchor["date"])
    result = yahoo["chart"]["result"][0]
    quote = result["indicators"]["quote"][0]
    adjusted = result["indicators"]["adjclose"][0]["adjclose"]
    by_day = {daily.datetime.fromtimestamp(s, daily.TAIPEI).date().isoformat(): i
              for i, s in enumerate(result["timestamp"])}
    for row in official:
        day = row["date"]
        if origin <= day <= expected:
            i = by_day.get(day)
            if i is None or adjusted[i] is None or any(quote[k][i] is None for k in (*daily.FIELDS, "volume")):
                return True
    return False


def verify_primary_factor_one(yahoo, prior, official, expected):
    import phase_l7_daily as daily
    result = yahoo["chart"]["result"][0]
    quote = result["indicators"]["quote"][0]
    adjusted = result["indicators"]["adjclose"][0]["adjclose"]
    anchor = prior["item"]["rows"][-1]["date"]
    by_day = {daily.datetime.fromtimestamp(s, daily.TAIPEI).date().isoformat(): i
              for i, s in enumerate(result["timestamp"])}
    for row in official:
        if anchor <= row["date"] <= expected:
            i = by_day.get(row["date"])
            daily.require(i is not None and isinstance(quote["close"][i], (float, int))
                          and quote["close"][i] > 0 and isinstance(adjusted[i], (float, int))
                          and math.isclose(adjusted[i] / quote["close"][i], 1, rel_tol=2e-5, abs_tol=2e-6),
                          "BRIDGE_NON_ONE_ADJUSTMENT:" + row["date"])


def review(root, policy, records, data, now, holidays):
    """Only a manually authorized invocation may call this after fresh collect."""
    import phase_l7_daily as daily
    import phase_l7_incidents as incidents
    daily.require(daily.os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch",
                  "RECOVERY_MANUAL_NON_DRY_DISPATCH_REQUIRED")
    daily.require(data["metadata"]["expected_completed_bar"] == AUTHORIZED_TARGET,
                  "RECOVERY_AUTHORIZATION_TARGET_MISMATCH")
    proof = data["metadata"].get("official_factor_one_bridge")
    daily.require(proof and proof["target_date"] == AUTHORIZED_TARGET
                  and proof["fresh_validation_at"] == now.isoformat(), "RECOVERY_FRESH_PROOF_REQUIRED")
    daily.require(shadow.validate_hash_chain(root / daily.INCIDENTS)["status"] == "PASS", "INCIDENT_HASH_CHAIN_INVALID")
    daily.validate_ledgers(root / policy["paths"]["forward_ledger"], root / policy["paths"]["outcomes_ledger"], policy)
    reviewed = {r.get("incident_id") for r in records if r.get("record_type") == "CORPORATE_ACTION_RECOVERY"
                and r.get("integrity_review_status") == "PASS" and r.get("approved_by")
                and r.get("new_data_version") and len(r.get("recovery_steps_completed", [])) >= 8}
    history = shadow.read_jsonl(root / daily.INCIDENTS)
    pending = [r for r in history if r.get("requires_integrity_review") is True
               and r["record_id"] not in reviewed]
    daily.require(not any(incidents.p0_reason(r["reason"]) for r in pending), "RECOVERY_PENDING_P0_REVIEW_REQUIRED")
    approvals = []
    for incident in pending:
        if incident["reason"].split(":", 1)[0] not in SOURCE_GAP_REASONS:
            continue  # No historical revision/action/OHLC conflict may be approved.
        target = incident.get("expected_completed_bar")
        if target is None:
            target = daily.expected_day(daily.datetime.fromisoformat(incident["checked_at"]), holidays)
        daily.require(target <= AUTHORIZED_TARGET and incident.get("latest_data_date", "9999") <= proof["anchor_date"],
                      "RECOVERY_INCIDENT_OUTSIDE_VERIFIED_SPAN")
        record = {"record_type": "CORPORATE_ACTION_RECOVERY",
            "record_id": "RECOVERY:" + daily.digest({"incident_id": incident["record_id"], "authorization": APPROVED_BY}),
            "incident_id": incident["record_id"], "reason": incident["reason"],
            "strategy_id": policy["strategy_id"], "integrity_review_status": "PASS", "approved_by": APPROVED_BY,
            "reviewed_at": now.isoformat(), "new_data_version": data["metadata"]["data_version"],
            "recovery_mode": "OFFICIAL_FACTOR_ONE_BRIDGE", "recovery_steps_completed": list(REVIEW_STEPS),
            "reviewed_evidence": {"bridge_proof": proof, "source_receipts_sha256": data["metadata"]["source_receipts_sha256"],
                                  "original_incident_record_hash": incident["record_hash"]},
            "historical_shadow_backfill": False, "live_capital": False, "production_signal": False,
            "capital_allocation_pct": 0}
        approvals.append(record)
    # Validate the entire eligible batch before the first append. Unknown/P0
    # records remain latched; any invalid source-gap scope prevents partial review.
    for record in approvals:
        shadow.append_record(root / policy["paths"]["forward_ledger"], record)
    return [r["incident_id"] for r in approvals]
