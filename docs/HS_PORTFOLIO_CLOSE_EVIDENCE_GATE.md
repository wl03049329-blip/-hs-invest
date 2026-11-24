# Portfolio close evidence: read-only candidate, production HOLD

The existing Portfolio estimate requires dated raw previous closes and
verified corporate-action coverage. Those proofs come from Radar's
six-symbol archive, not the all-market Portfolio quote cache. 006201,
00631L and 00685L are outside that archive. The separate 00631L close-only
archive is not a substitute for this accounting proof.

`python -m scripts.audit_portfolio_close_evidence --date YYYY-MM-DD --symbol SYMBOL ...`
is an explicit, bounded read-only check. It resolves the expected previous
and next sessions, requires both exchange calendars to corroborate their own
two completed sessions, compares actual traded closes with the Portfolio
cache, and checks date-covered action reports. It accepts public exchange
codes in the official cache. The report contains source URLs, hashes and
only requested public instruments; it is not consumed by UI or Ledger.
No raw responses are persisted or published. Never send holdings, units
or costs as arguments or commit raw responses.

## Verified manual sample

2026-11-24: previous completed session 2026-11-23, next expected session
2026-11-25. Both official calendars and both days' trading reports
corroborated 8/8 requested closes; scoped action checks found no event
for the eight that required a change of basis. A symbol without either
real close (including a halt), with an identified action or with a
comparison conflict stays UNKNOWN. This did not verify the user's device,
historic share basis or Ledger.

## Production gates

- Confirm unattended retrieval and evidence/derived-data reuse for the
  exact dated sources. TWSE [website terms](https://www.twse.com.tw/zh/terms/use.html)
  exempt datasets explicitly released on the government portal, not every
  JSON view. Dated `MI_INDEX`, `TWT49U`, `TWTCAU`, and `TWTAUU` are
  not automatically interchangeable with OpenAPI. TPEx OpenAPI offers
  current close and ex-right data, but dated reports and split/reverse-split/
  capital-change bulletins need coverage and reuse checked separately.
- Prefer to append licensed TWSE/TPEx OpenAPI close receipts at the existing
  closing jobs and pair their last two sessions, plus permitted, date-complete
  corporate-action coverage. Do not substitute a marked comparison value
  for actual previous close or interpret an absent action feed as zero.
- Emit a dated, integrity-checked artifact separate from C4 and the quote
  cache with per-instrument status. Keep shares and unit acknowledgements
  local. Withhold the affected estimate until event treatment is verified.
- Add a bounded, read-only check to the completed-market monitor after
  publication; deduplicate by session and stable reason set rather than run
  timestamp. An evidence-only failure must not block FINAL, LIVE or asset
  valuation with otherwise sufficient evidence.
- Verify a real scheduled run, public integrity, browser/PWA and device
  handoff. No changes to financial state, schema, costs, or Writer.
