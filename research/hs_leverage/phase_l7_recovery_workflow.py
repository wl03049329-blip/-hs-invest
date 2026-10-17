"""Manual-only guarded recovery entry. Disabled before any input/output mutation."""
import argparse
import base64
import json
import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import phase_l7_daily as daily
import phase_l7_exact_recovery as exact
import phase_l7_recovery_adapter as adapter
from phase_l7_recovery_github import REPOSITORY, GitPublisher, GitPagesVerifier, api

WORKFLOW = ".github/workflows/00631l-exact-recovery.yml"


def gate(envelope, pins, registry, environment):
    daily.require(environment.get("HS_EXACT_RECOVERY_ENABLED") == "true"
                  and environment.get("CONFIRM_EXACT_RECOVERY") == "true", "RECOVERY_DISABLED")
    daily.require(environment.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
                  and environment.get("GITHUB_REPOSITORY") == REPOSITORY
                  and environment.get("GITHUB_REF") == "refs/heads/main", "RECOVERY_MANUAL_MAIN_ONLY")
    daily.require(envelope.get("environment") == registry.get("environment") == "PRODUCTION",
                  "RECOVERY_TEST_CREDENTIALS_FORBIDDEN")
    daily.require(envelope.get("status") == "APPROVED" and len(envelope.get("approvals", [])) == 7,
                  "RECOVERY_SEVEN_APPROVALS_REQUIRED")
    daily.require(environment.get("GITHUB_ACTOR") in registry.get("github_actors", [])
                  and registry.get("repository") == REPOSITORY and registry.get("workflow_path") == WORKFLOW,
                  "RECOVERY_EXECUTION_IDENTITY_NOT_TRUSTED")
    daily.require(environment.get("EXPECTED_CONTRACT_SHA") == registry.get("approved_contract_sha256")
                  == daily.digest(envelope["contract"])
                  and pins.get("envelope_sha256") == daily.digest(envelope), "RECOVERY_MANIFEST_PINS_MISMATCH")
    daily.require(str(environment.get("EVIDENCE_RUN_ID")) == str(registry.get("evidence_run_id")),
                  "RECOVERY_EVIDENCE_ARTIFACT_NOT_PINNED")


def load_bundle(path):
    raw = Path(path).read_bytes()
    bundle = json.loads(raw)
    evidence = bundle["evidence"]
    for receipt in evidence["receipts"]:
        receipt["raw"] = base64.b64decode(receipt.pop("raw_base64"), validate=True)
        daily.require(exact.sha(receipt["raw"]) == receipt["sha256"], "RECOVERY_BUNDLE_EVIDENCE_HASH_MISMATCH")
    return raw, bundle["envelope"], evidence


def execute(operation, workspace, bundle_path, output, environment, *, request=api):
    # Check the switch BEFORE reading bundle/secrets or creating any directories.
    daily.require(environment.get("HS_EXACT_RECOVERY_ENABLED") == "true"
                  and environment.get("CONFIRM_EXACT_RECOVERY") == "true", "RECOVERY_DISABLED")
    pins = json.loads(environment.get("EXACT_RECOVERY_PINS_JSON", "{}"))
    registry = json.loads(environment.get("EXACT_RECOVERY_REGISTRY_JSON", "{}"))
    raw, envelope, evidence = load_bundle(bundle_path)
    gate(envelope, pins, registry, environment)
    daily.require(exact.sha(raw) == registry.get("bundle_sha256"), "RECOVERY_BUNDLE_NOT_EXTERNALLY_PINNED")
    execution = registry["execution"]
    source_run = request("repos/" + REPOSITORY + "/actions/runs/" + str(execution["workflow_run_id"]))
    daily.require(source_run.get("event") == "workflow_dispatch"
                  and source_run.get("head_sha") == envelope["contract"]["base_git_sha"]
                  and source_run.get("path") == WORKFLOW
                  and source_run.get("actor", {}).get("login") in registry["github_actors"],
                  "RECOVERY_SOURCE_RUN_NOT_ATTESTED")
    daily.require(operation in ("validate", "publish", "verify"), "RECOVERY_OPERATION_INVALID")
    if operation != "verify":
        daily.require(str(environment.get("GITHUB_RUN_ID")) == str(execution["workflow_run_id"]),
                      "RECOVERY_EXECUTION_RUN_MISMATCH")
    workspace, output = Path(workspace).resolve(), Path(output).resolve()
    daily.require(workspace != output and workspace not in output.parents, "RECOVERY_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY")
    now = datetime.now(timezone.utc)
    with tempfile.TemporaryDirectory(prefix="hs-recovery-base-") as temporary:
        # Verification uses the originally approved immutable tree, not the
        # newly published main. The code running this entry must still match
        # the contract code hashes, which context() independently recomputes.
        root = workspace
        if operation == "verify":
            root = Path(temporary) / "base"
            subprocess.run(["git", "-c", "core.autocrlf=false", "clone", "--shared", "--no-checkout",
                            str(workspace), str(root)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(["git", "-C", str(root), "checkout", "--detach", envelope["contract"]["base_git_sha"]],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        c = adapter.RecoveryAdapter(root, Path(temporary) / "generation", envelope, evidence,
            trusted_pins=pins, approver_registry=registry, runtime_enabled=True, execution=execution)
        c.prepare(now); c.validate(now); c.approve(now)
        result = {"operation": operation, "stages": dict(c.stages), "production_recovered": False}
        if operation == "validate":
            return result  # No output/index/ledger write on validation-only.
        c.commit()
        if operation == "publish":
            def save_pending(receipt):
                output.mkdir(parents=True, exist_ok=True)
                (output / "publish-receipt.json").write_text(json.dumps(receipt) + "\n", encoding="utf8")
            c.publish(GitPublisher(root, envelope["contract"]["base_git_sha"], request=request, receipt_sink=save_pending))
            receipt = c.publish_receipt
            result["stages"] = dict(c.stages)
        else:
            receipt = json.loads((Path(bundle_path).parent / "publish-receipt.json").read_text(encoding="utf8"))
            # Adopt a prior publication for READ-ONLY verification, never push it again.
            pointer, _ = c.read_committed()
            daily.require(receipt.get("environment") == "PRODUCTION"
                          and receipt.get("generation") == pointer["generation"], "RECOVERY_PUBLISH_RECEIPT_SCOPE_MISMATCH")
            c.publish_receipt = receipt
            c.publish_destination = adapter.PRODUCTION_DESTINATION
            c.stages["PUBLISH"] = "PASS"  # Not final: independent API + public-byte verification follows.
            c.verify(GitPagesVerifier(execution, envelope["contract"]["base_git_sha"], request=request))
            files = c.read_verified()
            receipt = {"environment": "PRODUCTION", "contract_sha256": daily.digest(envelope["contract"]),
                "git_commit": receipt["git_commit"], "verified_at": datetime.now(timezone.utc).isoformat(),
                "files_sha256": {p: exact.sha(b) for p, b in files.items()}, "stages": dict(c.stages)}
            result["stages"] = dict(c.stages)
            result["verification"] = "PUBLICATION_VERIFIED_NOT_NATURAL_SCHEDULE_ACCEPTANCE"
        output.mkdir(parents=True, exist_ok=True)
        (output / ("publish-receipt.json" if operation == "publish" else "verified-receipt.json")).write_text(
            json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
        # A verified receipt is not a trust grant. An owner must independently
        # pin its digest in HS_EXACT_REVIEWED_AUTHORIZATIONS_JSON for Daily.
        return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--operation", choices=("validate", "publish", "verify"), default="validate")
    parser.add_argument("--bundle", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        result = execute(args.operation, Path.cwd(), args.bundle, args.output, dict(os.environ))
        print(json.dumps(result))
        return 0
    except Exception as exc:
        # Never print secret JSON, tokens or command environments.
        print(json.dumps({"status": "FAIL_CLOSED", "error": str(exc) if isinstance(exc, daily.Error) else type(exc).__name__}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
