"""Historical exact reviews need external trust AND an attested published tree.

Expired manifests never authorize a new execution. A completed, individually
approved review remains valid for its original incident/hash only. Nothing in
the repository can populate this external trust store automatically.
"""
import json
import os
import subprocess
from datetime import datetime
from pathlib import Path

import phase_l7_exact_recovery as exact
import phase_l7_shadow as shadow


def require(value, reason):
    if not value:
        raise shadow.IntegrityError(reason)


def _ids(root, records, config, *, test_only=False):
    import phase_l7_daily as daily
    mode = "TEST_ONLY" if test_only else "PRODUCTION"
    envelope, pins, registry, receipt = (config[k] for k in ("envelope", "pins", "registry", "receipt"))
    body = envelope["contract"]
    require(isinstance(envelope.get("authorization_id"), str)
            and (envelope["authorization_id"].startswith("TEST_ONLY:") if test_only else
                 not envelope["authorization_id"].startswith("TEST_ONLY:")), "REVIEW_READER_AUTHORIZATION_INVALID")
    require(envelope.get("environment") == registry.get("environment") == receipt.get("environment") == mode,
            "REVIEW_READER_TEST_CREDENTIALS_FORBIDDEN")
    require(envelope.get("status") == ("TEST_ONLY_APPROVED" if test_only else "APPROVED"), "REVIEW_READER_UNSIGNED")
    require(body.get("schema") == exact.SCHEMA and body.get("recovery_target") == exact.TARGET
            and body.get("anchor_date") == exact.ANCHOR, "REVIEW_READER_SCOPE_MISMATCH")
    require(pins.get("envelope_sha256") == daily.digest(envelope)
            and pins.get("authorization_id") == registry.get("authorization_id") == envelope.get("authorization_id")
            and registry.get("approved_contract_sha256") == daily.digest(body), "REVIEW_READER_PINS_INVALID")
    require(config.get("verified_receipt_sha256") == daily.digest(receipt)
            and receipt.get("contract_sha256") == daily.digest(body)
            and receipt.get("stages") == {s: "PASS" for s in ("PREPARE", "VALIDATE", "APPROVE", "COMMIT", "PUBLISH", "VERIFY")},
            "REVIEW_READER_COMPLETION_NOT_EXTERNALLY_ATTESTED")
    completed = exact.stamp(receipt["verified_at"])
    require(exact.stamp(body["captured_at"]) <= completed <= exact.stamp(body["expires_at"]),
            "REVIEW_READER_EXECUTION_WAS_EXPIRED")
    require(exact.stamp(body["expires_at"]) - exact.stamp(body["captured_at"]) <= exact.MAX_AGE
            and completed.astimezone(daily.TAIPEI).date() == exact.stamp(body["captured_at"]).astimezone(daily.TAIPEI).date()
            and body.get("constraints", {}).get("max_bridge_sessions") == 10, "REVIEW_READER_EXPIRED_SCOPE_EXTENDED")
    approvals, items = envelope.get("approvals", []), body.get("items", [])
    require(len(approvals) == len(items) == 7 and len({a["approval_id"] for a in approvals}) == 7
            and len({a["incident_id"] for a in approvals}) == len({i["incident_id"] for i in items}) == 7,
            "REVIEW_READER_SEVEN_APPROVALS_REQUIRED")
    require(set(pins.get("individual", {})) == {a["approval_id"] for a in approvals}, "REVIEW_READER_INDIVIDUAL_PINS")
    root = Path(root)
    policy, _ = shadow.load_context(root)
    for relative in (daily.INCIDENTS, *policy["paths"].values()):
        require(shadow.validate_hash_chain(root / relative)["status"] == "PASS", "REVIEW_READER_CHAIN_INVALID")
    incidents = {i["record_id"]: i for i in shadow.read_jsonl(root / daily.INCIDENTS)}
    selected = [r for r in records if r.get("recovery_mode") == exact.SCHEMA
                and r.get("authorization_id") == envelope["authorization_id"]]
    require(len(selected) == 7, "REVIEW_READER_COMPLETE_BATCH_REQUIRED")
    ids = set()
    for item in items:
        original = incidents.get(item["incident_id"])
        require(original and original["record_hash"] == item["record_hash"]
                and original["reason"] == item["reason"] == exact.REASON
                and original.get("expected_completed_bar") == item["expected_target"]
                and exact.ANCHOR <= item["expected_target"] <= exact.TARGET and item.get("p0") is False,
                "REVIEW_READER_INCIDENT_MISMATCH")
        matches = [a for a in approvals if a["incident_id"] == item["incident_id"]]
        require(len(matches) == 1, "REVIEW_READER_MISSING_INDIVIDUAL_APPROVAL")
        approval = matches[0]
        require(pins["individual"].get(approval["approval_id"]) == daily.digest(approval)
                and approval.get("item_sha256") == daily.digest(item)
                and approval.get("contract_sha256") == daily.digest(body)
                and approval.get("authorization_id") == envelope["authorization_id"]
                and approval.get("recovery_target") == exact.TARGET
                and approval.get("test_only") is test_only,
                "REVIEW_READER_APPROVAL_SCOPE_MISMATCH")
        import phase_l7_bridge as bridge
        require(approval.get("approved_by") in registry.get("approved_principals", [])
                and approval["approved_by"] != bridge.APPROVED_BY
                and envelope["authorization_id"] != bridge.APPROVED_BY
                and (approval["approved_by"].startswith("TEST_ONLY:") if test_only else
                     not approval["approved_by"].startswith("TEST_ONLY:")), "REVIEW_READER_PRINCIPAL_INVALID")
        require(exact.stamp(body["captured_at"]) <= exact.stamp(approval["approved_at"]) <= completed,
                "REVIEW_READER_APPROVAL_TIME_INVALID")
        expected_id = "EXACT_RECOVERY:" + daily.digest({"contract": body, "incident": item})
        rows = [r for r in selected if r["record_id"] == expected_id]
        require(len(rows) == 1, "REVIEW_READER_RECOVERY_RECORD_MISSING")
        record = rows[0]
        expected = {"record_type": "CORPORATE_ACTION_RECOVERY", "incident_id": item["incident_id"],
            "strategy_id": policy["strategy_id"],
            "original_incident_record_hash": item["record_hash"], "reason": item["reason"],
            "integrity_review_status": "PASS", "approved_by": approval["approved_by"],
            "reviewed_at": approval["approved_at"], "approval_id": approval["approval_id"],
            "approval_sha256": daily.digest(approval), "contract_sha256": daily.digest(body),
            "new_data_version": body["candidate_data_version"], "recovery_target": exact.TARGET,
            "test_only": test_only, "historical_shadow_backfill": False, "live_capital": False,
            "production_signal": False, "capital_allocation_pct": 0}
        require(all(record.get(k) == v for k, v in expected.items())
                and record.get("test_only") is test_only and record.get("live_capital") is False
                and record.get("production_signal") is False
                and record.get("recovery_steps_completed") == list(bridge.REVIEW_STEPS), "REVIEW_READER_RECORD_MISMATCH")
        ids.add(item["incident_id"])
    # Git is independent of the mutable working tree / JSON receipt.
    def git(*args):
        return subprocess.check_output(["git", "-C", str(root), *args], stderr=subprocess.DEVNULL)
    commit = receipt["git_commit"]
    require(len(commit) == 40 and all(c in "0123456789abcdef" for c in commit), "REVIEW_READER_GIT_SHA_INVALID")
    require(git("show", "-s", "--format=%an <%ae>", commit).decode().strip() ==
            "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>", "REVIEW_READER_NOT_BOT_PUBLICATION")
    require(git("show", "-s", "--format=%P", commit).decode().strip() == body["base_git_sha"], "REVIEW_READER_BASE_CHANGED")
    git("merge-base", "--is-ancestor", commit, "HEAD")
    paths = exact.formal_paths(policy)
    require(set(receipt["files_sha256"]) == set(paths), "REVIEW_READER_SIX_FILE_ATTESTATION_REQUIRED")
    for p in paths:
        require(exact.sha(git("show", commit + ":" + p)) == receipt["files_sha256"][p], "REVIEW_READER_PUBLISHED_BLOB_MISMATCH")
    published = json.loads(git("show", commit + ":" + daily.SNAPSHOT))
    require(daily.digest(published) == body["candidate_sha256"]
            and published["metadata"]["data_version"] == body["candidate_data_version"], "REVIEW_READER_PRICE_VERSION_MISMATCH")
    published_status = json.loads(git("show", commit + ":" + daily.STATUS))
    require(str(published_status.get("workflow_run_id")) == str(registry.get("execution", {}).get("workflow_run_id"))
            and published_status.get("data_integrity") == "PASS"
            and published_status.get("latest_data_date") == exact.TARGET, "REVIEW_READER_RUN_RECEIPT_MISMATCH")
    published_records = [json.loads(line) for line in git("show", commit + ":" + policy["paths"]["forward_ledger"]).splitlines()]
    require(all(r in published_records for r in selected), "REVIEW_READER_RECORD_NOT_PUBLISHED")
    return ids


def reviewed_ids(root, records, trust=None):
    if not any(r.get("recovery_mode") == exact.SCHEMA and not r.get("test_only") for r in records):
        return set()
    if trust is None:
        raw = os.environ.get("HS_EXACT_REVIEWED_AUTHORIZATIONS_JSON", "")
        if not raw:
            return set()  # Existing Daily remains unchanged; new records stay latched.
        try:
            trust = json.loads(raw)
        except ValueError as exc:
            raise shadow.IntegrityError("REVIEW_READER_EXTERNAL_TRUST_INVALID") from exc
    reviewed = set()
    for config in trust.get("authorizations", []):
        ids = _ids(root, records, config)
        require(not reviewed.intersection(ids), "REVIEW_READER_DUPLICATE_AUTHORIZATION")
        reviewed.update(ids)
    return reviewed
