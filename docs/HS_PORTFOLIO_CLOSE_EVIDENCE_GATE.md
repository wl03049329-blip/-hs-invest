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

### Licensed price stage and validated alternatives

The independent `portfolio_open_close.cjs` stage now supports all instrument
codes with actual trades in both exchanges' date-stamped open datasets
([TWSE 11549](https://data.gov.tw/dataset/11549),
[TPEx 11371](https://data.gov.tw/dataset/11371)). It produces receipts with
attribution, raw response and normalized payload hashes. Append is idempotent
and rejects silent revisions. Pairing demands exact completed-session dates;
its output is deliberately marked `corporate_actions: UNVERIFIED` and cannot
be used to claim an action-free window. The present CLI does not publish data
or change any existing job.

2026-11-24 probe: TWSE JSON was still 11/23 while the licensed TWSE CSV gave
1,383 genuinely traded rows for 11/24; the TPEx OpenAPI gave 1,010. A pinned
TPEx 11/23 archival snapshot was checked against its immutable Git blob and
the prior dated official audit. The eight price pairs matched. The mirror is
test-only and is not an automatic recovery source.

FinMind permits noncommercial personal use of its API and lists individual
raw closes, dividends, split/resumption, capital reduction and par-value
datasets in Free; adjusted prices and halt announcements are Backer features.
One unauthenticated request for known 00662 split on 2026-11-17 returned
HTTP/API 200 and one row with CORS. This demonstrates a private technical
route, not a freshness/coverage watermark. Split and dividend quality
reports are scoped samples, not completeness for an empty response on a
future session. The existing HS 00631L browser path uses a fixed historical
raw-price request and a local cache; it does not establish any of these
future event-coverage or public use rights. Do not reuse a private token or
mirror FinMind raw responses in Pages.

[SITCA/FSC fund dividends](https://data.gov.tw/dataset/160547), TPEx
[ex-right results](https://data.gov.tw/dataset/11633), and the TWSE [forecast
table](https://data.gov.tw/dataset/89748) are complementary open inputs; none
covers all splits, reductions and resumption dates in both venues. Issuer
notices are positive event evidence, not an absence-of-event feed. Fund
unit counts or a capital snapshot cannot certify that every price-basis
event for every listed security was reported.

FinMind Backer is NT$699/month for personal noncommercial access to adjusted
historic prices; Sponsor Pro (NT$3,330/month) is not a grant to redistribute
raw data or exempt the source's requirements. A possible public route is a
quote for exchange/licensed-vendor daily and corporate-action feeds with
explicit retention, derived display rights, and venue/date coverage. No
service was purchased.

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
