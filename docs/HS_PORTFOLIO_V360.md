# Personal portfolio V3.6 boundary

`daily_estimate` is a separate, read-only current-inventory price-change view.
It does NOT replace `today_pnl_minor`, Ledger performance, dividends, cash flows,
or any formal financial settlement field. Current projected holdings determine
shares. The existing official-close reader and HistoryBasis verify each close,
actual previous exchange session, raw-history SHA and corporate-action coverage.
No intraday price or exchange comparison price is substituted for an official
previous close. Known verified splits use the corresponding current-unit basis;
unreviewed units remain excluded. No C4 input is used.

Estimate=sum(current shares × current close) − sum(current shares × previous
close on the same split basis), with existing safe integer money arithmetic.
Estimate-only decimal products use exact eight-decimal BigInt inputs, sum raw
changes before rounding the total to cents, and do not subtract two separately
rounded valuations. Percent uses the matching unrounded previous-close value.
Original account valuation arithmetic is unchanged. Partial results identify
covered/total symbols and missing reasons; no missing item is treated as zero.
Exchange-calendar expectation is not evidence that a new close exists. During
missing/unknown sessions current estimates remain unavailable; weekends retain
the explicitly dated verified completed session.

The V3.6 UI uses existing canonical individual/dual-level target resolution,
group aggregation, group order and color storage. Selection and list sorting
are in-memory presentation only. Existing settings handlers are moved, not
reimplemented. Manual corrections, soft deletion/undo, cash consistency checks,
Journal/Lock and encrypted preview/restore still have their original owners.

No financial storage migration, C4 formula/eligibility change, new trading Writer,
00631L research authorization, PWA reset or automatic transaction is introduced.
