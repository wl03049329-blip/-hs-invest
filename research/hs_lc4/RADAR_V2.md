# 00631L 正二雷達 V2.0 — descriptive display contract

This is not a new C4 score or trading strategy. Frozen V1, annual threshold,
formal Shadow, protected research and financial data are unchanged.

## Two distinct populations / permissions

Current warning uses exact `max(0,-5D return percent)/5 >= 2.033335` during
2026 only. Display `-10.17%` is rounded, never used for comparison. After2026-12-31
the current-condition badge is expired, even if an old snapshot remains. 2027
requires original annual recalculation, independent review and approval.

History uses the SAME15 Stage2 predeclared annual-C95 events and70-session
cooldown, not a re-screening using2026 threshold. Some historical triggers were
below2026 threshold. No added thresholds/parameter search/outcome selection.

## Statistics (split-adjusted OHLC, trigger-close basis)

For each fixed event t and N=5/10/20, use only complete t+1 through t+N bars.
The old `mature` common-60-day flag is not used for per-horizon maturity.
Endpoint=t+N close/t close−1, positive strictly >0. Highest rebound=max future
high/t close−1. Touch+5/+10/+15 uses that same high return. Downside=min(0,min
future low/t close−1); break-low is strictly min future low < trigger-day low.
The legacy full-research MAE from next-open is preserved and explicitly labelled;
it is NOT silently reused for these trigger-close-basis statistics.

20-day peak buckets share exactly the complete20-day event population. Tied
maximum highs use the earliest occurrence, sessions1–5/6–10/11–20. This is
post-event descriptive information, not an executable exit or forecast.

Data are read from the existing SHA/length verified immutable research bundle;
all required dates/OHLC, frozen event identities and70-session gap are checked.
No data writes, new storage, financial APIs, synthetic production data or daily
scheduler enablement. No snapshot/model/frozen history changes for this display.
Source failures clear current numbers with an explicit diagnostic. Stale/failed
source metadata retains only dated historical values, no current badge claim.

Small samples, serial dependence, repeated historical model comparisons and
unavailable historical as-published vintages remain. Per-year results and every
event are in full research; these are not new independent out-of-sample results.

Release through existing normal PR/CI/Stable Pages only. Existing manifest,
Worker/update mechanism, financial stores and Writer OFF are preserved.
