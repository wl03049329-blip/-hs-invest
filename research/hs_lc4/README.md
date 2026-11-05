# L-C4 isolated research

Research only. Original `research/hs_leverage/**`, its20 protected artifacts,
seven provenance mirrors and three append-only chains remain immutable.
No production Recovery dispatch, invented approvals, Shadow backfill, live score,
broker connection, financial writer or capital allocation is permitted here.

Protocol is committed before new source capture/model comparison. Complete raw
receipts and derived history live in a separate local evidence directory; source
hashes, audit, results and reproducible code identify them. All results must state
post-selection historical validation, not a new untouched OOS sample.

## Reproduce (standard-library Python, research worktree only)

Evidence directory: `../hs-lc4-evidence` (outside this Git worktree).
Never run any legacy producer script to regenerate frozen outputs.

```text
python research/hs_lc4/audit.py --out ../hs-lc4-evidence
python -m unittest discover -s research/hs_lc4 -p test_engine.py
python research/hs_lc4/engine.py --out ../hs-lc4-evidence
python research/hs_lc4/verify.py --out ../hs-lc4-evidence
python research/hs_lc4/report.py --out ../hs-lc4-evidence
```

`REPORT.md` contains all162 candidate rows, annual selection, failure cases,
cost/cash-yield sensitivity, year exclusion, official source references and
score-withholding decision. `source-manifest.json` pins314 original payloads;
`dataset-manifest.json` pins both reconciled datasets. `verification.json` records
actual tests, including the existing L7 failure (8 real review incidents versus
the old test's hardcoded7). No failed test is suppressed or converted to SKIP.
The new official history differs from frozen inputs; see DATA_AMENDMENT.md.

Endpoint NAV marks open positions for both tactics and benchmarks; hypothetical
liquidation costs are separate. Fractional adjusted research units, not executable
shares. Ten percent is a new-entry allocation cap; passive valuation drift is
measured and cannot be called an unbreakable live exposure cap. B&H initial10%
is not risk-matched continuous10% exposure. No leverage/long-term recommendation
may be inferred from a context benchmark with a different realized exposure.
