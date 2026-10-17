"""Read-only evidence/approval packaging. Never creates grants, pins or prices.

Trust enters only through protected environment secrets. An authenticated Owner
comment transports an externally approved envelope; it is not itself a trust pin.
Execution run binding belongs to the later Recovery registry, not this bundle.
"""
import argparse
import base64
import copy
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import phase_l7_daily as daily
import phase_l7_bridge as bridge
import phase_l7_exact_recovery as exact
import phase_l7_recovery_evidence as sources
from phase_l7_recovery_github import REPOSITORY, api

WORKFLOW = ".github/workflows/00631l-evidence-packaging.yml"
REVIEW_ARTIFACT = "exact-recovery-review-input"
RECOVERY_ARTIFACT = "exact-recovery-input"
COMMENT_PREFIX = "HS00631L_APPROVAL_ENVELOPE_V1\n"


def require(value, reason):
    daily.require(value, "PACKAGING_" + reason)


def json_bytes(value):
    return daily.shadow.canonical(value).encode("utf8")


def receipt_names():
    # Exact October scope: preserve all three whole Yahoo payloads, never splice.
    return {"twse-calendar", *("twse-2026%02d" % m for m in range(1, 11)),
            "yahoo-1", "yahoo-2", "yahoo-3", *bridge.ACTION_DATASETS}


def encode_evidence(evidence):
    result = copy.deepcopy(evidence)
    require(len(result["receipts"]) == 18 and
            {r["name"] for r in result["receipts"]} == receipt_names(), "ALL_18_RECEIPTS_REQUIRED")
    for entry in result["receipts"]:
        captured = exact.stamp(evidence["captured_at"])
        name = entry["name"]
        if name == "twse-calendar":
            expected_url = daily.CALENDAR_URL
        elif name.startswith("twse-"):
            expected_url = f"{daily.DAILY_URL}?response=json&date={name[5:]}01&stockNo=00631L"
        elif name.startswith("yahoo-"):
            start = int(datetime(2014, 10, 23, tzinfo=daily.TAIPEI).timestamp())
            expected_url = (f"https://query1.finance.yahoo.com/v8/finance/chart/00631L.TW?period1={start}"
                            f"&period2={int(captured.timestamp())}&interval=1d&events=div%2Csplits")
        else:
            symbol = "" if name == "TaiwanStockParValueChange" else "&data_id=00631L"
            expected_url = f"{daily.ACTION_URL}?dataset={name}{symbol}&start_date={exact.ANCHOR}&end_date={exact.TARGET}"
        require(entry["source_url"] == expected_url, "PUBLIC_SOURCE_URL_REQUIRED")
        raw = entry.pop("raw")
        require(exact.sha(raw) == entry["sha256"], "RAW_SHA_MISMATCH")
        entry["raw_base64"] = base64.b64encode(raw).decode("ascii")
    return result


def decode_evidence(encoded):
    result = copy.deepcopy(encoded)
    require(set(result) == {"captured_at", "selected_yahoo_payload", "receipts"}, "EVIDENCE_SCHEMA")
    for entry in result["receipts"]:
        require(set(entry) == {"name", "source_url", "retrieved_at", "coverage", "http_status", "sha256", "raw_base64"},
                "RECEIPT_SCHEMA")
        entry["raw"] = base64.b64decode(entry.pop("raw_base64"), validate=True)
    encode_evidence(result)  # Count, unique names and raw hashes, not an asserted PASS.
    return result


def guard(root, environment, policy, request=api):
    require(environment.get("GITHUB_EVENT_NAME") == "workflow_dispatch" and
            environment.get("GITHUB_REPOSITORY") == REPOSITORY and
            environment.get("GITHUB_REF") == "refs/heads/main", "MANUAL_MAIN_ONLY")
    actor, actor_id = environment.get("GITHUB_ACTOR"), environment.get("GITHUB_ACTOR_ID")
    require(actor and str(policy.get("github_actors", {}).get(actor)) == str(actor_id)
            and actor_id is not None, "ACTOR_NOT_EXTERNALLY_TRUSTED")
    base = policy.get("base_git_sha", "")
    require(re.fullmatch(r"[a-f0-9]{40}", base) and
            environment.get("GITHUB_SHA") == base, "BASE_NOT_EXTERNALLY_PINNED")
    head = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"]).decode().strip()
    require(head == base == request("repos/" + REPOSITORY + "/commits/main")["sha"], "BASE_CHANGED")
    run_id = environment.get("GITHUB_RUN_ID", "")
    require(run_id.isdigit(), "ACTUAL_RUN_REQUIRED")
    run = request("repos/" + REPOSITORY + "/actions/runs/" + run_id)
    require(run.get("event") == "workflow_dispatch" and run.get("head_sha") == base
            and run.get("path") == WORKFLOW and run.get("actor", {}).get("login") == actor
            and str(run.get("actor", {}).get("id")) == str(actor_id), "RUN_NOT_ATTESTED")
    return {"workflow_run_id": int(run_id), "workflow_path": WORKFLOW, "head_sha": base,
            "actor": actor, "actor_id": actor_id}


def source_artifact(run_id, trust, request=api):
    require(str(run_id).isdigit() and str(run_id) == str(trust.get("source_run_id")), "SOURCE_RUN_NOT_PINNED")
    run = request("repos/" + REPOSITORY + "/actions/runs/" + str(run_id))
    actor = run.get("actor", {})
    require(actor.get("login") and isinstance(actor.get("id"), int) and
            actor["login"] in trust.get("github_actors", {}), "SOURCE_ACTOR_REQUIRED")
    require(run.get("conclusion") == "success" and run.get("event") == "workflow_dispatch"
            and run.get("head_sha") == trust.get("base_git_sha") and run.get("path") == WORKFLOW
            and str(trust["github_actors"][actor["login"]]) == str(actor["id"]), "SOURCE_RUN_NOT_ATTESTED")
    artifacts = request("repos/" + REPOSITORY + "/actions/runs/" + str(run_id) + "/artifacts?per_page=100")
    require(artifacts.get("total_count", 101) <= 100, "ARTIFACT_LIST_INCOMPLETE")
    matches = [a for a in artifacts.get("artifacts", []) if a.get("name") == REVIEW_ARTIFACT]
    require(len(matches) == 1, "ONE_REVIEW_ARTIFACT_REQUIRED")
    artifact = matches[0]
    require(not artifact.get("expired") and artifact.get("id") == trust.get("source_artifact_id")
            and artifact.get("digest") == trust.get("source_artifact_digest")
            and isinstance(artifact.get("digest"), str) and artifact["digest"].startswith("sha256:"),
            "ARTIFACT_ID_OR_DIGEST_NOT_PINNED")
    return artifact


def owner_envelope(comment, trust, now):
    require(isinstance(trust.get("owner_login"), str) and trust["owner_login"]
            and isinstance(trust.get("owner_id"), int), "OWNER_REGISTRY_REQUIRED")
    require(str(comment.get("id")) == str(trust.get("owner_comment_id")) and
            comment.get("user", {}).get("login") == trust.get("owner_login") and
            comment.get("user", {}).get("id") == trust.get("owner_id"), "OWNER_IDENTITY_NOT_ATTESTED")
    text = comment.get("body", "")
    require(exact.sha(text.encode("utf8")) == trust.get("owner_comment_body_sha256"), "OWNER_COMMENT_NOT_PINNED")
    require(text.startswith(COMMENT_PREFIX) and comment.get("created_at") == comment.get("updated_at"),
            "OWNER_COMMENT_FORMAT_OR_EDITED")
    created = exact.stamp(comment["created_at"])
    require(created <= now, "OWNER_COMMENT_FUTURE")
    envelope = json.loads(text[len(COMMENT_PREFIX):])
    require(set(envelope) == {"contract", "authorization_id", "environment", "status", "approvals"}, "ENVELOPE_SCHEMA")
    require(envelope.get("environment") == "PRODUCTION" and envelope.get("status") == "APPROVED", "FORMAL_APPROVAL_REQUIRED")
    pins = trust.get("pins", {})
    require(pins.get("envelope_sha256") == daily.digest(envelope) and
            pins.get("authorization_id") == envelope.get("authorization_id"), "EXTERNAL_ENVELOPE_PIN_REQUIRED")
    approvals = envelope.get("approvals", [])
    require(len(approvals) == 7 and len({a["approval_id"] for a in approvals}) == 7 and
            len({a["incident_id"] for a in approvals}) == 7, "SEVEN_INDEPENDENT_APPROVALS_REQUIRED")
    require(set(pins.get("individual", {})) == {a["approval_id"] for a in approvals}, "INDIVIDUAL_PIN_SCOPE")
    for approval in approvals:
        require(set(approval) == {"incident_id", "approval_id", "authorization_id", "contract_sha256", "item_sha256",
                "recovery_target", "test_only", "approved_by", "approved_at"}, "APPROVAL_SCHEMA")
        require(approval.get("test_only") is False and approval.get("approved_by") == trust["owner_login"]
                and not approval["approved_by"].startswith("TEST_ONLY:"), "TEST_OR_UNTRUSTED_APPROVER")
        require(pins["individual"][approval["approval_id"]] == daily.digest(approval), "INDIVIDUAL_PIN_MISMATCH")
        require(exact.stamp(envelope["contract"]["captured_at"]) <= exact.stamp(approval["approved_at"]) <= created,
                "APPROVAL_TIME_NOT_ATTESTED")
    return envelope


def capture(root, now):
    result = sources.refresh(root, now)
    require(result["status"] == "FRESH_VALIDATED_UNSIGNED", "EVIDENCE_INCOMPLETE_OR_NEW_COMPLETED_DAY")
    return json_bytes({"envelope": result["draft"], "evidence": encode_evidence(result["evidence"])})


def package(root, review_raw, comment, trust, now):
    require(exact.sha(review_raw) == trust.get("source_bundle_sha256"), "SOURCE_BUNDLE_NOT_PINNED")
    review = json.loads(review_raw)
    require(set(review) == {"envelope", "evidence"} and review["envelope"].get("approvals") == []
            and review["envelope"].get("authorization_id") is None
            and review["envelope"].get("status") == "UNSIGNED_NON_EXECUTABLE", "UNSIGNED_REVIEW_REQUIRED")
    evidence = decode_evidence(review["evidence"])
    body, candidate, *_ = exact.context(root, evidence, now)
    require(review["envelope"]["contract"] == body and body["base_git_sha"] == trust.get("base_git_sha")
            and daily.digest(body) == trust.get("contract_sha256"), "CONTRACT_OR_BASE_MISMATCH")
    envelope = owner_envelope(comment, trust, now)
    require(envelope["contract"] == body, "OWNER_CONTRACT_MISMATCH")
    # Pure validation/planning only: no adapter commit, publish, registry writes or latch changes.
    exact.production_plan(root, envelope, evidence, now, trust["pins"])
    raw = json_bytes({"envelope": envelope, "evidence": review["evidence"]})
    # Public output is built from allowlisted source/envelope schemas, never from trust JSON.
    return raw, {"candidate_sha256": daily.digest(candidate), "data_version": body["candidate_data_version"],
                 "contract_sha256": daily.digest(body), "expires_at": body["expires_at"]}


def write_output(root, output, raw, receipt):
    root, output = Path(root).resolve(), Path(output).resolve()
    require(output != root and root not in output.parents, "OUTPUT_MUST_BE_OUTSIDE_REPOSITORY")
    require(not output.exists(), "OUTPUT_ALREADY_EXISTS")
    output.mkdir(parents=True)
    (output / "bundle.json").write_bytes(raw)
    (output / "packaging-receipt.json").write_bytes(json_bytes({**receipt, "bundle_sha256": exact.sha(raw),
        "trust_status": "DESCRIPTIVE_RECEIPT_NOT_EXTERNAL_TRUST", "recovery_enabled": False}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--operation", choices=("capture", "source-check", "package"), required=True)
    parser.add_argument("--source-run-id", default="")
    parser.add_argument("--input", default="")
    parser.add_argument("--output", default="")
    args = parser.parse_args()
    try:
        now = datetime.now(timezone.utc)
        environment = dict(os.environ)
        policy = json.loads(environment.get("EXACT_PACKAGING_POLICY_JSON", "{}"))
        execution = guard(Path.cwd(), environment, policy)
        trust = json.loads(environment.get("EXACT_PACKAGING_TRUST_JSON", "{}"))
        if args.operation == "capture":
            raw = capture(Path.cwd(), now)
            receipt = {**execution, "operation": "capture", "formal_approvals": 0, "raw_response_count": 18}
        else:
            require(trust.get("base_git_sha") == policy.get("base_git_sha") and
                    trust.get("github_actors") == policy.get("github_actors"), "TRUST_POLICY_MISMATCH")
            artifact = source_artifact(args.source_run_id, trust)
            if args.operation == "source-check":
                print(json.dumps({"source_artifact_id": artifact["id"], "status": "SOURCE_METADATA_VALIDATED"}))
                return 0
            comment_id = trust.get("owner_comment_id")
            require(str(comment_id).isdigit(), "OWNER_COMMENT_REQUIRED")
            comment = api("repos/" + REPOSITORY + "/issues/comments/" + str(comment_id))
            raw, details = package(Path.cwd(), Path(args.input).read_bytes(), comment, trust, now)
            receipt = {**execution, **details, "operation": "package", "source_run_id": int(args.source_run_id),
                       "source_artifact_id": artifact["id"], "source_artifact_digest": artifact["digest"],
                       "raw_response_count": 18, "owner_comment_id": comment_id}
        body = json.loads(raw)["envelope"]["contract"]
        completed = datetime.now(timezone.utc)
        captured = exact.stamp(body["captured_at"])
        require(completed < exact.stamp(body["expires_at"]) and
                completed.astimezone(daily.TAIPEI).date() == captured.astimezone(daily.TAIPEI).date(),
                "EXPIRED_BEFORE_ARTIFACT_OUTPUT")
        write_output(Path.cwd(), args.output, raw, receipt)
        print(json.dumps({"status": "PACKAGED_NOT_RECOVERED", "bundle_sha256": exact.sha(raw)}))
        return 0
    except Exception as exc:
        # Never print raw responses, arbitrary exception text, comments, tokens or trust JSON.
        print(json.dumps({"status": "FAIL_CLOSED", "error": str(exc) if isinstance(exc, daily.Error) else type(exc).__name__}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
