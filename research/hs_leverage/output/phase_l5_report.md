# HS LEVERAGE Phase L5 — Risk / Position-Sizing / Deployment Feasibility

Verdict: **FEASIBLE_WITH_STRICT_RISK_CONTROLS**
L4 reproduction: **PASS**

This is an isolated tactical sleeve experiment, not a full portfolio backtest and not independent OOS validation.

## Downside distribution (adjusted-low MAE)

| Horizon | N | Median | P10 | Worst | <=-10% | <=-20% |
|---:|---:|---:|---:|---:|---:|---:|
| 20D | 27 | -7.266995 | -27.328654 | -39.785394 | 33.333333 | 18.518519 |
| 40D | 25 | -8.068125 | -32.130507 | -47.205747 | 44.0 | 24.0 |
| 60D | 24 | -7.858477 | -32.949486 | -47.205747 | 41.666667 | 20.833333 |

## Holding-horizon feasibility: E1 + 50 bps

| Horizon | N | Mean net | Median net | Win | Median MAE | Occupancy |
|---:|---:|---:|---:|---:|---:|---:|
| 20D | 27 | 4.500659 | 6.88625 | 70.37037 | -7.266995 | 23.231358 |
| 40D | 25 | 11.543039 | 10.073759 | 72.0 | -8.068125 | 38.862333 |
| 60D | 24 | 15.625576 | 11.775084 | 75.0 | -7.858477 | 51.147228 |

## Safety interpretation

Candidate C is operationally calculable without look-ahead, but adjusted-low path risk is materially larger than close-only MAE. Any future specification must fail closed on missing or inconsistent adjusted data, prohibit pyramiding, and treat the signal only as a bounded tactical sleeve.
