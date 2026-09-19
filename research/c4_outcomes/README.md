# Phase 7A — Historical Outcome Research Engine

This directory is research-only. It is not imported by the homepage, ETF ranking, live score, formal signal, FINALIZED history, Forward, API, scheduler, or `HS_LEVERAGE_C_V1`.

## Sources and timing

- Conditions come only from parity-checked `research/c4_historical/{0050,00662,00830,00935}.json` with `data_status=RESEARCH_HISTORICAL` and `weekly_j_version=WEEKLY_J_PRODUCTION_LEGACY_V1`.
- Outcome prices use the matching `research/c4_historical/source/{symbol}.json` and the same `adjustPriceHistory` adjusted/restored convention as Phase 6.5B.
- A condition is classified at day `t` close. A forward `ND` return is `adjusted_close[t+N] / adjusted_close[t] - 1`, where `N` counts trading observations, not calendar days.
- A horizon remains `null` and `mature_Nd=false` until the `t+N` observation exists.
- Transaction costs, taxes and slippage are excluded. No outlier is removed or winsorized.

## Outputs

- `raw/{symbol}.json`: every level daily sample, every upward level-entry event (`ENTRY_ALL`), and the condition-specific `NON_OVERLAP_60D` subset.
- `summary/{symbol}.json`: per-ETF aggregates for level daily samples, level entry events, non-overlapping entry events, `40+/50+/65+/70+/80+/90+` threshold samples, and DD52 daily bands.
- `index.json`: artifact paths, hashes, counts and fail-closed coverage. `009815` is `HOLD` until native research history exists. `00631L` is excluded.

Each horizon reports `sample_count`, mean, median, positive rate (`return > 0`; zero is not positive), best, worst, p25 and p75. `sample_class` is `VERY_SMALL` below 10, `SMALL` for 10–29 and `NORMAL` at 30 or more.

## Overlap semantics

- `LEVEL_DAILY` keeps overlapping daily observations and is labelled `ALLOW_OVERLAP`.
- `LEVEL_ENTRY_UP` records only the first day entering a higher formal level. A multi-level jump creates one event at the final level and records every crossed threshold.
- `NON_OVERLAP_60D` retains entry events at least 60 trading observations apart for the same ETF and target level. `ENTRY_ALL` is always preserved separately.

## Integrity and regeneration

The builder validates research version, strategy/formula version, record count, record hash, artifact hash, parity status and the matching OHLC source hash before producing any ETF output. A failure in an eligible ETF aborts publication rather than writing a partial summary.

Run after an explicit source/code review:

```text
node scripts/build_c4_historical_outcomes.js
```

Existing outputs require the explicit `--regenerate` flag. `content_sha256` excludes only `generated_at`, so the same source, code version and generation commit reproduce the same content hash. `artifact_sha256` includes the audit timestamp.
