# HS L-Radar Crash-Rebound V1

**Research only. Live feed BLOCKED. Entry NO-GO.** No change to frozen L-C4,
Shadow FAIL_CLOSED, FINAL, trading, holdings, Ledger, Writer or PWA storage.

The homepage loads no research snapshot and never contacts an exchange.
Opening details or refreshing fetches the existing static files and validates
the archive byte hash. Dated daily statistics remain historical. There is no
intraday timestamp or signal while the feed is unavailable. The GitHub daily
research workflow was observed as manually disabled.

Railway's live-quote universe excludes 00631L from its required symbols.
MIS/Fugle last-trade snapshots and the C4 snapshot workflow do not validate
5/15-minute OHLCV, spreads or consecutive lows. Fugle documents candles, but
project entitlement, permission to redistribute, coverage, quotas and cost
were not established. No new vendor requests, jobs or secrets were added.
Phase C needs those checks and an isolated multi-session source-quality trial
before enabling a shared rate-limited backend cache.

Run node scripts/research_lradar_v1.cjs to reproduce [full results](results-v1.json).
The 2,925-bar SHA-pinned snapshot spans 2014-10-31 to 2026-11-05. The prior
22:1 action maps the 03/24 close 443.15 to 20.14318…, with no 03/25–30 bars.
The program checks both price anchors and never reapplies the split.

One daily candidate: train the 95th percentile of negative five-day returns
before each year; start 2018. Apply a 12-session refractory period. A recovery
candidate requires the next daily bar to close higher without breaking the
trigger low; enter at the following open. Exit at the 1/3/5/10th held close.
Compare immediate next-open (all and matched events), matched 0050 and cash.
Round-trip cost stresses are 0.2/0.5/1.0%. MAE/MFE are range statistics, never
executed prices. Drawdown is compounded liquidation-equivalent daily equity.
Year-cluster bootstrap intervals are exploratory; historical data have been
studied, not new prospective OOS.

At 0.5% cost, 27 events are mature (one pending); 14 qualified in each horizon.
Confirmed means are −1.27%, −2.62%, −0.57%, +0.59%; all mean intervals cross
zero. Ten-day max drawdown is −43.24%; same-event immediate-entry mean is
+1.06%. No robust advantage. The legacy 15-event cohort remains unchanged.
