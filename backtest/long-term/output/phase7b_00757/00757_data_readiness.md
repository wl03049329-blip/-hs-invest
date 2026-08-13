# 00757 data readiness

- Official universe listing date: **2018-12-06** (TWSE ETF basic data / ISIN source already stored in `etf-universe.json`).
- First canonical trading date: **2018-12-06**.
- Latest canonical date: **2026-08-13**.
- Adjusted OHLC trading rows: **1866**; weekly observations: **396**.
- DD52 252-row adjusted intraday-High history: **READY**.
- Crash 20-close history: **READY**.
- Weekly J 9-week native history: **READY**.
- Corporate actions returned by existing FinMind event datasets: distributions 0, splits 0; normalized adjustment events 0.
- Largest absolute close-to-close move: 16.0541% on 2025-04-07; >=25% discontinuities: 0.
- Price basis: existing `adjustPriceHistory` framework. DD52 uses adjusted daily intraday `max`, never closing high.

Decision: **ETF_NATIVE_HISTORY**. All three frozen factors are complete and FAIL_CLOSED remains unchanged.
