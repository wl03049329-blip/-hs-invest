"""Exact-scope recovery planner. No CLI, network, production writes or grants.

Production approval pins must be supplied by a separately authorized operator,
not read from the manifest. TEST_ONLY can only enter the simulation function.
The simulated publisher commits ONE generation bundle atomically: never seven
independent append operations, or a price write before a ledger commit.
Wiring a generation into legacy production paths is intentionally not exposed.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

import phase_l7_bridge as bridge
import phase_l7_daily as daily
import phase_l7_shadow as shadow

TARGET = "2026-10-16"
ANCHOR = "2026-10-13"
SCHEMA = "EXACT_SCOPE_RECOVERY_V1"
MAX_AGE = timedelta(hours=6)
REASON = "BRIDGE_HISTORICAL_GAP_REVIEW_REQUIRED:2026-10-13"


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def stamp(value):
    result = datetime.fromisoformat(value)
    daily.require(result.tzinfo is not None, "EXACT_TIMEZONE_REQUIRED")
    return result


def formal_paths(policy):
    return [daily.SNAPSHOT, daily.STATUS, daily.INCIDENTS,
            "00631l-leverage-status-v1.json", *policy["paths"].values()]


def context(root, evidence, now):
    """Revalidate actual bytes and run unchanged collector; no asserted PASS trusted."""
    root = Path(root)
    daily.require(now.tzinfo is not None, "EXACT_TIMEZONE_REQUIRED")
    policy, historical = shadow.load_context(root)
    records, outcomes = daily.validate_ledgers(root / policy["paths"]["forward_ledger"],
                                              root / policy["paths"]["outcomes_ledger"], policy)
    daily.require(shadow.validate_hash_chain(root / daily.INCIDENTS)["status"] == "PASS",
                  "INCIDENT_HASH_CHAIN_INVALID")
    prior = shadow.read_json(root / daily.SNAPSHOT)
    daily.require(prior["item"]["rows"][-1]["date"] == ANCHOR, "EXACT_BASE_ANCHOR_MISMATCH")
    captured = stamp(evidence["captured_at"])
    daily.require(timedelta(0) <= now - captured <= MAX_AGE
                  and now.astimezone(daily.TAIPEI).date() == captured.astimezone(daily.TAIPEI).date(),
                  "EXACT_EVIDENCE_EXPIRED")
    cache, receipts = {}, []
    for entry in evidence["receipts"]:
        retrieved = stamp(entry["retrieved_at"])
        daily.require(timedelta(0) <= now - retrieved <= MAX_AGE, "EXACT_EVIDENCE_EXPIRED")
        daily.require(entry["http_status"] == 200 and sha(entry["raw"]) == entry["sha256"],
                      "EXACT_EVIDENCE_SHA_OR_HTTP_MISMATCH")
        payload = json.loads(entry["raw"].decode("utf-8-sig"))
        url = entry["source_url"]
        if not entry["name"].startswith("yahoo-") or entry["name"] == evidence["selected_yahoo_payload"]:
            daily.require(url not in cache, "EXACT_DUPLICATE_SOURCE")
            cache[url] = payload
        receipts.append({k: entry[k] for k in ("name", "source_url", "retrieved_at", "coverage", "sha256")})
    names = [r["name"] for r in receipts]
    daily.require(len(names) == len(set(names)), "EXACT_DUPLICATE_EVIDENCE")

    def read(url):
        daily.require(url in cache, "EXACT_REQUIRED_FRESH_SOURCE_MISSING")
        return copy.deepcopy(cache[url])

    holidays = daily.calendar_days(read(daily.CALENDAR_URL), now.astimezone(daily.TAIPEI).year)
    daily.require(daily.expected_day(now, holidays) == TARGET, "EXACT_CURRENT_TARGET_OUTSIDE_SCOPE")
    candidate, _ = daily.collect(historical, prior, policy, captured, fetcher=read,
                                 root=root, allow_official_bridge=True, bridge_review_required=True)
    daily.require(candidate["metadata"]["expected_completed_bar"] == TARGET, "EXACT_TARGET_MISMATCH")
    by_day = {r["date"]: r for r in candidate["item"]["rows"]}
    for old in prior["item"]["rows"]:
        daily.require(all(old[k] == by_day[old["date"]][k] for k in (*daily.FIELDS, "adjustment_factor")),
                      "EXACT_HISTORICAL_PRICE_MUTATION")
    # Do not treat generic old recovery records as approvals for this contract.
    history = shadow.read_jsonl(root / daily.INCIDENTS)
    pending = daily.pending_integrity_reviews(root, records)
    daily.require(len(pending) == 7, "EXACT_SEVEN_PENDING_REQUIRED")
    for incident in pending:
        daily.require(not bridge.integrity_conflict(incident["reason"]), "EXACT_PENDING_P0_OR_CONFLICT")
        daily.require(incident["reason"] == REASON and incident.get("latest_data_date") == ANCHOR
                      and ANCHOR <= incident["expected_completed_bar"] <= TARGET, "EXACT_INCIDENT_SCOPE_MISMATCH")
    daily.require(all(not daily.incidents.p0_reason(i["reason"]) for i in history
                      if i in pending), "EXACT_PENDING_P0")
    proof = candidate["metadata"]["official_factor_one_bridge"]
    body = {"schema": SCHEMA, "recovery_target": TARGET, "anchor_date": ANCHOR,
            "base_git_sha": daily.subprocess.check_output(
                ["git", "-C", str(root), "rev-parse", "HEAD"]).decode().strip(),
            "validator_sha256": {Path(module.__file__).name: shadow.sha(Path(module.__file__))
                                 for module in (daily, bridge, shadow, daily.incidents)},
            "contract_implementation_sha256": shadow.sha(Path(__file__)),
            "adapter_implementation_sha256": {
                name: shadow.sha(Path(__file__).with_name(name)) for name in
                ("phase_l7_recovery_adapter.py", "phase_l7_recovery_evidence.py", "phase_l7_recovery_reader.py",
                 "phase_l7_recovery_github.py", "phase_l7_recovery_workflow.py", "build_frontend_status.py")},
            "workflow_sha256": {relative: shadow.sha(Path(__file__).resolve().parents[2] / relative) for relative in
                                (".github/workflows/00631l-forward-shadow.yml", ".github/workflows/00631l-exact-recovery.yml")},
            "anchor_publication_sha": proof["verified_anchor_commit"],
            "anchor_workflow_run_id": proof["verified_anchor_workflow_run_id"],
            "anchor_blob_sha256": shadow.sha(root / daily.SNAPSHOT),
            "candidate_data_version": candidate["metadata"]["data_version"],
            "candidate_sha256": daily.digest(candidate), "captured_at": evidence["captured_at"],
            "expires_at": min(captured + MAX_AGE,
                              datetime.combine(captured.astimezone(daily.TAIPEI).date() + timedelta(days=1),
                                               daily.day_time(0), daily.TAIPEI)).isoformat(),
            "evidence": sorted(receipts, key=lambda e: e["name"]),
            "baseline_sha256": {p: shadow.sha(root / p) if (root / p).exists() else sha(b"")
                                for p in formal_paths(policy)},
            "items": sorted([{"incident_id": i["record_id"], "record_hash": i["record_hash"],
                              "reason": i["reason"], "p0": False, "expected_target": i["expected_completed_bar"],
                              "event_time": i["checked_at"]} for i in pending], key=lambda i: i["incident_id"]),
            "constraints": {"max_bridge_sessions": 10, "no_future_targets": True,
                            "max_evidence_age_seconds": 21600, "same_taipei_calendar_day_required": True,
                            "no_signal_backfill": True, "no_live_capital": True,
                            "no_historical_price_mutation": True, "all_seven_individual_approvals": True}}
    return body, candidate, policy, records, outcomes


def draft(root, evidence, now):
    body, *_ = context(root, evidence, now)
    return {"contract": body, "authorization_id": None, "environment": "PRODUCTION",
            "approvals": [], "status": "UNSIGNED_NON_EXECUTABLE"}


def _plan(root, envelope, evidence, now, trusted_pins, test_only):
    body, candidate, policy, records, outcomes = context(root, evidence, now)
    daily.require(envelope["contract"] == body, "EXACT_CONTRACT_ACTUAL_DATA_MISMATCH")
    mode = "TEST_ONLY" if test_only else "PRODUCTION"
    daily.require(envelope.get("environment") == mode, "EXACT_TEST_APPROVAL_FORBIDDEN")
    daily.require(envelope.get("status") == ("TEST_ONLY_APPROVED" if test_only else "APPROVED"),
                  "EXACT_EXPLICIT_APPROVAL_REQUIRED")
    authorization = envelope.get("authorization_id")
    daily.require(isinstance(authorization, str) and authorization
                  and authorization != bridge.APPROVED_BY, "EXACT_NEW_AUTHORIZATION_REQUIRED")
    daily.require((authorization.startswith("TEST_ONLY:") if test_only else not authorization.startswith("TEST_ONLY:")),
                  "EXACT_TEST_APPROVAL_FORBIDDEN")
    approvals = envelope.get("approvals", [])
    daily.require(len(approvals) == 7 and len({a["incident_id"] for a in approvals}) == 7
                  and len({a["approval_id"] for a in approvals}) == 7, "EXACT_SEVEN_UNIQUE_APPROVALS_REQUIRED")
    # Trust is out-of-band. A self-declared authorized:true or manifest file grants nothing.
    daily.require(trusted_pins and trusted_pins.get("envelope_sha256") == daily.digest(envelope)
                  and trusted_pins.get("authorization_id") == authorization, "EXACT_EXTERNAL_APPROVAL_PINS_REQUIRED")
    daily.require(set(trusted_pins.get("individual", {})) == {a["approval_id"] for a in approvals},
                  "EXACT_APPROVAL_PIN_SCOPE_MISMATCH")
    additions = []
    for item in body["items"]:
        matches = [a for a in approvals if a["incident_id"] == item["incident_id"]]
        daily.require(len(matches) == 1, "EXACT_INDIVIDUAL_APPROVAL_MISSING")
        approval = matches[0]
        approved = stamp(approval["approved_at"])
        daily.require(stamp(body["captured_at"]) <= approved <= now, "EXACT_APPROVAL_TIME_INVALID")
        daily.require(approval.get("authorization_id") == authorization
                      and approval.get("contract_sha256") == daily.digest(body)
                      and approval.get("item_sha256") == daily.digest(item)
                      and approval.get("recovery_target") == TARGET
                      and approval.get("test_only") is test_only, "EXACT_APPROVAL_SCOPE_MISMATCH")
        who = approval.get("approved_by", "")
        daily.require(isinstance(who, str) and who and who != bridge.APPROVED_BY
                      and (who.startswith("TEST_ONLY:") if test_only else not who.startswith("TEST_ONLY:")),
                      "EXACT_APPROVER_INVALID")
        daily.require(trusted_pins.get("individual", {}).get(approval["approval_id"]) == daily.digest(approval),
                      "EXACT_INDIVIDUAL_APPROVAL_PIN_MISMATCH")
        additions.append({"record_type": "CORPORATE_ACTION_RECOVERY",
            "record_id": "EXACT_RECOVERY:" + daily.digest({"contract": body, "incident": item}),
            "incident_id": item["incident_id"], "original_incident_record_hash": item["record_hash"],
            "reason": item["reason"], "strategy_id": policy["strategy_id"], "integrity_review_status": "PASS",
            "approved_by": who, "reviewed_at": approval["approved_at"], "authorization_id": authorization,
            "approval_id": approval["approval_id"], "approval_sha256": daily.digest(approval),
            "contract_sha256": daily.digest(body), "recovery_mode": SCHEMA, "test_only": test_only,
            "new_data_version": body["candidate_data_version"], "recovery_target": TARGET,
            "recovery_steps_completed": list(bridge.REVIEW_STEPS), "historical_shadow_backfill": False,
            "live_capital": False, "production_signal": False, "capital_allocation_pct": 0})
    ledger = Path(root) / policy["paths"]["forward_ledger"]
    ledger_bytes = ledger.read_bytes() if ledger.exists() else b""
    daily.require(not ledger_bytes or ledger_bytes.endswith(b"\n"), "EXACT_LEDGER_NEWLINE_REQUIRED")
    head = shadow.validate_hash_chain(ledger)["head_hash"]
    for record in additions:
        record["previous_record_hash"] = head
        record["record_hash"] = shadow.payload_hash(record, head)
        head = record["record_hash"]
    output = {"schema": SCHEMA, "environment": mode, "contract": body,
              "forward_ledger": ledger_bytes.decode() + "".join(shadow.canonical(a) + "\n" for a in additions),
              "incident_ledger": (Path(root) / daily.INCIDENTS).read_text(encoding="utf8"),
              "outcome_ledger": (Path(root) / policy["paths"]["outcomes_ledger"]).read_text(encoding="utf8")
                  if (Path(root) / policy["paths"]["outcomes_ledger"]).exists() else "",
              "candidate": candidate, "recovery_records": additions,
              "status": {"status": "NO_CURRENT_COMPLETED_SESSION_NO_BACKFILL", "data_integrity": "PASS",
                         "latest_data_date": TARGET, "expected_completed_bar": TARGET,
                         "dry_run": False, "checked_at": body["captured_at"],
                         "data_version": body["candidate_data_version"],
                         "workflow_run_id": None, **daily.summarize(records, outcomes)}}
    return output


def production_plan(root, envelope, evidence, now, trusted_pins=None):
    """Read-only, deny-by-default formal gate. TEST_ONLY is never accepted."""
    daily.require(envelope.get("environment") == "PRODUCTION", "EXACT_TEST_APPROVAL_FORBIDDEN")
    daily.require(now.tzinfo is not None and abs((datetime.now(daily.timezone.utc) - now).total_seconds()) <= 30,
                  "EXACT_PRODUCTION_WALL_CLOCK_REQUIRED")
    return _plan(root, envelope, evidence, now, trusted_pins, False)


def simulate(root, envelope, evidence, now, trusted_test_pins, output_directory, interrupt=None):
    """TEST_ONLY atomic generation; NEVER changes root/legacy production paths.

    On interruption the committed bundle is either absent or wholly valid.
    Retrying identical evidence/approval is a no-op. Different scope is rejected.
    """
    root, output_directory = Path(root).resolve(), Path(output_directory).resolve()
    daily.require(output_directory != root and root not in output_directory.parents,
                  "EXACT_SIMULATION_OUTPUT_MUST_BE_OUTSIDE_ROOT")
    plan = _plan(root, envelope, evidence, now, trusted_test_pins, True)
    raw = shadow.canonical(plan).encode()
    output_directory.mkdir(parents=True, exist_ok=True)
    target = output_directory / "TEST_ONLY-committed-generation.json"
    if target.exists():
        daily.require(target.read_bytes() == raw, "EXACT_GENERATION_SCOPE_CHANGED")
        return {"status": "NOOP_ALREADY_COMMITTED", "sha256": sha(raw)}
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=output_directory, prefix=".TEST_ONLY-staging-", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        if interrupt:
            interrupt("BEFORE_COMMIT")
        # Exclusive lock prevents concurrent publishers racing the active generation.
        lock = output_directory / ".TEST_ONLY-publish.lock"
        with lock.open("x"):
            pass  # Close the Windows handle before eventual unlink.
        try:
            if target.exists():
                daily.require(target.read_bytes() == raw, "EXACT_GENERATION_SCOPE_CHANGED")
            else:
                os.replace(temporary, target)
            if interrupt:
                interrupt("AFTER_COMMIT")
        finally:
            lock.unlink()
        return {"status": "COMMITTED_TEST_ONLY", "sha256": sha(raw)}
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()
