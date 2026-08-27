# HS_LEVERAGE_C_V1 — Risk Policy Specification

Status: `RESEARCH_FROZEN / SPECIFICATION_ONLY / NOT_READY_FOR_LIVE_CAPITAL`

This document translates L5 evidence into policy labels and approval boundaries. It does not choose an allocation, authorize trading, or define a future loss guarantee.

## Policy invariants

- Instrument: 00631L.
- Signal: frozen Candidate C, `CrashVelocity5 >= annual Top-5% threshold` from eligible positive training observations.
- Prices: adjusted/restored OHLC only.
- Earliest entry reference: next trading-day open.
- No pyramiding and one position at a time.
- A repeat signal is logged but never adds capital, resets entry, or restarts the holding clock.
- Missing, stale, incomplete, inconsistent, or corporate-action-unsafe data produces `FAIL_CLOSED / NO_SIGNAL`.

## Tactical sleeve bands

These are descriptive labels. The values below are a **historical stress reference, not a future loss limit**. They use the conservative L5 60D adjusted-low MAE distribution.

| Band | Label | Sleeve | Median portfolio MAE | P10 portfolio MAE | Worst portfolio MAE |
|---|---|---:|---:|---:|---:|
| S | SMALL | 5% | -0.39% | -1.65% | -2.36% |
| M | MODERATE | 10% | -0.79% | -3.29% | -4.72% |
| L | ELEVATED | 15% | -1.18% | -4.94% | -7.08% |
| XL | HIGH | 20% | -1.57% | -6.59% | -9.44% |

No final allocation is selected. Initial production eligibility, if later approved, must remain within SMALL or MODERATE exposure until shadow evidence accumulates. Any future proposal above 10% requires explicit additional risk approval. This guardrail is not a return-optimization rule.

## Holding horizon decision

Status: `HOLDING_HORIZON_UNRESOLVED`. This blocks live-capital approval.

| Candidate | Research trade-off |
|---|---|
| 20D | Faster recycling, lower occupancy and positive OOS evidence, but lower cumulative tactical contribution. |
| 40D | Stronger observed return profile and moderate occupancy, with greater overlap pressure. |
| 60D | Highest observed absolute return and about 51% research occupancy, with more long-beta exposure and holding-time uncertainty. |

The horizon must be selected by a separate, predeclared risk-policy decision. L6 does not select a winner based on return.

## Regime warning

Regime is diagnostic only. `BEAR` adds the warning `HIGHER_PATH_RISK`, reflecting worse typical L5 MAE. It does not cancel a signal, change a band, alter the threshold, or modify the holding horizon.

## Exposure and sequence controls

- Exactly one logical position may be active.
- New signals during `ACTIVE` or `COOLDOWN_HOLDING` create append-only repeat-signal records only.
- Additional capital, entry reset, holding-clock reset, and pyramiding are prohibited.
- A future implementation must expose the selected sleeve band, approved cap, holding-policy version, and risk-policy version in every record.
- A missing or unresolved final risk decision blocks Gate 5 and all live-capital use.

## Approval boundary

Historical evidence supports shadow implementation, not deployment. Before live capital can be considered, the adjusted-data pipeline, calculation, next-open semantics, holding horizon, exposure cap, shadow operation, and explicit human review must each pass their acceptance gate.
