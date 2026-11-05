# L-C4 stage3 — descriptive state radar, not a trading score

Extend3cc239a on the same branch. No new strategy combinations or winner selection.
Write only new stage3 source and `../hs-lc4-stage3-evidence` artifacts. Seal every
old source/evidence byte. No stage1/stage2 producers are rerun into their outputs.

Deliver the research report, independently reconciled copy/forensic evidence,
market-path outcomes, snapshot field contract, UI design document and offline
research-only prototype. Never integrate or deploy it into the production app.
Opportunity is NOT entry permission. Past frequencies are NOT future probabilities.
No official0-100 score, tiers, Shadow recovery, financial writes or capital.

## Reproduce in the existing research worktree

```text
python research/hs_lc4/stage3/data_review.py --out ../hs-lc4-stage3-evidence
python research/hs_lc4/stage3/analysis.py --out ../hs-lc4-stage3-evidence
python research/hs_lc4/stage3/prototype.py --out ../hs-lc4-stage3-evidence
python research/hs_lc4/stage3/verify.py --out ../hs-lc4-stage3-evidence
python research/hs_lc4/stage3/report.py --out ../hs-lc4-stage3-evidence
```

`UI_DESIGN.md` defines the human-readable field/state contract. The generated
`radar-design.html` opens as an offline research design, with no server, app
storage, financial permissions, network API or PWA registration. `ui-check.cjs`
uses installed Chrome/bundled WebKit in new isolated contexts; it is not real
iPhone/installed-PWA acceptance. Preserve `ui-failure*.json` even after recovery
from a missing browser executable.

All75 event/horizon records distinguish future path labels from causal feature
inputs and from hypothetical next-open execution. Fourteen common mature events
are the primary denominator; the incomplete tail is explicitly PENDING. Market
classification uses0050 (9bull/2bear/3range), not00631L's own regime. Confidence
intervals and frequencies describe this inspected historical sample, never future
success probability. Research input validity does not clear formalFAIL_CLOSED.
