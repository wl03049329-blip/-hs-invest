# C4 P0 deployment readiness (local changes, not released)

Base: 95044b3beff427b09a334532f902876283ec11bd.
Owner has restored the Hobby subscription. This phase still does not authorize
payment, production deployment, commit, push or production data changes.

## Data and UI

Invalid LIVE selection keeps score, delta and next-level decision unavailable.
An independently verified FINALIZED value remains visible as a dated reference;
it does not supply a LIVE delta, threshold or signal.
The 9/16 and 9/21 UI fixtures are extracted from commit
09d7fdd5d7c7689cb7fd0d43d5f8208af7cf1b85, not generated production history.
The production archive contract remains chronological, unique and capped at
500 observations. Retained values and provenance must not change on publication.

## Health contract

/healthz HTTP 200 and status=ok mean the HTTP service is alive, not production healthy.
readiness_scope=LIVE_API_AND_SCHEDULER_ONLY:

- scheduler: DISABLED / STOPPED / STARTING / HEALTHY / STALLED;
  process-local heartbeat, task-running flag, 600 second threshold.
- data_status: CURRENT / OFF_SESSION / UNAVAILABLE;
  required_symbols_status is derived from the current validated public state.
- last_successful_bucket and age_since_last_success_seconds distinguish a live
  loop from a loop that has never completed a valid bucket.
- publication_status=DISPATCH_ACCEPTED means transport acceptance only.
  publication_complete remains false without external delivery evidence.

## Publication proof

The external read-only monitor requires all of:

1. The repository's artifact commit SHA exists.
2. A successful github-pages deployment includes that commit (Git compare).
3. The deployed commit's artifact and the public HTTP JSON contain the exact
   same latest snapshot as main, including score values and input fingerprint.

Partial delivery is never promoted by a workflow SUCCESS or HTTP 204.
A main/deploy/public race can temporarily produce an unverified result; a later
monitor observation can verify it without rewriting any artifact.

## Independent monitoring

scripts/check_c4_operations.py runs outside Railway. The proposed GitHub workflow
is opt-in via HS_OPS_RUNTIME_PROFILE=hobby-always-on, and uses Issues for operational
notifications (requires Issues enabled and an owner who watches notifications).
It never calls an ETF alert, captures a quote, computes C4 or writes production data.
Reports remain Actions artifacts, not new operational commits.

GitHub cron can itself be delayed. This workflow is independent of Railway,
but is not independent of GitHub scheduling. An existing, owner-controlled host
can run the same read-only command on its own scheduler:

    python -m scripts.check_c4_operations --fail-on-alert

The host supplies a read-only GH_TOKEN and the approved always-on runtime profile;
exit 2 tells its existing notification handler that an operational alert exists.
No additional paid service or host scheduler has been created in this phase.
This external host is still a deployment choice requiring confirmation.

Do not enable backend probes against Free/Serverless or use them as keep-alive.
The monitor rejects those profiles before issuing backend requests.
Simulation uses --fixture, optionally --now and --calendar-status; real monitoring
does not permit time or calendar overrides.

## Deployment risks and gates

Final local verification: Python 209/209 PASS; JavaScript 130/130 PASS;
15 workflow YAML files, live API JSON Schema, inline JavaScript and diff checks PASS.
No tests are skipped. Local quality is ready; owner release approval and the
remaining configuration checks below are required before production deployment.
The two requested historical-fixture failures are repaired, retaining the original
assertions. Seven additional failures also reproduce on untouched base 95044b3:

- tests/test_etf_radar_v2_phase1.js: old score-explanation copy.
- tests/test_etf_upgrade_integration.js: old featured-universe copy.
- tests/test_portfolio_official_quote_day.js: fixed 9/24 cache evaluated using the real clock.
- tests/test_swing_ui_integration.js: legacy Trade ID presentation assertion.
- tests/test_v6_integration.js: blanket console-call prohibition.
- tests/test_v61_market.js: old featured-universe copy.
- tests/test_v62_margin_integration.js: fixed product-version 2.0 assertion.

All seven are now repaired as test maintenance. No production UI or history was
changed for them. Original assertions remain except obsolete UI copy/location
expectations, which now exercise the current product behavior:

| Test / original base failure | Classification | Stable replacement |
| --- | --- | --- |
| test_etf_radar_v2_phase1.js:24, expected 目前分數主要來自 | OUTDATED_EXPECTATION | Current highest contribution label; execute summary up/down/missing cases; protect the current agreed detail order |
| test_etf_upgrade_integration.js:11, expected 固定追蹤 8 檔 | OUTDATED_EXPECTATION | Execute the actual featured/watchlist selector, check current catalog, unique symbols and ETF Universe membership |
| test_portfolio_official_quote_day.js:28, 行情快取更新時間不合理 | STALE_FIXTURE | Explicit fixture clock in try/finally; retain financial assertions and add stale/future rejection |
| test_swing_ui_integration.js:28, expected Trade ID in Portfolio | OUTDATED_EXPECTATION | Verify Trade ID/cooldown in the existing swing engine and ledger-derived Portfolio entry behavior |
| test_v6_integration.js:52, forbids every console call | OUTDATED_EXPECTATION | Execute interrupted restore, assert one literal non-sensitive warning and no holding/storage read; retain existing privacy assertions |
| test_v61_market.js:91, expected 固定追蹤 8 檔 | OUTDATED_EXPECTATION | Actual featured/watchlist selector and source contract |
| test_v62_margin_integration.js:10, fixed product version 2.0 | OUTDATED_EXPECTATION | Execute version loader against version.json and a second SemVer fixture; retain margin assertions |

All original failures also reproduced on untouched base 95044b3 with exit 1.
No tests were skipped or deleted.

The monitor's large-artifact path now uses the immutable Git blob because
Contents API can omit a 6.4 MB archive's body. Local tests protect this behavior,
cross-origin credential stripping, frontend-compatible display/as-of/WAIT_NATIVE
validation, and reject malformed or incomplete publication evidence.

Test-only runtime dependencies include httpx2, PyYAML and jsonschema in the
isolated test directory; production requirements were not modified.

Final protected review: 20/20 frozen hashes, 7/7 provenance mirrors and
working/provenance equality PASS. Forward, outcomes and incident hash chains PASS.
Nineteen core/history/Forward/Push/schema/bridge files remain byte-identical
to HEAD. Original dirty main and stash remain untouched.

## Railway pre-deploy checklist

- Owner confirms a valid subscription and approves release.
- Recheck remote main and scope before any commit; never overwrite dirty main.
- Preserve original service 797e0e73-d2d1-4499-a8dd-629c2e78c57e,
  production domain and /data Volume. Do not recreate them.
- Verify production mode, Volume mount/writability, origin, Fugle and artifact
  token presence, VAPID configuration without printing secrets.
- Keep one API worker / one scheduler replica with existing Volume locks.
- Confirm always-on runtime and spending alerts; no keep-alive workaround.
- Verify /healthz scheduler/data/publication fields, not just HTTP 200.
- Opt in to monitor only after always-on confirmation; verify Issues permissions
  and actual notification receipt. External scheduler remains a separate choice.
- Verify artifact commit inclusion, Pages success and public JSON before claiming
  delivery. No historical session is replayed during startup.

## Rollback plan

95044b3 is the review base, not automatically the final rollback target. At release
time record the true pre-release main SHA and Railway deployment ID, since official
data updaters can advance main. On failure, revert only this release's code commit
through a normal fast-forward commit and the existing deployment process.
Never restore old FINALIZED/archive/ledger files wholesale, reset dirty main,
force push, delete the Volume, or replace Push subscriptions/secrets.
The monitor opt-in can be disabled after approval if notification behavior fails.

## Next trading session acceptance

Wait for a legal trading day and natural Railway capture. For 10/13, the prior
official baseline must be the verified 10/12 FINALIZED; on a later release date,
use the most recent valid prior trading day, not a hardcoded date.
Verify five-symbol source date, quote timestamps, 5/5, version, freshness <=600s,
scores/deltas/thresholds, dedupe, repository commit, Pages and public JSON.
Validate 390px UI, stale/failed-source hiding, reconnect/foreground recovery,
ongoing trajectory accumulation and post-close preservation. Check GitHub fallback
and alert delivery separately. Natural acceptance remains pending, not replaced
by local fixtures or a manual dispatch.

- Subscription has been restored by the owner; the original service is online.
- Keep original service, domain and Volume; no migration or recreation.
- GitHub artifact publication still depends on GitHub availability.
- Issue notification receipt and external scheduler timing require real validation.
- Free resource averages may fit, but cold-start memory peaks and Volume growth
  are not certified under 0.5 GB limits.
- Serverless sleep stops the process-local scheduler. An in-process timer cannot
  wake the service next morning; paid always-on is the current reliable topology.
- No test fixture constitutes real intraday evidence.
- Only a naturally captured five-symbol current-session run with verified
  publication and UI can establish PRODUCTION PASS.

## Read-only pre-release recheck, 2026-10-12 Taipei

Remote main, isolated HEAD and local origin/main all remain
95044b3beff427b09a334532f902876283ec11bd. No integration is needed at this check.
All 26 candidate files remain uncommitted. This recheck changes this report only.
Python 209/209 and all 130/130 JavaScript test files passed again. Workflow YAML
15/15, inline JS, Python syntax, schema tests and diff check pass. Protected
hashes 20/20, provenance 7/7 with working equality, all three ledger hash chains,
and 19 explicit core/history/bridge/Push file byte comparisons pass.

### Current deployments and runtime

- Railway deployment: 29b534a5-808c-4f6c-8e6b-798613eb73c2, SUCCESS/RUNNING,
  created 2026-10-12 23:38:06 Taipei; reason=redeploy.
- Active code SHA: bd1995a13feee909865b30eac7e5aa7363f80d25. It is a redeploy of
  the previous version, not a new build of latest main or of these local fixes.
- One active instance; startup log shows one server process [1]. Docker CMD is
  uvicorn --workers 1. No start-command override or scheduler-disable flag.
- GitHub trigger is main, checkSuites=false, watchPatterns=[]; a future main push
  can trigger deployment immediately. Do not combine push with a second manual
  deployment. No queued competing deployment was observed at this check.
- Original service 797e0e73-d2d1-4499-a8dd-629c2e78c57e, original domain
  hs-invest-production.up.railway.app, original Volume
  616ff120-a11f-4237-998a-01ef133d07ba, /data, READY, 66.707456/500 MB retained.
- Serverless sleepApplication=false; mode=production. Fugle, artifact publisher
  and VAPID credentials are present; only existence was printed. CORS matches
  https://wl03049329-blip.github.io. BACKGROUND_ETF_ALERTS_ENABLED=true;
  two active Push subscriptions, readiness READY. No test push was sent.
- At 23:51 Taipei, healthz and live-scores return HTTP 200 with matching CORS.
  CLOSED/MARKET_CLOSED, five null scores/deltas and 009815 WAIT_NATIVE are valid.
  Last successful capture remains 2026-10-08 13:30. Current health does not yet
  contain the new scheduler/readiness contract; that code is not released.
- Pages deployment 7007734885 / run 38211659972 succeeded for 95044b3.
  Public FINALIZED latest date is 2026-10-12. Public rolling archive has 500
  observations, latest SUCCESS 2026-10-08 13:30. No 10/12 backfill occurred.
- A one-shot read-only operations check at 23:56 Taipei returned OFF_SESSION,
  no alerts and PUBLISHED_VERIFIED: archive commit
  6540920dbacff29c1136413b6d037d962426a6c8 is included in Pages 95044b3 and the
  deployed/repository/public snapshot values match. This verifies delivery of the
  old 10/08 13:30 snapshot only; it is not natural intraday acceptance.

### Remaining configuration checks

1. Region/config discrepancy: the current deployment manifest and Volume region
   are iad. Tracked railway.json (unchanged even in active source bd1995a) declares
   asia-southeast1-eqsg3a. Railway resolvedFileConfig currently reports an empty
   fileManifest and null configFile. Before approving a new build, establish which
   configuration that build will apply and preserve the original Volume region.
   Do not silently migrate the Volume, change railway.json or change service config.
2. Workspace usageLimit=null. The US$5 hard limit returned under agentUsage is
   an Agent limit, not a service spending cap or service alert. No configured
   workspace usage warning/limit was verified. Owner must choose service spending
   alert settings; do not set a stop-service hard cap without explicit approval.
   The newly opened billing period starts 2026-10-12 23:37:59 Taipei. Its first
   few minutes of usage are not a reliable monthly estimate or a US$5 guarantee.
3. GitHub Issues are enabled, but HS_OPS_RUNTIME_PROFILE is absent. New monitoring
   will remain disabled until the approved post-release opt-in. Notification
   receipt is unverified. GitHub cron is not independent of GitHub delays; an
   existing independently scheduled host remains an optional owner decision.

### Exact candidate commit scope

One proposed commit: `fix: harden C4 live readiness and fail-closed presentation`.
No commit exists yet. Stage only these explicit paths, never git add -A:

```text
backend/app.py
backend/scheduler.py
backend/state_store.py
hs-live-source-adapter.js
index.html
tests/test_decision_center_phase2.js
tests/test_etf_radar_v2_phase1.js
tests/test_etf_upgrade_integration.js
tests/test_home_intraday_ui_safety.js
tests/test_live_updates.js
tests/test_portfolio_official_quote_day.js
tests/test_swing_ui_integration.js
tests/test_v61_market.js
tests/test_v62_margin_integration.js
tests/test_v6_integration.js
.github/workflows/c4-operations-monitor.yml
docs/c4-p0-deployment-readiness.md
scripts/check_c4_operations.py
tests/fixtures/intraday-ui-historical.json
tests/helpers/current-product-contracts.js
tests/test_c4_monitor_workflow.js
tests/test_c4_operations.py
tests/test_c4_readiness.py
tests/test_intraday_archive_retention.js
tests/test_intraday_service_resume.py
tests/test_live_incident_consistency.js
```

### Execution plan after explicit release approval

1. Resolve the region/config and usage-alert choices above without modifying any
   data. Recheck active deployment, pending builds, remote main and candidate diff.
   If main advances, safely integrate only in isolation and repeat affected tests.
2. Record the final pre-release main SHA and active Railway deployment ID again.
   Commit the 26-path allowlist with core.autocrlf=false and verify the staged scope.
3. Normal fast-forward push only. Let the existing GitHub linkage build Railway
   and existing Pages process publish the frontend. Watch both deployment SHAs;
   no railway up, duplicate manual deploy, workflow dispatch or historical capture.
4. Verify the new Railway SHA/one instance/one worker/scheduler heartbeat, original
   /data mount, Push readiness, CORS and schema. Closed-session scores stay null.
   Verify Pages commit inclusion and actual public content, not only build success.
5. After approved monitor opt-in, verify issue permissions and notification receipt.
   Do not send ETF trading alerts merely to test operations monitoring.
6. Await natural legal-session captures and the acceptance matrix above. Verify
   10/12 FINALIZED as the prior baseline for 10/13, if that is the next legal day.

### Concrete rollback anchors

Frontend/main baseline: 95044b3beff427b09a334532f902876283ec11bd.
Railway pre-release deployment: 29b534a5-808c-4f6c-8e6b-798613eb73c2.
Railway pre-release source: bd1995a13feee909865b30eac7e5aa7363f80d25.
These are different baselines; do not claim HEAD currently equals deployed backend.
After release approval, if needed revert only the new code commit on latest main
and use normal fast-forward deployment. For immediate backend restoration,
restore the recorded deployment through the existing service only if authorized;
do not run an extra replica or overwrite Volume state. Preserve all intervening
FINALIZED/archive/Forward updates, subscriptions, secrets and original dirty work.
No rollback, config change, notification, commit or deployment was executed here.
