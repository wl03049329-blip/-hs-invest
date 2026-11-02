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
   monthly OHLC + three whole Yahoo responses + four target action datasets.
   Preserve the original **18** responses. When actual latest session exceeds
   10/16, also capture four independent post-target action receipts and any
   additional current-year official months. Every required response must succeed;
   original bytes are preserved as base64 with
   raw SHA, URL, HTTP status, coverage and capture time. Missing/402/conflict =>
   fail-closed; no retries beyond the existing collector's bounded Yahoo budget.
3. The run uploads `exact-recovery-review-input` containing root `bundle.json`
   (unsigned envelope + all required receipts) and `packaging-receipt.json`. No approval or
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

## Historical-date compatibility: contract revision 2

`actual_latest_completed_session` is computed from the REAL validation time and
official calendar; `recovery_target` stays 2026/10/16 and `anchor_date` 2026/10/13.
Capture time is never replaced with a fake 10/16/17 timestamp. If latest session
changes between capture and execution (even within six hours on the same day),
require new evidence/manifest/approval; do not promote an existing contract.

Normal Daily retains its original expected_day/date cutoff and public collect
signature. Only its price-validation body is shared via a private helper, called
by the exact historical path AFTER explicit scope/calendar/follow-on checks.
No Daily target override, publication permission or Recovery enable was added.

Historical candidate appends ONLY 10/14..16; all persisted rows through 10/13
remain verbatim after fresh price/factor checks. Ten-session bridge origin and
all old OHLC/revision/action/P0 guards remain. Post-10/16 sessions require fully
valid single-payload Yahoo primary OHLC/volume/adjusted close, factor one, TWSE
session/OHLC cross-check and all four independent action receipts from 10/13 to
actual latest. Missing data/actions/unknown conflicts fail closed; no post-target
fallback or prices are published. Volume discrepancies retain the existing rule.

The base four action receipts cover 10/13..16; four additional `post-*` receipts
cover 10/13..actual latest. Their source URLs and raw SHA are separately bound.
The original October 18 receipts remain; after 10/19 there are 22 (plus one per
extra official month if needed). ParValueChange remains all-market/no data_id
and checks stock_id. No empty-array substitution or source-limit bypass.

Contract revision 2 binds actual session, fixed target/anchor, follow-on proof,
candidate SHA/version, ALL receipts, unchanged seven incident items/base and
historical-scope module SHA. It uses the same deny-isolated Recovery record mode
to avoid accidentally entering legacy generic review handling. Old revision,
program/base/target/latest/SHA mismatches are rejected even with new test pins.
The Reader also requires revision 2 and a completed, separately pinned receipt.
New deployed SHA means new evidence, contract digest and seven new real approvals.

After actual latest advances, generated status is
`HISTORICAL_RECOVERY_ONLY_NO_BACKFILL`; frontend expected date is actual latest,
price date stays 10/16 and freshness is STALE. It does not claim CURRENT or a
new observation. Packaging, Adapter, external Pins/Registry and manual protected
environment gates are unchanged. No automatic approval or signal backfill.

Cross-year recovery is intentionally BLOCKED with an explicit review requirement:
the current collector attests one complete official calendar year. This patch
does not guess multi-year calendars/sessions or silently broaden capture scope.

## Tests and known limits

Packaging regression: `python -m unittest discover -s research/hs_leverage -p test_phase_l7_packaging.py -v`.
Historical date tests: `python -m unittest discover -s research/hs_leverage -p test_phase_l7_historical_scope.py -v`.
The date change also needs the directly affected Daily/source/Bridge, Exact,
Adapter/Reader workflow and Snapshot regressions; no live market diagnosis.
Tests use isolated fixtures, never actual approvals or market recovery. The
original positive boundary unit test remains explicitly mocked. Additional
integration tests invoke the **real production_plan and _plan, not mocks**, with
an isolated Git/data fixture and a controlled datetime clock, not a mocked
Planner. Production-shaped synthetic approval objects and test pins exist only
in test memory/temporary outputs, never in real Production inputs or Secrets.
They verify positive planning, each of seven missing approvals, a wrong pin,
expired evidence, same-Taipei-day cutoff within six hours, and TEST_ONLY refusal.
Every case checks unchanged isolated formal files. No fixture result grants
formal authorization.

Historical tests cover before/after the real 16:30 completion cutoff, 10/19,
10/20 and later dates, weekends/explicit fixture holidays, recap at a changed
latest session, missing post-source rows/actions, raw SHA/URL substitution,
historical revisions, new P0 (including incorrectly unset review flag), missing
individual approvals/pins, old revision, and a six-stage TEST_ONLY rerun whose
six-file generation stays STALE and preserves signals/capital/history. Two old
date-only rejection tests now assert the real missing fresh-source coverage,
retaining rejection/no-write assertions instead of forbidding valid new dates.

### P2 clock correction

Owner API/source-run lookups may take more than 30 seconds. Package entry time
now serves only as a rollback guard. After input work, a new real UTC instant
is read immediately before the pure Owner checks and real production Planner;
both use that same instant. The Planner is the single authoritative context
replay (the redundant pre-Planner replay was removed). Its original 30-second
wall-clock guard and six-hour/same-Taipei-day rules are unchanged. Main rechecks
expiry at output. A 45-second simulated API delay test calls the real Planner
successfully, while passing the pre-API timestamp to that same Planner still
fails its 30-second guard. Naive, rollback and >30-second skew tests fail closed.

### Official Action commit pins

Verified on 2026/10/18 using each official repository's Git refs and commit API;
all four returned the specified commit and `verification.verified=true`.
The workflow uses the full immutable SHA, not the moving reference listed here
as provenance. A regression test rejects tag-based/unknown Action replacements.

| Official repository / checked reference | Fixed commit |
| --- | --- |
| actions/checkout / v4 | [11d5960a326750d5838078e36cf38b85af677262](https://github.com/actions/checkout/commit/11d5960a326750d5838078e36cf38b85af677262) |
| actions/setup-python / v5 | [a26af69be951a213d495a4c3e4e4022e16d87065](https://github.com/actions/setup-python/commit/a26af69be951a213d495a4c3e4e4022e16d87065) |
| actions/download-artifact / v4 | [d3f86a106a0bac45b974a628896c90dbdf5c8093](https://github.com/actions/download-artifact/commit/d3f86a106a0bac45b974a628896c90dbdf5c8093) |
| actions/upload-artifact / v4 | [ea165f8d65b6e75b540449e92b4886f43607fa02](https://github.com/actions/upload-artifact/commit/ea165f8d65b6e75b540449e92b4886f43607fa02) |

The HTTP ZIP test actually uploads/downloads bytes through a loopback server,
checks ZIP root paths/hashes and invokes the existing Recovery bundle loader.
It is **not** an actual GitHub artifact-service run. GitHub manual workflows must
exist on default branch before dispatch; this unmerged PR cannot honestly claim
that end-to-end result. After separate merge/setup/test authorization, execute
capture/package and independently download/hash-check artifacts. Until then that
service-level acceptance is PENDING; never hijack an existing workflow or create
an unrelated paid resource to make a test green.
