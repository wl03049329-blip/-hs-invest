# 00631L Evidence Packaging — manual, read-only, not Recovery approval

This change adds an input producer only. It does not change Daily, the existing
Recovery workflow, the exact contract, target, Reader, strategy or formal files.
No workflow is dispatched by this PR or these instructions. Follow-up execution
requires separate Owner approval.

## Trust order (no run-ID/hash cycle)

1. After an approved merge, independently pin the **new main commit**, not
   `fd1599b...`, in the protected Packaging policy. Old evidence/manifests/pins
   are invalid for that new base. This main SHA also fixes this new packager and
   its workflow; the exact contract continues checking its existing module SHAs.
2. An authorized operator manually runs `operation=capture` on main. The existing
   fresh-evidence collector fetches public TWSE calendar + Jan–Oct official
   monthly OHLC + three whole Yahoo responses + four action datasets. All **18**
   responses must succeed and their original bytes are preserved as base64 with
   raw SHA, URL, HTTP status, coverage and capture time. Missing/402/conflict =>
   fail-closed; no retries beyond the existing collector's bounded Yahoo budget.
3. The run uploads `exact-recovery-review-input` containing root `bundle.json`
   (unsigned envelope + 18 receipts) and `packaging-receipt.json`. No approval or
   pin is invented. Capture output is **not** accepted by formal Recovery.
4. Owner/independent trust administrator download and inspect that artifact.
   Independently verify the source run's successful conclusion, manual event,
   workflow path, actor login **and numeric ID**, main SHA, artifact ID/digest,
   and downloaded raw bundle SHA. The unsigned manifest has the actual new base,
   candidate, code hashes, seven incidents, six-hour/same-day expiry and target.
5. Owner independently confirms all seven approvals. Use the existing exact
   approval schema; each unique record has incident_id, approval_id,
   authorization_id, contract_sha256, item_sha256, recovery_target, test_only=false,
   approved_by and approved_at. approved_by must be Owner's actual GitHub login.
   Each time is real, at/after capture and at/before the authenticated comment.
   Old 10/07 authority and TEST_ONLY are never accepted. No extra fields/pins.
6. Owner posts one **new, unedited** issue comment in this repository, using their
   authenticated GitHub account. Exact body: `HS00631L_APPROVAL_ENVELOPE_V1`, a
   newline, then the complete JSON approved envelope (no Markdown fences).
   Top-level fields: contract, authorization_id, environment=PRODUCTION,
   status=APPROVED, approvals (seven independently approved items). A single
   comment transports seven records; it does not replace them with one approval.
   This public comment must contain no tokens, private records, trust registry
   or pins. It contains only the reviewable approved public-source contract.
7. A trust administrator outside Packaging independently checks the comment's
   author numeric ID/login, created_at/updated_at, body bytes, and each approval.
   Compute seven **individual canonical JSON** digests and one approved-envelope
   canonical digest, using the existing `shadow.canonical` / `daily.digest`
   rules (UTF-8, sorted keys, compact separators, ensure_ascii=False). The comment
   body SHA and downloaded bundle SHA are **raw-byte** hashes; artifact digest is
   the separate GitHub upload-artifact archive digest. Do not interchange them.
8. That administrator installs the external Packaging trust secret. Packaging
   cannot install/compute effective pins or self-authorize. A descriptive SHA in
   its receipt is not independent trust.
9. An authorized operator manually runs `operation=package`, source_run_id set to
   the actual capture run. It attests run/artifact metadata before downloading,
   checks the downloaded bundle hash, all receipts/context, authenticated comment,
   seven independent pins and existing production approval planner (read-only).
   Only then uploads **`exact-recovery-input`** with root **`bundle.json`** and a
   descriptive receipt. No trust policy, pins or registry are copied into it.
10. Owner independently downloads the final artifact and verifies actual raw
    bundle SHA and package Run ID. Only afterwards may an independently maintained
    **Recovery** registry bind evidence_run_id to this package Run ID and
    bundle_sha256 to these final raw bytes. Packaging creates no such registry.
11. Later, separately authorized Recovery Dispatch waits for protected environment
    approval. Bind its actual execution.workflow_run_id in **Environment Secrets**
    before that job starts, after independently checking actor/HEAD/path/event.
    The execution ID is outside the approved envelope and bundle: no hash cycle.
    Validate/publish are distinct runs and need distinct actual run bindings;
    Verify references the completed publish run. Never guess an ID or mutate the
    bundle to insert it. Keep Recovery Disabled throughout Packaging preparation.

## One-time GitHub setup (Owner/admin, not done by this PR)

- Environment `00631l-evidence-packaging`: selected **branch main only** (no tag),
  required independent reviewer, prevent self-review, no admin bypass. Dispatch
  operator and approval reviewer must be appropriately separated. Environment
  absence means missing policy secrets and the code rejects; do not rely on
  GitHub auto-created, unprotected environments as a security control.
- Environment secret `EXACT_PACKAGING_POLICY_JSON`: `base_git_sha` (full new
  merged SHA), `github_actors` (allowed login => verified numeric GitHub ID).
  No default identities. It is externally provisioned, not generated by workflow.
- Environment secret `EXACT_PACKAGING_TRUST_JSON` after Owner review: same
  `base_git_sha` and `github_actors`, actual `source_run_id`, `source_artifact_id`,
  `source_artifact_digest` (`sha256:...`), `source_bundle_sha256`,
  `contract_sha256`, `owner_login`, `owner_id`, `owner_comment_id`,
  `owner_comment_body_sha256`, and `pins` containing `authorization_id`,
  `envelope_sha256`, `individual` (seven distinct approval_id => digest entries).
  Do not paste these private trust values into public comments/artifacts/logs.
- Workflow permissions: contents/read, actions/read, issues/read only; no checkout
  credentials persisted, no write token, no Recovery secrets/Enable consumed.
- Separately protect `00631l-exact-recovery` before any future Recovery operation;
  do not enable or dispatch it as part of Packaging setup.

## Artifacts and expiry

Artifact content is allowlisted: `bundle.json` and `packaging-receipt.json` at
archive root. Receipts retain original source bytes, not recomputed prices.
The new producer uses upload-artifact v4 with one-day retention; **retention is
not evidence validity**. All exact six-hour/same-Taipei-day checks still apply.
Source URLs must exactly match the public collector URLs; injected token URLs,
extra receipt/envelope/approval fields and missing Yahoo responses are rejected.

Do not put trust data into the envelope or raw public source responses. The
packager does not accept arbitrary URLs, ZIP uploads or remote shell commands;
it downloads an independently pinned Actions artifact and reads an independently
pinned GitHub issue comment in this repository only.

## 10/19 and later: intentionally BLOCKED

The existing exact context requires current latest completed day == 2026/10/16.
This PR deliberately does **not** weaken it. When 10/19 is completed, capture
returns no usable manifest and Packaging fails closed. Merely re-fetching data
or changing timestamps cannot fix that.

Minimum **separate** review proposal (not implemented here): split exact historical
target from latest-day freshness, continue validating current source/calendar,
bound candidate/action/incident scope strictly to 10/16, and independently assess
later sessions/P0/revisions without authorizing their publication. Such a change
needs explicit approval, code tests, a new deployed SHA, entirely fresh evidence,
a new contract/digest and seven new exact approvals. No target auto-extension.

## Tests and known limits

Run only `python -m unittest discover -s research/hs_leverage -p test_phase_l7_packaging.py -v`.
Tests use isolated fixtures, never actual approvals or market recovery. The
positive production-planner boundary is explicitly mocked; other code performs
real context replay and production-validator refusal is tested. No TEST_ONLY
success is called formal approval success.

The HTTP ZIP test actually uploads/downloads bytes through a loopback server,
checks ZIP root paths/hashes and invokes the existing Recovery bundle loader.
It is **not** an actual GitHub artifact-service run. GitHub manual workflows must
exist on default branch before dispatch; this unmerged PR cannot honestly claim
that end-to-end result. After separate merge/setup/test authorization, execute
capture/package and independently download/hash-check artifacts. Until then that
service-level acceptance is PENDING; never hijack an existing workflow or create
an unrelated paid resource to make a test green.
