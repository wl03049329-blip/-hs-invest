"""Opt-in generation adapter. No CLI, default trust, workflow or network side effects.

Legacy production files are NEVER replaced one-by-one. Six operational files
form an immutable generation; a single atomic pointer exposes the complete set.
Production operators must supply both an external approver registry and pins,
enable runtime explicitly, and provide separate publish/verify clients.
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import build_frontend_status as frontend
import phase_l7_daily as daily
import phase_l7_exact_recovery as exact
import phase_l7_shadow as shadow

STAGES = ("PREPARE", "VALIDATE", "APPROVE", "COMMIT", "PUBLISH", "VERIFY")
PRODUCTION_DESTINATION = "github:wl03049329-blip/-hs-invest:main"


def _write(path, raw):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as handle:
        handle.write(raw)
        handle.flush()
        os.fsync(handle.fileno())


class RecoveryAdapter:
    def __init__(self, root, store, envelope, evidence, *, mode="PRODUCTION",
                 trusted_pins=None, approver_registry=None, runtime_enabled=False,
                 execution=None):
        self.root, self.store = Path(root).resolve(), Path(store).resolve()
        daily.require(self.root != self.store and self.root not in self.store.parents,
                      "ADAPTER_STORE_MUST_BE_OUTSIDE_ROOT")
        # A short staging path may become >MAX_PATH after adding the generation
        # hash. Opt into Windows extended paths BEFORE any filesystem operation.
        if os.name == "nt" and not str(self.store).startswith("\\\\?\\"):
            self.store = Path("\\\\?\\" + str(self.store))
        daily.require(mode in ("PRODUCTION", "TEST_ONLY"), "ADAPTER_MODE_INVALID")
        self.envelope, self.evidence, self.mode = envelope, evidence, mode
        self.pins, self.registry, self.enabled = trusted_pins, approver_registry, runtime_enabled
        self.execution = execution or {}
        self.stages = {s: "NOT_STARTED" for s in STAGES}
        self.plan = self.pointer = self.publish_receipt = None

    def _time(self, now):
        if self.mode == "PRODUCTION":
            actual = datetime.now(timezone.utc)
            daily.require(now is None or (now.tzinfo is not None and abs((actual - now).total_seconds()) <= 30),
                          "ADAPTER_PRODUCTION_WALL_CLOCK_REQUIRED")
            return actual
        return now or datetime.now(timezone.utc)

    def _begin(self, stage):
        for downstream in STAGES[STAGES.index(stage):]:
            self.stages[downstream] = "NOT_STARTED"
        self.stages[stage] = "FAIL"

    def _client(self, client):
        daily.require(client is not None and getattr(client, "environment", None) == self.mode,
                      "ADAPTER_CLIENT_ENVIRONMENT_MISMATCH")
        destination = getattr(client, "destination", "")
        daily.require((destination == PRODUCTION_DESTINATION if self.mode == "PRODUCTION"
                       else destination.startswith("TEST_ONLY:")), "ADAPTER_CLIENT_DESTINATION_MISMATCH")
        return destination

    def prepare(self, now=None):
        self._begin("PREPARE")
        try:
            self.prepared = exact.draft(self.root, self.evidence, self._time(now))
            self.stages["PREPARE"] = "PASS"
            return self.prepared
        except Exception:
            self.stages["PREPARE"] = "FAIL"
            raise

    def validate(self, now=None):
        daily.require(self.stages["PREPARE"] == "PASS", "ADAPTER_PREPARE_REQUIRED")
        self._begin("VALIDATE")
        try:
            actual = exact.draft(self.root, self.evidence, self._time(now))
            daily.require(actual["contract"] == self.envelope["contract"] == self.prepared["contract"],
                          "ADAPTER_MANIFEST_ACTUAL_MISMATCH")
            self.stages["VALIDATE"] = "PASS"
        except Exception:
            self.stages["VALIDATE"] = "FAIL"
            raise

    def _approved_plan(self, now):
        daily.require(self.mode == "TEST_ONLY" or self.enabled, "ADAPTER_PRODUCTION_DISABLED")
        daily.require(self.registry and self.registry.get("authorization_id") == self.envelope.get("authorization_id")
                      and self.registry.get("environment") == self.mode
                      and self.registry.get("approved_contract_sha256") == daily.digest(self.envelope["contract"]),
                      "ADAPTER_EXTERNAL_REGISTRY_REQUIRED")
        approvals = self.envelope.get("approvals", [])
        allowed = set(self.registry.get("approved_principals", []))
        daily.require(len(approvals) == 7 and all(a.get("approved_by") in allowed for a in approvals),
                      "ADAPTER_PRINCIPAL_NOT_EXTERNALLY_TRUSTED")
        if self.mode == "PRODUCTION":
            daily.require(self.execution.get("event") == "workflow_dispatch"
                          and str(self.execution.get("workflow_run_id", "")).isdigit()
                          and self.registry.get("execution") == self.execution,
                          "ADAPTER_AUTHENTICATED_MANUAL_EXECUTION_REQUIRED")
        return (exact.production_plan(self.root, self.envelope, self.evidence, now, self.pins)
                if self.mode == "PRODUCTION" else
                exact._plan(self.root, self.envelope, self.evidence, now, self.pins, True))

    def approve(self, now=None):
        daily.require(self.stages["VALIDATE"] == "PASS", "ADAPTER_VALIDATE_REQUIRED")
        self._begin("APPROVE")
        try:
            self.plan = self._approved_plan(self._time(now))
            self.stages["APPROVE"] = "PASS"
        except Exception:
            self.stages["APPROVE"] = "FAIL"
            raise

    def _generation_files(self, plan, staging):
        policy, _ = shadow.load_context(self.root)
        dependencies = set(policy["protected_hashes"]) | {
            "research/hs_leverage/phase_l7_forward_policy.json",
            "research/hs_leverage/data/00631L-historical-adjusted.json"}
        dependencies.update(str(Path(shadow.PROVENANCE_DIR) / p) for _, p in shadow.PROVENANCE_SCOPE)
        for relative in dependencies:
            destination = staging / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(self.root / relative, destination)
        status = dict(plan["status"], workflow_run_id=self.execution.get("workflow_run_id")
                      if self.mode == "PRODUCTION" else "TEST_ONLY:not-a-production-run")
        files = {daily.SNAPSHOT: shadow.canonical(plan["candidate"]).encode(),
                 daily.STATUS: shadow.canonical(status).encode(),
                 daily.INCIDENTS: plan["incident_ledger"].encode(),
                 policy["paths"]["forward_ledger"]: plan["forward_ledger"].encode(),
                 policy["paths"]["outcomes_ledger"]: plan["outcome_ledger"].encode()}
        for relative, raw in files.items():
            _write(staging / relative, raw)
        shadow.load_context(staging)
        for relative in (daily.INCIDENTS, *policy["paths"].values()):
            daily.require(shadow.validate_hash_chain(staging / relative)["status"] == "PASS",
                          "ADAPTER_GENERATION_CHAIN_INVALID")
        snapshot = frontend.build(staging, plan['contract']['actual_latest_completed_session'])
        files["00631l-leverage-status-v1.json"] = shadow.canonical(snapshot).encode()
        _write(staging / "00631l-leverage-status-v1.json", files["00631l-leverage-status-v1.json"])
        return files

    def read_committed(self):
        daily.require(self.plan is not None, "ADAPTER_APPROVED_PLAN_REQUIRED")
        pointer = shadow.read_json(self.store / "current.json")
        daily.require(pointer.get("environment") == self.mode, "ADAPTER_GENERATION_MODE_MISMATCH")
        daily.require(pointer.get("contract_sha256") == daily.digest(self.envelope["contract"])
                      and pointer.get("generation") == daily.digest({"plan": self.plan,
                          "execution": self.execution, "environment": self.mode}),
                      "ADAPTER_POINTER_NOT_APPROVED")
        identifier = pointer["generation"]
        daily.require(len(identifier) == 64 and all(c in "0123456789abcdef" for c in identifier),
                      "ADAPTER_GENERATION_ID_INVALID")
        directory = self.store / "generations" / identifier
        manifest = shadow.read_json(directory / "generation.json")
        daily.require(exact.sha((directory / "generation.json").read_bytes()) == pointer["manifest_sha256"],
                      "ADAPTER_GENERATION_MANIFEST_CORRUPT")
        daily.require(manifest["environment"] == self.mode and manifest["contract_sha256"] == pointer["contract_sha256"],
                      "ADAPTER_GENERATION_CONTRACT_MISMATCH")
        files = {}
        for relative, expected in manifest["files"].items():
            path = (directory / relative).resolve()
            daily.require(directory.resolve() in path.parents, "ADAPTER_UNSAFE_PATH")
            raw = path.read_bytes()
            daily.require(exact.sha(raw) == expected, "ADAPTER_PARTIAL_OR_CORRUPT_GENERATION")
            files[relative] = raw
        daily.require(len(files) == 6, "ADAPTER_SIX_FILES_REQUIRED")
        policy, _ = shadow.load_context(directory)
        status = dict(self.plan["status"], workflow_run_id=self.execution.get("workflow_run_id")
                      if self.mode == "PRODUCTION" else "TEST_ONLY:not-a-production-run")
        expected = {daily.SNAPSHOT: shadow.canonical(self.plan["candidate"]).encode(),
                    daily.STATUS: shadow.canonical(status).encode(),
                    daily.INCIDENTS: self.plan["incident_ledger"].encode(),
                    policy["paths"]["forward_ledger"]: self.plan["forward_ledger"].encode(),
                    policy["paths"]["outcomes_ledger"]: self.plan["outcome_ledger"].encode()}
        daily.require(all(files.get(p) == raw for p, raw in expected.items()),
                      "ADAPTER_GENERATION_NOT_APPROVED_CONTENT")
        expected["00631l-leverage-status-v1.json"] = shadow.canonical(
            frontend.build(directory,self.plan['contract']['actual_latest_completed_session'])).encode()
        daily.require(files == expected, "ADAPTER_GENERATION_NOT_APPROVED_CONTENT")
        return pointer, files

    def commit(self, now=None, interrupt=None):
        daily.require(self.stages["APPROVE"] == "PASS", "ADAPTER_APPROVE_REQUIRED")
        self._begin("COMMIT")
        # Revalidate source freshness, pins, baseline and approvals at the actual commit boundary.
        plan = self._approved_plan(self._time(now))
        daily.require(plan == self.plan, "ADAPTER_PLAN_CHANGED")
        self.store.mkdir(parents=True, exist_ok=True)
        lock = self.store / ".recovery.lock"
        with lock.open("x"):
            pass
        try:
            identifier = daily.digest({"plan": plan, "execution": self.execution, "environment": self.mode})
            if (self.store / "current.json").exists():
                pointer, _ = self.read_committed()
                daily.require(pointer["generation"] == identifier, "ADAPTER_GENERATION_SCOPE_CHANGED")
                self.pointer = pointer
                self.stages["COMMIT"] = "PASS"
                return "NOOP_ALREADY_COMMITTED"
            generations = self.store / "generations"
            generations.mkdir(exist_ok=True)
            # Incomplete/orphan generations never become visible without the single pointer.
            with tempfile.TemporaryDirectory(dir=self.store, prefix=".staging-") as temporary:
                staging = Path(temporary)
                files = self._generation_files(plan, staging)
                if interrupt:
                    interrupt("FILES_STAGED")
                manifest = {"environment": self.mode, "execution": self.execution,
                            "contract_sha256": daily.digest(plan["contract"]),
                            "files": {p: exact.sha(b) for p, b in files.items()}}
                raw = shadow.canonical(manifest).encode()
                _write(staging / "generation.json", raw)
                destination = generations / identifier
                if destination.exists():
                    daily.require((destination / "generation.json").read_bytes() == raw,
                                  "ADAPTER_ORPHAN_GENERATION_MISMATCH")
                    for p, b in files.items():
                        daily.require((destination / p).read_bytes() == b, "ADAPTER_ORPHAN_GENERATION_CORRUPT")
                else:
                    # Move an entire directory, never legacy files one-by-one.
                    os.replace(staging, destination)
                    staging.mkdir()  # Allow TemporaryDirectory to clean its now-empty owned path.
                if interrupt:
                    interrupt("GENERATION_READY")
                pointer = {"environment": self.mode, "generation": identifier,
                           "contract_sha256": manifest["contract_sha256"], "manifest_sha256": exact.sha(raw)}
                pointer_tmp = staging / "pointer.json"
                _write(pointer_tmp, shadow.canonical(pointer).encode())
                os.replace(pointer_tmp, self.store / "current.json")
                if interrupt:
                    interrupt("POINTER_COMMITTED")
                self.pointer = pointer
                self.stages["COMMIT"] = "PASS"
                return "COMMITTED_GENERATION"
        except Exception:
            self.stages["COMMIT"] = "FAIL"
            raise
        finally:
            lock.unlink()

    def publish(self, publisher=None, now=None):
        daily.require(self.stages["COMMIT"] == "PASS", "ADAPTER_COMMIT_REQUIRED")
        self._begin("PUBLISH")
        self._approved_plan(self._time(now))
        try:
            daily.require(publisher is not None, "ADAPTER_EXPLICIT_PUBLISH_CLIENT_REQUIRED")
            destination = self._client(publisher)
            pointer, files = self.read_committed()
            receipt = publisher(pointer, files)
            daily.require(receipt.get("environment") == self.mode and receipt.get("git_commit")
                          and receipt.get("generation") == pointer["generation"], "ADAPTER_PUBLISH_RECEIPT_INVALID")
            if self.mode == "PRODUCTION":
                commit = receipt["git_commit"]
                daily.require(len(commit) == 40 and all(c in "0123456789abcdef" for c in commit),
                              "ADAPTER_GIT_SHA_INVALID")
            self.publish_receipt = receipt
            self.publish_destination = destination
            self.stages["PUBLISH"] = "PASS"
        except Exception:
            self.stages["PUBLISH"] = "FAIL"
            raise

    def verify(self, verifier=None, now=None):
        daily.require(self.stages["PUBLISH"] == "PASS", "ADAPTER_PUBLISH_REQUIRED")
        self._begin("VERIFY")
        self._approved_plan(self._time(now))
        try:
            daily.require(verifier is not None, "ADAPTER_INDEPENDENT_VERIFIER_REQUIRED")
            daily.require(self._client(verifier) == self.publish_destination, "ADAPTER_VERIFY_DESTINATION_MISMATCH")
            pointer, files = self.read_committed()
            observed = verifier(self.publish_receipt, tuple(files))
            daily.require(observed.get("environment") == self.mode
                          and observed.get("pages_conclusion") == "success"
                          and observed.get("active_release_sha") == self.publish_receipt["git_commit"]
                          and observed.get("pages_deployment_sha") == self.publish_receipt["git_commit"],
                          "ADAPTER_PAGES_RELEASE_NOT_VERIFIED")
            if self.mode == "PRODUCTION":
                daily.require(str(observed.get("workflow_run_id")) == str(self.execution["workflow_run_id"])
                              and observed.get("workflow_conclusion") == "success"
                              and observed.get("workflow_event") == "workflow_dispatch"
                              and observed.get("workflow_head_sha") == self.envelope["contract"]["base_git_sha"],
                              "ADAPTER_PUBLICATION_RUN_NOT_ATTESTED")
            daily.require(set(observed.get("repo_files", {})) == set(files)
                          and set(observed.get("public_files", {})) == set(files), "ADAPTER_PUBLIC_FILES_INCOMPLETE")
            for p, raw in files.items():
                daily.require(observed["repo_files"][p] == raw and observed["public_files"][p] == raw,
                              "ADAPTER_STALE_REPO_OR_PUBLIC_RESOURCE:" + p)
            self.stages["VERIFY"] = "PASS"
            self.verified_pointer = pointer
        except Exception:
            self.stages["VERIFY"] = "FAIL"
            raise

    def read_verified(self, now=None):
        daily.require(all(self.stages[s] == "PASS" for s in STAGES), "ADAPTER_ALL_SIX_STAGES_REQUIRED")
        self._approved_plan(self._time(now))
        pointer, files = self.read_committed()
        daily.require(pointer == self.verified_pointer, "ADAPTER_GENERATION_CHANGED_AFTER_VERIFY")
        return files
