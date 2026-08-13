# Phase 7B — Add 00757 to Long-Term ETF Production Universe

## Result

00757 is integrated as a normal `LONG_TERM_ETF` using the single frozen FINAL_CORE_WEIGHT_V1. No ticker-specific model, weight, mapping, ranking bonus, or volatility adjustment was added.

## Readiness

The native adjusted series covers 2018-12-06–2026-08-13, 1866 trading rows and 396 weekly observations. Weekly J, 252-row adjusted intraday-High DD52, and 20-close Crash are all ready. Data status is **ETF_NATIVE_HISTORY**.

## Current snapshot

- CoreScore: **3.3**; display: **3**.
- Label: **一般持有**; historical trigger: **一般區間**.
- Weekly J: 92.60462 / score 0 / contribution 0.
- DD52: -1.756235% / score 6 / contribution 3.3.
- Crash: -1.68717% / score 0 / contribution 0.
- Rank among scored long-term ETFs at common 2026-08-13 snapshot: **4/5**.
- marketAsOf: 2026-08-13T13:30:00+08:00.

## Sanity

Eligible daily observations: 1615. Threshold frequencies are recorded without re-tuning in `00757_score_distribution.csv`. Stress windows are recorded in `00757_stress_validation.csv`; Frozen mappings were not altered based on results.

## Safety

- 009815 remains unsupported by the canonical adapter and therefore N/A / FAIL_CLOSED.
- Version remains 2.0.
- Auxiliary valuation, fear and Bias40W do not enter CoreScore.
