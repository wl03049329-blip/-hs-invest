# 00662 split resumption gate

This change does not publish a FINAL or alter a score. The last public FINAL at
acceptance was 2026-11-10. The 2026-11-17 observed trade and adjusted history
remain pending; simulation is not release evidence.

- RAW updates require the TWSE announcement and current split-reference
  report, plus dated MI_INDEX evidence for each missing exchange session in
  2026-11-11–16. The pre-split archive remains byte-identical during the halt.
  STOCK_DAY and MI_INDEX must agree on the actual resumption OHLC and shares
  before adding a raw bar. The reference price is never a trade.
- Both EOD jobs pin UTC (the historical weekly J grouping) and log it. The
  EOD job can obtain private evidence without waiting for the independent
  18:00 archive publisher. The normal five-symbol envelope remains mandatory.
  00662 must match both raw anchor bars and exactly one compatible split event
  in the scoring source. Conflicting or already-adjusted anchors, gap bars,
  missing/duplicate actions, or a competing action in the window fail closed.
- No sealed history, C4 score formulas or portfolio/Ledger logic are changed.
  A Taipei-calendar weekly aggregation would be a separate model-version
  study, not a fix to historical FINAL.

Acceptance on 2026-11-12: official announcement, 117.80 / 23.56 reference and
11/11–12 MI_INDEX absence verified live. 11/05, 11/06, 11/09, 11/10 replayed
20/20 sealed scores/factors/tiers, rankings 4/4. Python-to-Node isolation replay
exercises the actual RAW collector, split evidence, score function and append
contract with synthetic 11/17 trade data. Wait for actual TWSE trade,
FinMind RAW anchor and action parity, and a verified public artifact before
claiming recovery.
