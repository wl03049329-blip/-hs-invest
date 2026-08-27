# HS LEVERAGE Phase L6 — Production Specification / Risk Policy Design

## Decision

- Strategy: `HS_LEVERAGE_C_V1`
- L6 verdict: `SPEC_READY_FOR_SHADOW_IMPLEMENTATION`
- Current deployment status: `NOT_READY_FOR_LIVE_CAPITAL`
- Scope: specification only; no production implementation, UI, alert, order, commit, push, or deployment

## Frozen V1 identity

Candidate C remains unchanged: `CrashVelocity5 = max(0, -ret_5d) / 5`, qualifying at the annual Top-5% threshold derived from eligible positive training observations through the prior year-end. The threshold is frozen for the new calendar year. The signal is known only after the adjusted daily bar is final, and the earliest entry reference is the next trading-day open.

Adjusted/restored OHLC is mandatory. Raw and adjusted history may never be mixed. Any missing, stale, incomplete, invalid, discontinuous, schema-incompatible, or corporate-action-uncertain input produces `FAIL_CLOSED / NO_SIGNAL`.

## State and exposure policy

The deterministic states are `IDLE`, `SIGNAL_PENDING`, `ENTRY_ELIGIBLE`, `ACTIVE`, `COOLDOWN_HOLDING`, `CLOSED`, and `FAIL_CLOSED`. No state authorizes automatic order execution in L6.

The exposure policy is one position at a time with no pyramiding. A repeat signal while active is appended to the audit ledger but does not add capital, reset entry, restart the holding period, or increase sleeve size.

## Unresolved risk decisions

The final horizon remains unresolved among 20D, 40D and 60D. The final allocation also remains unresolved. Bands S/M/L/XL label 5%/10%/15%/20% historical stress scenarios; they are not recommendations or future loss limits. Any future exposure above 10% requires explicit additional risk approval.

These unresolved decisions block Production Gate 5.

## Shadow and audit policy

Shadow mode is required before any live-capital decision. It calculates the frozen signal daily, records the planned next-open reference, allocates no capital, shows no buy recommendation, and appends outcomes only after each horizon completes. No parameter changes are allowed during the shadow period.

The ledger is append-only. Corrections preserve the original record and append `original_record_id`, `correction_reason`, and `new_data_version`. The minimum shadow requirement is at least one full annual threshold cycle or a future explicit research decision; no arbitrary event-count gate is invented.

## Acceptance gates

| Gate | Current status | Requirement |
|---|---|---|
| 1 — Research | PASS | L3, L4 and L5 complete |
| 2 — Data | NOT_STARTED | Reproducible adjusted-OHLC pipeline and validated fail-closed behavior |
| 3 — Signal | SPECIFIED_NOT_IMPLEMENTED | Reproducible frozen daily calculation |
| 4 — Execution | SPECIFIED_NOT_VERIFIED | Next-open semantics verified in shadow mode |
| 5 — Risk policy | BLOCKED_UNRESOLVED | Final horizon and exposure cap explicitly approved |
| 6 — Shadow | NOT_STARTED | Forward shadow operation without hindsight mutation |
| 7 — Review | NOT_APPROVED | Explicit human approval before any live capital action |

## Next permitted phase

Phase L7 may implement shadow calculation and forward observation only. It must not enable live trading, capital allocation, production recommendations, or silent rule changes.
