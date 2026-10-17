"""Explicit transport clients. Construction does not make requests or mutations."""
import base64
import json
import os
import subprocess
import urllib.parse
import urllib.request
from pathlib import Path

import phase_l7_daily as daily
import phase_l7_exact_recovery as exact
from phase_l7_recovery_adapter import PRODUCTION_DESTINATION

REPOSITORY = "wl03049329-blip/-hs-invest"
PUBLIC = "https://wl03049329-blip.github.io/-hs-invest/"


def api(path, method="GET"):
    daily.require(path.startswith("repos/" + REPOSITORY + "/"), "RECOVERY_API_REPOSITORY_MISMATCH")
    result = subprocess.check_output(["gh", "api", "--method", method, path], stderr=subprocess.DEVNULL)
    return json.loads(result)


def public_bytes(relative):
    daily.require(".." not in Path(relative).parts and not Path(relative).is_absolute(), "RECOVERY_UNSAFE_PUBLIC_PATH")
    url = PUBLIC + urllib.parse.quote(relative, safe="/") + "?recovery_verify=1"
    request = urllib.request.Request(url, headers={"Cache-Control": "no-cache", "User-Agent": "HS-Recovery-Verify/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        daily.require(response.status == 200, "RECOVERY_PUBLIC_HTTP_FAILURE")
        return response.read()


class GitPublisher:
    environment = "PRODUCTION"
    destination = PRODUCTION_DESTINATION

    def __init__(self, root, expected_base, *, request=api, receipt_sink=None):
        self.root, self.base, self.request = Path(root), expected_base, request
        self.receipt_sink = receipt_sink

    def __call__(self, pointer, files):
        def git(*args, input=None, env=None):
            return subprocess.check_output(["git", "-C", str(self.root), *args], input=input,
                                           env=env, stderr=subprocess.DEVNULL)
        remote = git("remote", "get-url", "origin").decode().strip()
        if self.environment == "PRODUCTION":
            daily.require(remote in ("https://github.com/" + REPOSITORY, "https://github.com/" + REPOSITORY + ".git"),
                          "RECOVERY_REMOTE_NOT_APPROVED")
        else:
            daily.require(self.environment == "TEST_ONLY" and self.destination.startswith("TEST_ONLY:")
                          and "://" not in remote and Path(remote).is_dir(), "RECOVERY_TEST_REMOTE_MUST_BE_LOCAL")
        daily.require(git("rev-parse", "HEAD").decode().strip() == self.base, "RECOVERY_CHECKOUT_BASE_CHANGED")
        daily.require(self.request("repos/" + REPOSITORY + "/commits/main")["sha"] == self.base,
                      "RECOVERY_REMOTE_BASE_CHANGED")
        # Isolated index: six files enter ONE Git tree/commit. Working data and
        # the user's real index remain untouched, including on failed push.
        import tempfile
        with tempfile.TemporaryDirectory(prefix="hs-exact-index-") as directory:
            env = dict(os.environ, GIT_INDEX_FILE=str(Path(directory) / "index"),
                GIT_AUTHOR_NAME="github-actions[bot]", GIT_COMMITTER_NAME="github-actions[bot]",
                GIT_AUTHOR_EMAIL="41898282+github-actions[bot]@users.noreply.github.com",
                GIT_COMMITTER_EMAIL="41898282+github-actions[bot]@users.noreply.github.com")
            git("read-tree", self.base, env=env)
            for path, raw in files.items():
                oid = git("hash-object", "-w", "--stdin", input=raw, env=env).decode().strip()
                git("update-index", "--add", "--cacheinfo", "100644", oid, path, env=env)
            tree = git("write-tree", env=env).decode().strip()
            commit = git("commit-tree", tree, "-p", self.base, "-m", "Publish exact-scope 00631L recovery", env=env).decode().strip()
            daily.require(set(git("diff-tree", "--no-commit-id", "--name-only", "-r", commit).decode().splitlines()) <= set(files),
                          "RECOVERY_GIT_DIFF_OUTSIDE_ALLOWLIST")
            # Normal FF only. No rebase/retry over an unexpected new base.
            receipt = {"environment": self.environment, "generation": pointer["generation"], "git_commit": commit,
                       "publication": "PREPARED_NOT_VERIFIED"}
            if self.receipt_sink:
                self.receipt_sink(receipt)  # Survives push/Pages acknowledgement interruption.
            git("push", "origin", commit + ":refs/heads/main", env=env)
        self.request("repos/" + REPOSITORY + "/pages/builds", "POST")
        receipt["pages_request"] = "REQUESTED_NOT_VERIFIED"
        return receipt


class GitPagesVerifier:
    environment = "PRODUCTION"
    destination = PRODUCTION_DESTINATION

    def __init__(self, execution, expected_base, *, request=api, fetch=public_bytes):
        self.execution, self.base, self.request, self.fetch = execution, expected_base, request, fetch

    def __call__(self, receipt, paths):
        commit = receipt["git_commit"]
        published = self.request("repos/" + REPOSITORY + "/commits/" + commit)
        daily.require([p["sha"] for p in published.get("parents", [])] == [self.base]
                      and published.get("commit", {}).get("author", {}).get("email") ==
                      "41898282+github-actions[bot]@users.noreply.github.com"
                      and set(f["filename"] for f in published.get("files", [])) <= set(paths),
                      "RECOVERY_PUBLICATION_TREE_NOT_ATTESTED")
        run = self.request("repos/" + REPOSITORY + "/actions/runs/" + str(self.execution["workflow_run_id"]))
        build = self.request("repos/" + REPOSITORY + "/pages/builds/latest")
        main = self.request("repos/" + REPOSITORY + "/commits/main")
        blobs = {}
        for path in paths:
            result = self.request("repos/" + REPOSITORY + "/contents/" + path + "?ref=" + commit)
            if result.get("encoding") != "base64" and result.get("sha"):
                result = self.request("repos/" + REPOSITORY + "/git/blobs/" + result["sha"])
            daily.require(result.get("encoding") == "base64", "RECOVERY_REPOSITORY_BLOB_UNAVAILABLE")
            blobs[path] = base64.b64decode(result["content"], validate=False)
        return {"environment": self.environment, "pages_conclusion": "success" if build.get("status") == "built" else "pending",
            "active_release_sha": main["sha"], "pages_deployment_sha": build.get("commit"),
            "workflow_run_id": run["id"], "workflow_conclusion": run.get("conclusion"),
            "workflow_event": run.get("event"), "workflow_head_sha": run.get("head_sha"),
            "repo_files": blobs, "public_files": {p: self.fetch(p) for p in paths}}
