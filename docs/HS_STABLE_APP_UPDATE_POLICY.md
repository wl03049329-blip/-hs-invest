# HS_STABLE_APP_UPDATE_POLICY

## Stable identity and integration

- Production App URL: `https://wl03049329-blip.github.io/-hs-invest/`.
- Preserve `site.webmanifest` identity: current `start_url: ./`, `scope: ./`,
  absent explicit ID (do not silently replace its derived identity), original
  icons, Apple standalone metadata and root `push-service-worker.js` URL/scope.
- Root/index.html and supported historical installed-launch paths load the same
  current app. Portfolio is an original bottom tab, not a second website.
- Never ask users to reinstall an icon or erase Safari data as an update step.
  iOS may retain a suspended old document; web code cannot guarantee when the OS
  next executes an updated document. Report physical-icon testing as PENDING
  unless the existing installed icon has actually been tested.

## Build/deployment contract

The main-only `HS Stable App Pages` workflow builds a complete static artifact
using the exact GitHub commit. `version.json` is the release version source.
`app-release.json` records version, exact commit, Run ID, storage contract and
critical asset lengths/SHA-256. Code commit and exact deployment commit are
separate: data-only deployments refresh published JSON without forcing a code
reload. The historical V3 release receipt is an alias, not stale file attestations.
HTML has exact build/Worker pins; every external
JS/CSS uses its content hash plus SRI. Worker code is appended at build time;
Worker hash is calculated before stamping HTML; only then is HTML hashed. There
is no self-referential hash or guessed future commit.

Updates stage every declared asset and verify it before a complete marker.
Only a complete version can become active. The code-only IndexedDB
`hs.app.shell-update.v1:<project-scope>` atomically CASes the release pointer.
CacheStorage keys are project-scoped and begin `hs-app-shell-v1-`; new complete
shells use the `-v2` suffix, which the legacy V3.2 pruner cannot delete. A native
Worker Web Lock serializes code-cache staging, failed-stage cleanup, pruning and
activation; prepare+CAS share one lock. It is a separate domain from financial
locks. A missing Worker lock rejects updates, not silently emulated locking.
Legacy code caches are retained; GC only removes unneeded v2 code caches.
The same-commit/digest legacy active pointer can move to the verified v2 cache
without changing the selected code or financial data. Financial
databases/localStorage are not touched. Active, previous and known open-client
shells remain available; unknown clients prevent cleanup. Hashed code assets are not substituted by
unversioned network data. Financial/market responses are not offline shell data.

Verified installed-shell navigation does not wait for online update checks.
Manifest/asset deadlines cover the entire body, not just response headers.
Only materialized, length/SHA-verified cached bytes are returned to the browser;
already-decoded transport encoding/length headers are not reapplied.
Evicted/damaged installed code is repaired only against that exact recorded
release's bytes/SHA, under the same code lock; unavailable/mismatched bytes
remain an explicit503. Financial stores are not a repair target.
Code-metadata reads settle on transaction completion and reject transaction
abort/error even if a request succeeded. Navigation, checks/status and
activation/CAS read the actual database; a code-pointer memory-hint attempt was
not retained because stale routing is not the update authority. An older code
shell cannot claim CURRENT without matching selected code and Controller reply.
App startup, foreground/pageshow and online transitions check for updates.
Installed `registration.active` is not proof of document control. Send check/status
to the actual activated Controller. CURRENT requires its build, selected active
commit and loaded code to agree. Follow both controllerchange and the new
Controller's statechange: claim can happen during activate. Until complete use
WORKER_HANDOFF; never substitute Registration object identity for a build reply.
Registration initialization must not await one captured installing/waiting object
becoming activated. A verified installed Worker can legitimately wait for old
extended events even after skipWaiting resolves. Observe live registration,
updatefound, pending statechange and actual Controller changes; after the unchanged
25-second observation bound show an explicit waiting status, not installation
failure, and do not latch off subsequent Controller verification. Query only local
HS_APP_STATUS on an older Controller, not another network-staging HS_APP_CHECK.
CURRENT still requires the actual activated Controller build, selected active
commit, loaded UI and verified release to agree. Native failure/redundancy without
a usable replacement remains rejected. Never force-close a client, discard input,
clear financial stores or skip validation to resolve waiting.
Existing editing/saving/recovery prevents automatic reload; an update prompt is
shown. Reload has a per-target session bound and a mismatched-build diagnostic.
Offline uses the saved code version, not fabricated quotes or current scores.
Unknown/incomplete updates remain incomplete; do not label them current.

## Data boundary

- Retain V2/legacy stores; V3 remains `hsPersonalV3.v1.`. No automatic migration.
- Preserve Ledger, cash, encrypted backups, original costs and financial math.
- Any change to the storage contract blocks unattended activation. A separate
  authorized migration requires verified backup, preview and explicit consent.
- The existing Worker byte check remains; the trusted build supplies its exact
  pin instead of allowing arbitrary Workers. No test flag bypasses validation.
- No production Financial Writer, auto-BUY or real broker connection.
- LOCAL_ONLY has no external high-water and no automatic device sync. It does
  not resist full local rollback or malicious same-Origin code; do not claim so.

## Mandatory release acceptance

1. Preserve prior deployed artifact, exact SHA, Pages settings and data hashes.
2. Run build/protocol/storage/SW tests and directly affected existing tests.
3. Test root and index/historical routes with original tab navigation; verify
   `.pv3`, layout order, compact rows, no visible V2 fallback and all other tabs.
4. Test previous Worker to current, code upgrade, foreground, offline/reconnect,
   partial/hash-failed updates, concurrent checks, busy forms, no reload loop,
   restart and rollback. Verify data bytes and encrypted backup/restore.
   Record a new Document timeOrigin and actual UI/data/controlling-Worker state;
   API existence or DCL alone is not sufficient during a Worker handoff. Include
   headers-only body stalls and cross-Worker failed-staging interleavings.
   Include an actual V3.2 old extendable message event whose headers arrive while
   its body is held: prove installed/waiting is not install rejection; release it
   after the old25s bound and require event-driven CURRENT with exact data bytes.
   Use synchronous waitForFunction predicates and separately await Worker replies.
   The validated local Playwright1.62.1 accepts an async-false Promise as truthy
   (returns a false handle without polling); it is not a readiness wait.
5. Public browser verification must match artifact SHA/commit/version, actual
   script/CSS pins and rendered root UI. A Pages SUCCESS alone is insufficient.
6. Test real existing iPhone home-screen icon, full close/reopen and foreground
   when hardware is available. WebKit mobile emulation is not that test.
7. Use normal PR/merge and only the stable Pages workflow. No dirty-main merge,
   reset/clean, financial workflow dispatch or unrelated PR operations.

Data publication must not depend on GITHUB_TOKEN pushes triggering another push
workflow. The existing radar publisher dispatches only the site build, waits for
completion and verifies public JSON plus the deployment receipt. Other approved
data workflows are followed by successful main-only workflow_run events. Never
dispatch Packaging or Recovery as a site-update step.

Retain failed environment evidence. Windows WebKit persistent-profile storage
loss has been independently reproduced on an empty page; isolated-context
reload tests do not certify native restart or real iPhone behavior.

## Rollback

Deploy a new revert commit through the same workflow (new build SHA, original
compatible code); do not reset branches or restore historical financial JSON.
Keep complete old shell/artifact and previous Pages settings. If this first
rollout fails, return Pages source to preserved legacy/main only with the
compatible previous root source restored by a normal commit. Never roll back
owner assets/Ledgers to solve a code incident.
