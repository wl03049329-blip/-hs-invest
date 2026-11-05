# Pre-performance implementation clarification

36 candidates remain fixed. The exit-comparison family has eight non-reference
exits per four entry methods (32 comparisons), NOT nine non-reference exits.
The entry-comparison family has three non-reference entries per nine exits (27).

Alongside the predeclared daily10%-weight control, each candidate gets a causal
exposure-path control for00631L and0050: rebalance at the next actual market open
to the last strictly earlier candidate closing exposure, capped10%. This is not
perfect identical contemporaneous exposure (one-session lag, suspension-calendar
differences and different prices), and not a new alpha strategy. The future
sample's average exposure is never used as a supposedly executable target.
Both controls pay the same commissions, slippage and selling tax. Official0050
cash distributions are valued as locked receivables, never reinvested before an
unknown payment date. Constant-weight controls are NOT called buy-and-hold.

All source1 files, source1 evidence, Frozen V1, incident chains and original
production logic remain unchanged. Only stage2 files and stage2 evidence can be
written. The forensic source table distinguishes frozen-value residuals from
normal raw/split-adjusted differences and from later vendor revisions. A one-tick
price disagreement is not explained away as binary floating-point error.

Opportunity diagnostics (not more trading candidates): common C95 events split
at the prior-training97.5th percentile and the prior-training20th-percentile DD20;
also continuous Spearman ranks against NEXT_OPEN/TIME20 common-event outcome.
A90 common-event NEXT_OPEN/TIME20 is one robustness screen, not a tuned grid.
Risk-mechanism diagnostic additionally pairs RISK_STOP10_BEAR_MA10_MAX40 versus
TIME40 per entry (same maximum horizon) without claiming the bundled risk
conditions separately identified. This comparison is descriptive, not a third
unregistered hypothesis test family.
