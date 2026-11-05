# L-C4 Stage4 — local descriptive research integration

Scope: original HS root, research-only subpage launched from the 00631L home
card or More. No second site, financial storage API, score, entry authorization,
auto trading, Shadow recovery, production publication or PWA-core changes.

## Preserved baselines

Base `2de99f950d87b3f4befb4d507019dbe423320107`; stages1–3 and their887 evidence
files are immutable. `protect.py` checks every baseline blob except the explicit
code/test allowlist, Protected20, Provenance7, and all three original chains.
Evidence lives outside checkout in `../hs-lc4-stage4-evidence/`; old failed logs
are retained. The original dirty main and other worktrees are never modified.

## L7 repair

`operational_failure()` previously inventoried incidents BEFORE appending its
new failure, then persisted that old inventory. The cache held7 while the actual
valid chain required8 reviews. Now the immutable append keeps its prior context;
only the returned/persisted operational status is rebuilt from the post-append
validated canonical chain. No historical incident/status is rewritten by this
integration. The existing real-inventory test now compares exact IDs/hashes,
not a replacement hardcoded8. A newly appended local-write failure is PENDING,
never falsely marked review PASS. Fixture dry-run7 remains7. Historical RED and
GREEN logs are retained. Formal Shadow remains FAIL_CLOSED until its separately
authorized full integrity review and recovery contract is satisfied.

## Data and model

`data/lc4-research/seed-history.json.gz` packages the audited00631L2924 and
00502923 bars through2026-11-04, fixed15 event IDs and stage3 review metadata.
`seed-sources.json.gz` retains all314 original public-source response bodies and
their original SHA/URL/retrieval receipts. No personal holdings or secrets.
Known22:1 and4:1 splits are applied once in the seed; incremental overlap compares
the correct basis. Unknown split markers, OHLC conflicts, missing observed market
sessions, unreviewed leverage actions or invalid calendars reject promotion.

The fixed stage3 feature functions are imported, not rewritten or refitted.
Only the existing15-event cohort is followed; no new historical Forward signals
are generated. The UI shows available-case5/10/20 paths, sample denominators,
pending paths, gross next-open-to-low adverse excursions, further-low counts,
and post-hoc typical/worst illustrations. These are not account drawdowns,
executable lows, independent OOS evidence or forecasts. No0–100 buy score/tiers.

## Updater

From checkout, using the existing Python runtime:

```text
python scripts/lc4_research_daily.py --evidence <outside-checkout-directory>
```

It reuses the existing TWSE calendar, monthly parser, observed market sessions,
corporate-action validator and18:00 Taipei completed-daily policy. A research-only
supplement rejects official compensatory holidays containing補假 that the old
shared keyword check omitted; the production calendar is unchanged. A calendar
candidate alone never certifies a bar: BOTH instruments must independently reach
the observed target with overlap/action verification. Requests retain the shared
3-attempt bounded transport policy; semantic failures are not retried as success.

An exclusive process lock plus workflow concurrency prevents parallel publishers.
One immutable SHA-addressed bundle contains history, radar, risk stats and source
receipts. Readback is checked before the atomic latest-pointer replacement. A
crash can leave an orphan immutable bundle, never partially promote history.
Failed updates keep the previous verified bundle and expose a dated BLOCKED
operational status. Replay is idempotent. Reader checks pointer path, exact
length/SHA, schema, date, and non-authorized research contract. It labels overdue
source checks and unavailable/error states; no external financial trust root or
full rollback resistance is claimed.

`.github/workflows/lc4-research-daily.yml` defines18:45/20:45/22:45 Taipei attempts,
serialized, MAIN-ONLY and disabled unless `HS_LC4_RESEARCH_ENABLED=true`.
Permissions are READ ONLY. It preserves artifact/evidence, with NO Git push,
Pages dispatch or deployment. **Daily cloud execution and site publication are
not activated in this phase.** Wiring approved research artifacts into a future
normal Stable Pages release requires the next explicit approval; do not claim
the existing public site is updating from this branch.

## Preview and acceptance

Build with the existing `scripts/build_stable_app.cjs` to a NEW external output
directory; it automatically hashes/SRI-pins the two new assets. Use the existing
root, click the research launcher. No PWA manifest/scope/App identity changes.

`browser.cjs <evidence-directory> <built-site-directory>` uses installed Chrome
and bundled WebKit at320/375/390/1280. All profiles are isolated and all test
financial markers synthetic. External requests are blocked where interception
is supported; WebKit requests routed through its Worker can instead receive an
actual loopback-Origin CORS rejection. Each access-control exception must match
an explicitly aborted URL OR an actual requestfailed event recording that CORS
rejection. These are separately recorded, never counted as verified live-market
behavior. iPhone Safari and installed PWA
remain PENDING. The existing PWA protocol/browser harness is run independently.

The existing full-HTML financial seal remains: its projection strips ONLY four
exact reviewed research HTML literals. It still byte-compares the rest of the
complete HTML, plus negative mutation tests and all existing inline scripts.

Only local commits/preview are authorized. No Push, PR, Merge or Deploy.
