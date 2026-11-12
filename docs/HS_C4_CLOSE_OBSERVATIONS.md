# Individual C4 close observations: 2026-11-11 and 2026-11-12

This is a fixed, read-only historical supplement, not an automatic publisher.
Its data contract is independent of canonical FINAL, official chart points,
rank, smart buying and trading. Only the ETF history view loads it. No
holdings, portfolio store, Ledger or Worker protocol changes.

## Replay evidence

On 2026-11-12 the existing read-only Shadow CLI was run under UTC for
2026-11-10, 11-11 and 11-12. For 11-10, the five raw factors and mapped
components, weights, contributions, total and tier matched the sealed snapshot
in publication commit `c2867edae7f012d85b29b5b4033fb15b8f6e47b4`; all five
reported exactly zero score delta. The score module and weekly J helper were
not edited. For 11-11 and 11-12, the FinMind score-input close matched the
dated TWSE MI_INDEX report for all eight observations. The FinMind history,
distributions and split events were cut off on each target date. Original
point-in-time FinMind responses are not available; this is a verified
historical reconstruction, not a reissue of a past FINAL.

The JSON preserves TWSE source URLs, response SHA-256, matched closing price,
raw and mapped components, exact score and model tier. It also records the
separate UTC Golden Baseline. [TWSE split announcement](https://www.twse.com.tw/zh/ETFortune/announcement?company=A00010&date=20260910&fund=00662&seq=1&type=all)
and absence from both dated reports support the two 00662 no-score rows.
009815 is deliberately absent from the supplement and remains WAIT_NATIVE.

No 11-11 or 11-12 FINAL or ranking is generated. If the supplement fails
validation or cannot load, the formal view remains usable and the supplement
is not presented as official or substituted into any gap.
