# Individual C4 close observations

This historical supplement is independent of canonical FINAL, official chart points,
rank, smart buying and trading. Only the ETF history view loads it. No
holdings, portfolio store, Ledger or Worker protocol changes.

## 2026-11-13 and 2026-11-16 extension

The same UTC read-only suspension Shadow CLI reproduced all five sealed
2026-11-10 factors, scores and tiers before replaying these two completed
sessions. For each of the eight added rows the FinMind cutoff close matched
the dated TWSE MI_INDEX close. The artifact carries the source response SHA,
score and factors. The 00662 rows are suspension notices only. No 11/17
close is asserted and no LIVE or FINAL input has been changed.

The chart now accepts ordered subsequent sessions and rechecks them without
the HTTP cache on reconnect, foreground and a bounded visible refresh.

The independent main-only workflow is scheduled at 18:20 and 20:20 Taipei
on weekdays; use the official target-year calendar, reject incomplete
official sessions, and backfill the oldest missing sessions first, ten per run.
Transient transport failures have at most three attempts, while source
throttling or validation failures stop publication and surface a workflow
error. A later scheduled/manual run can retry without duplicates.
Only the observation artifact may be committed. Non-fast-forward pushes fail
closed without overwriting other publishers. The normal Stable Pages
workflow observes successful main runs. This is a rehearsal until merged;
no 00662 observations or FINAL writes are part of the workflow.

### FinMind quota incident and partial sessions

On 2026-11-17, an unauthenticated 0050 TaiwanStockDividendResult request for
the existing 2023-01-01 start received both HTTP and API 402 (request limit),
not an empty or malformed event series. Repository secret metadata did not
list FINMIND_TOKEN; the existing publisher does not attach a protected
environment. This does not prove an authenticated supplier account is
out of quota. Never reinterpret 402, an absent series, or a parsing
failure as no distributions.

Archived FinMind and TWSE TWT49U match for all eight 0050 pure-cash records
from 2023-01-30 through 2026-07-21: event date, previous close, ex reference
and cash amount. TWT49U alone expressly excludes certain combined reduction
or split operations and cannot certify complete actions. No automatic
provider substitution is enabled. A fallback needs a dated complete official
price and separate split/reduction/action channel with adjustment parity,
or use a verified existing authorized FinMind credential with quota.

For a valid dated market report, symbol-level price or adjusted-history
failure leaves that symbol pending. Verified neighbors can publish;
partial completion produces an annotated warning, and zero new verified
rows with unresolved gaps fail the job. Subsequent runs fill absent symbols
without replacing prior rows. A changed raw receipt fails closed rather
than silently attributing old rows to new bytes.

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

The history chart presents observations in a separate dashed series with
hollow marks. Only the immediately preceding official point can anchor that
visual segment; it is not duplicated as an observation marker or used to
bridge a gap. A same-date FINAL takes precedence. The solid official series,
statistics, raw candles, and signal consumers still use their original
inputs. Suspension dates may be selected for their notice only.
