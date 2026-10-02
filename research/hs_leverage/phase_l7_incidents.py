"""Operational notification identity only; never accepts prices or clears review."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime

MISSING_ADJUSTMENT = {
    "MISSING_SOURCE_OHLC", "MISSING_ADJUSTED_CLOSE", "STALE_ADJUSTED_OHLC",
    "FALLBACK_ADJUSTMENT_UNRESOLVED",
}
DEDUPABLE = MISSING_ADJUSTMENT | {
    "SOURCE_SCHEMA_CHANGED",
    "FALLBACK_CURRENT_SOURCE_UNAVAILABLE", "LATEST_OFFICIAL_BAR_UNAVAILABLE",
}
WARNING = """## ⚠️ 00631L DATA PIPELINE REMAINS FAIL_CLOSED

Known unresolved incident detected.
No new incident created.
No adjusted data accepted.
No ledger observation created.
No snapshot promoted.
Integrity review is still required.

Workflow success only means:
duplicate failure notification suppressed.
It DOES NOT mean the 00631L data pipeline is healthy.
"""


def normalized_reason(reason):
    root = reason.split(":", 1)[0]
    return "FALLBACK_ADJUSTMENT_UNRESOLVED" if root in MISSING_ADJUSTMENT else root


def p0_reason(reason):
    return any(marker in reason for marker in (
        "PROTECTED_ARTIFACT", "PROVENANCE", "HASH_CHAIN", "FROZEN_FORMULA",
        "THRESHOLD_INTEGRITY", "LEDGER_SCHEMA"))


def identity(target, reason, anchor, policy):
    root = normalized_reason(reason)
    return {
        "target_completed_trading_date": target,
        "normalized_root_cause": root,
        "latest_verified_anchor_date": anchor,
        "source_failure_class": ("YAHOO_ADJUSTED_EVIDENCE_MISSING"
                                 if root == "FALLBACK_ADJUSTMENT_UNRESOLVED" else root),
        "policy_version": policy["policy_id"] + ":" + policy["strategy_version"] + ":" + policy["threshold"]["threshold_version"],
    }


def fingerprint(context, evidence):
    # Explicit allowlist: no run ID, request time or provider metadata.
    value = {**context, "stable_evidence": evidence}
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     allow_nan=False).encode()).hexdigest()


def classify(context, evidence, incidents, reviewed, expected_day, holidays,
             recovery=False, legacy_progress=False):
    root = context["normalized_root_cause"]
    eligible = bool(context["target_completed_trading_date"]) and root in {
        normalized_reason(x) for x in DEDUPABLE}
    key = fingerprint(context, evidence)
    candidates = []
    for record in incidents:
        if record["record_id"] in reviewed:
            continue
        previous = record.get("incident_identity")
        if previous is None and record.get("requires_integrity_review"):
            # Old records have no target field. Resolve their capture time with
            # the SAME official calendar, never use the calendar-day record ID.
            try:
                checked = datetime.fromisoformat(record["checked_at"])
                if checked.tzinfo is None or checked.year != int(context["target_completed_trading_date"][:4]):
                    continue
                previous = {**context, "target_completed_trading_date": expected_day(checked, holidays),
                            "normalized_root_cause": normalized_reason(record["reason"]),
                            "latest_verified_anchor_date": record.get("latest_data_date")}
                previous["source_failure_class"] = ("YAHOO_ADJUSTED_EVIDENCE_MISSING"
                    if previous["normalized_root_cause"] == "FALLBACK_ADJUSTMENT_UNRESOLVED"
                    else previous["normalized_root_cause"])
            except (KeyError, TypeError, ValueError):
                continue
        if previous == context:
            candidates.append(record)
    if eligible:
        for record in reversed(candidates):
            if record.get("incident_fingerprint") == key:
                return "KNOWN_FAIL_CLOSED_DEDUPED", key
        # Legacy failures did not preserve per-field source evidence. Once a
        # structured probe exists it is authoritative; an older legacy record
        # must never suppress a newly changed evidence signature.
        if candidates and not any(r.get("incident_fingerprint") for r in candidates) and not recovery and not legacy_progress:
            return "KNOWN_FAIL_CLOSED_DEDUPED", key
    if recovery:
        return "RECOVERY_EVIDENCE_AVAILABLE", key
    if eligible and candidates:
        return "RECOVERY_EVIDENCE_CHANGED", key
    return "NEW_FAIL_CLOSED", key


def exit_code(status):
    return 0 if status.get("workflow_classification") == "KNOWN_FAIL_CLOSED_DEDUPED" else (
        2 if status.get("status") == "FAIL_CLOSED" else 0)
