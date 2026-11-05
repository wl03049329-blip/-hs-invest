# L-C4 Stage5 — pre-release acceptance, NOT deployment authorization

Base: `45c4224e9d91b42f180dbcdafe3df055a5dbba35` on the original research branch.
All models, weights, fixed15 events, seed histories, previous snapshots, L7
repair/incident chains, C4 and financial data are preserved. This document
supersedes Stage4's artifact-only publication limitation, not its model protocol.

## Daily pipeline (implemented, all production gates still OFF)

1. Taipei18:45/20:45/22:45 weekdays are candidate attempts. No scheduler variable,
   environment, token or remote workflow has been configured/activated in Stage5.
   A manual workflow defaults to `dry-run`. Scheduled generation requires
   `HS_LC4_RESEARCH_ENABLED=true` on main.
2. Generate into a NEW isolated staging directory using official TWSE calendar,
   observed market sessions, both instruments' monthly OHLC and corporate-action
   evidence. Preserve the existing18:00 completed-daily policy. Raw/action/session
   captures must be after that target day's completion cutoff, not cached intraday
   responses relabeled after the close. A date candidate is never source proof.
3. Revalidate from the SAME parent history used by generation, replaying the exact
   source URLs/hashes/ranges. Require target date, source chronology, complete bars,
   immutable archive chain, frozen descriptive outputs and non-trading contract.
   A verified-current NOOP is explicitly distinguished from a new daily snapshot.
4. Produce a SHA-bound publication plan. Only `status.json`, `latest.json` and NEW
   immutable research snapshots can change. Existing snapshots/seed files cannot
   be overwritten/deleted. Delta artifacts contain changed research bytes only,
   not the growing archive or financial files. Evidence/plan are retained7 days;
   permanent research snapshots remain versioned in Git. Check existing free
   Actions/Pages/storage quotas before activation; no paid service is provisioned.
5. Reconstruct the candidate against the exact main parent and revalidate again.
   Publication requires ALL THREE variables true: `HS_LC4_RESEARCH_ENABLED`,
   `HS_LC4_RESEARCH_PUBLISH_ENABLED`, `HS_LC4_RELEASE_APPROVED`; main-only Actions,
   approved event, clean checkout and the `hs-lc4-research-publish` environment.
   Configure required environment review and verify repository protection rules
   only AFTER separate user approval. Do not bypass a branch-rule rejection.
6. Commit only planned research paths; non-force push to main. Reject concurrent
   main changes; no automatic rebase, force push or overwrite. A lost push reply
   remains PUSH_REQUESTED/unknown, never blindly retried. Save the exact commit
   and phase outside the checkout for operator recovery.
7. Because GITHUB_TOKEN pushes do not trigger another push workflow, dispatch
   ONLY existing `hs-stable-pages.yml`. Await a newly observed matching-main-SHA
   Run, require success, then verify public deployment receipt, research pointer,
   complete bundle SHA/length, operational status, root HTML and JS/CSS hashes.
   A successful dispatch/Run without matching public bytes is NOT a release.
   Verification has6 bounded attempts; it never repeats the write to fix a CDN.

## Failure behavior

- Source/schema/revision/split/calendar/incomplete-session faults stop generation
  or planning. Previous verified research state remains, and failure diagnostics
  are saved in staging/artifacts. Workflow failure is explicit; no continue-on-error
  converts blocked data to a green production result.
- The existing reader labels overdue research as waiting for source verification;
  unknown/hash-invalid data produces no unverified research values. A source failure
  artifact is not promoted as a new valid snapshot. Owner details stay in the Run
  evidence; the public last-known record cannot pretend its old date is current.
- An update interrupted before latest-pointer promotion leaves only an orphan
  immutable bundle. Interrupted after pointer/before matching status cannot pass
  the publication gate. Next fresh staging starts from the verified Git parent.
- Research success NEVER approves formal Shadow. FAIL_CLOSED and WriterOFF remain;
  no official L-C4 score, entry condition, capital allocation or buy suggestion.

## Local commands (no remote writes)

```text
python scripts/lc4_research_daily.py --dry-run --output <NEW_OUTSIDE_CHECKOUT_STAGE> --evidence <OUTSIDE_CHECKOUT_EVIDENCE>
python scripts/lc4_research_release.py plan --staged <STAGE> --evidence <EVIDENCE> --plan <OUTSIDE_CHECKOUT_PLAN_JSON>
python scripts/lc4_research_release.py package --staged <STAGE> --evidence <EVIDENCE> --plan <PLAN_JSON> --delta <NEW_DELTA_DIRECTORY>
python scripts/lc4_research_release.py materialize --staged <NEW_STAGE> --delta <DELTA> --evidence <EVIDENCE> --plan <PLAN_JSON>
```

`execute` is not a local-preview command. Its production guard rejects a local
shell, a research branch, absent approvals, an unsupported event or dirty checkout.
Stage5 exercises it ONLY with simulated command adapters in temporary Git fixtures.
Those PASS results are contract tests, not GitHub/Pages deployment evidence.

## Minimal future release / rollback (await explicit approval)

- Reconcile this research PR against the then-current main without touching the
  original dirty main. Preserve all recent production fixes. Normal CI/review/merge,
  Stable Build and Pages only; no second website and no PWA identity change.
- First release with scheduler/publication flags OFF; publicly verify the original
  HS research entry, exact assets/data, all five tabs and existing installed launch.
  Separately authorize enabling the guarded data job/environment. Confirm actual
  environment reviews, free quotas and main write policy; do not invent approval.
- Verify the first real daily publication from actual official receipts through
  the matching successful Run and public bytes before declaring live daily service.
- On anomaly, disable research publication variables first. Use a NORMAL reviewed
  code commit to remove/disable ONLY the research launcher/component if needed;
  preserve the L7 timing repair, all research archives and all financial storage.
  Do not revert the entire Stage4 commit or rewind users' data to solve a UI fault.
- `rollback_review()` verifies reachable historical snapshots and labels them
  HISTORICAL_REVIEW_ONLY. It does not silently promote an older date as latest or
  decrement generations. No claim of external high-water/anti-rollback authority.

## Evidence and pending items

Stage5 evidence is outside checkout in `../hs-lc4-stage5-evidence/`; all prior
stages' evidence is sealed read-only. `audit.py` checks baseline blobs, Protected20,
Provenance7, three chains and phase boundaries. Original dirty-worktree audit is
also reused read-only. Real iPhoneSafari/installedPWA remain PENDING. WebKit
simulation never substitutes for hardware acceptance. Remote PR/CI/environment/
quota/public-site checks remain activation-time requirements, not performed now.
