# 00631L daily Forward Shadow

The daily job automates observation of **HS_LEVERAGE_C_V1**; it does not authorize
orders, capital, production signals, a holding horizon, or a strategy promotion.
The frozen threshold is **2.033335**, trained through **2025-12-31**, valid only
through **2026-12-31**. The job fails closed when this annual threshold expires.
An independently reviewed annual threshold is required before 2027 observations.

## Run and schedule

`00631L Daily Forward Shadow` runs on weekdays at **17:47, 19:47, 21:47 Taipei**.
GitHub schedules are best effort; runtime Taipei date decides eligibility. The
second and third runs are idempotent retries. Only main can publish. Actions has
`contents: write`, consistent with the repository's existing EOD publishers.

Manual Actions dispatch defaults to `dry_run=true`. Set it to false to publish.
Locally: `python research/hs_leverage/phase_l7_daily.py --dry-run` validates live
sources without mutating data or ledgers. Remove the flag to persist operational
state. There is deliberately no as-of-date/backfill parameter. The legacy
`phase_l7_shadow.py --evaluate-latest` manual command is not this daily pipeline;
do not use it to populate the automated ledger.

The workflow runs the isolated L7 tests first. All operational changes are one
normal Git commit; concurrent unrelated main changes are rebased. An overlapping
conflict aborts publication. No force push or frozen-artifact update is used.

## Data and integrity

- The original `data/00631L-historical-adjusted.json`, L2–L6 specifications,
  research outputs, and frozen mirrors are unchanged.
- `forward/00631L-adjusted-daily.json` stores the full operational daily series.
  Yahoo is queried with explicit period bounds and `interval=1d`; a provider
  response reporting monthly or intraday frequency is rejected.
- Adjust all four OHLC fields with adjusted-close / provider-close. Zero-volume
  holiday/suspension placeholders are excluded; missing actual current-year
  sessions are rejected by exact comparison with TWSE's monthly instrument data.
- Preserve the already-reviewed pre-2015 22:1 repair only when every restored
  field matches the frozen history. Compare every frozen and previously stored
  OHLC row to detect revisions. Missing historical dates fail validation.
- Verify all current-year trading dates and OHLC against official TWSE monthly
  reports, using the known March 31, 2026 split basis. Market holidays are read
  from TWSE with year-coverage validation. An unknown closure or suspension is
  fail-closed until the expected final session can be resolved; never guessed.
- Future/incomplete provider bars are excluded. No observation before 16:30
  Taipei, and only a same-date final bar can become an observation. Holiday runs
  may refresh context and mature existing outcomes, but cannot create a past
  signal. Collection crossing Taipei midnight is rejected.
- New corporate actions, history revisions, split-basis conflicts and unexplained
  forward price discontinuities stop publication of observations/outcomes. Source
  response hashes, retrieval time, and content-based data version are recorded.
  Provider volume is retained as provenance; it is not a strategy input.

Sources: [Yahoo Chart](https://query1.finance.yahoo.com/v8/finance/chart/00631L.TW),
[TWSE monthly daily OHLC](https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=20260901&stockNo=00631L),
[TWSE calendar](https://www.twse.com.tw/holidaySchedule/holidaySchedule?response=html),
[official split notice](https://www.twse.com.tw/zh/ETFortune/announcement?company=A00005&date=20260330&fund=00631L&seq=1&type=all).

## Ledgers and counting

Both existing policy paths are retained, with L7's append-only hash-chain
envelope. The protected L6 schema remains a specification artifact; L7's existing
runtime records already extend it. Daily records add source receipts and explicit
unresolved holding/risk-policy versions. `SHADOW_ENTRY` records separately link a
real, previously recorded trigger to its exact NEXT_OPEN. Initialization records
use the actual automation time, not the historical policy activation date.

`forward_observations` counts same-day evaluations, including non-signals.
`eligible_observations` counts new qualifying signals, excluding repeats.
`forward_samples` counts entries whose next-session open is available.
`pending_entries` counts qualifying signals awaiting that next session.

The original entry clock is preserved across skipped jobs and repeat signals.
A missed signal date is never reconstructed. A recorded signal may have its known
NEXT_OPEN reference and outcomes resolved on a later run; this does not create a
historical trigger. Outcomes use the existing L7 definition: entry index + H
completed instrument trading bars, with adjusted-low MAE and adjusted-high MFE.
The original 5D/10D diagnostics remain; the status's pending/completed totals
explicitly cover **20D/40D/60D**. No partial-horizon results are published.

**Holding remains unresolved in frozen L6.** After the first entry, repeats are
audited without pyramiding or clock resets. Even after 60D outcomes complete,
the engine does not invent a selected exit horizon, close/reopen automatically,
or accept a second independent position. Further independent entries require a
separate predeclared holding-policy decision. This preserves the current frozen
contract instead of silently choosing 20D, 40D, or 60D based on results.

## Failures and review

`forward/daily-status.json` exposes the latest check and counts; Actions also
writes a job summary. `daily-incidents.jsonl` keeps hash-chained failure audits.
Failure returns a nonzero exit code and a failed workflow; it cannot look green
because a status file was successfully committed. Transport/stale-source failures
may retry on the same day, with no observation from the failed attempt.

Integrity incidents requiring review remain latched even if a later fetch looks
normal. Follow the protected corporate-action recovery specification: investigate
the source, rebuild affected operational data under a reviewed version, verify
continuity and threshold impact, and append a reviewed `CORPORATE_ACTION_RECOVERY`
record naming the incident, a new data version, `integrity_review_status=PASS`,
`approved_by`, and at least eight documented recovery checks per the frozen
schema. No automated action invents that approval. All ordinary data checks still
must pass afterward. Never delete incidents, overwrite ledger records, relabel
old observations, or change a protected hash to bypass a failure.

## Validation

`python -m unittest discover -s research/hs_leverage -p 'test_phase_l7*.py'`

Tests use temporary ledgers and deterministic fixtures, including exact maturity
boundaries, delayed NEXT_OPEN resolution, holidays, stale/future timestamps,
wrong frequency/symbol, corporate actions, duplicate dates, tampering, pending
outcomes, transport recovery, integrity latching, no backfill and no pyramiding.
