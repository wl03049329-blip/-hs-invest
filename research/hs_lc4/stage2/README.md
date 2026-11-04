# L-C4 stage2: paired tactical timing and exits

This extends867c244 in the existing research branch. All stage1 source and evidence
are immutable. Outputs go to `../hs-lc4-stage2-evidence`, never into the original
`../hs-lc4-evidence`. Every old artifact is hashed before/after.

Preregister36 fixed timing/exit combinations before any stage2 performance run.
No formal score, trading permission, live capital or Shadow recovery is granted.
Past-inspected2018-2026 is historical temporal reanalysis, NOT a fresh holdout.

First produce a222-row forensic ledger, adjustment normalization/missing-session
appendices and the exact set difference between7 cached and8 canonical incidents.
Unknown vendor cause remains unknown: an official disagreement does not establish
the upstream provider's internal cause. No incident is approved or erased here.

## Reproduce without touching source1

```text
python research/hs_lc4/stage2/forensics.py --out ../hs-lc4-stage2-evidence
python research/hs_lc4/stage2/study.py --out ../hs-lc4-stage2-evidence
python research/hs_lc4/stage2/verify.py --out ../hs-lc4-stage2-evidence
python research/hs_lc4/stage2/report.py --out ../hs-lc4-stage2-evidence
```

The report includes all36 candidates, yearly and temporal-block performance,
closed-trade versus common-event uncertainty,59 paired comparisons in the two
declared families, exposure controls, costs, cash yields and failure trades.
Only14 common events are mature; the15th is censored for paired inference.
No fresh OOS exists in these already-inspected historical years. Even a positive
single unadjusted interval cannot justify a formal score or real-money signal.

Conservation checks independently reconcile all orders to cash, completed PnL,
open mark and compounded annual returns. Original stage1 code/evidence and every
legacy/production artifact stay pinned. Existing L7 failure is retained, not
"fixed" by changing7 to8. Report its cached pre-append versus canonical post-append
incident-set difference and propose separate maintenance only.
