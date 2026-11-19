# 00631L historical-close completion gate

## Reproducible work completed on 2026-11-19

`node scripts/audit_00631l_close_history.cjs` is an **offline, non-publishing**
audit. It uses no new pricing API, writes no dataset and does not grant reuse
permission. All source and prior data hashes remain unchanged.

- Existing SHA-verified research bundle: 2,925 dates, 2014-10-31–2026-11-05.
- 146 archived official monthly responses contain 2,924 earlier closes:
  every one equals the research close after one date-scoped 22:1 adjustment.
  The remaining 11/05 row is in the later reviewed research snapshot.
- Comparing archived 0050/00631L dates finds no unexplained overlap gap.
  This is **not** a certification of the full historical official calendar.
- Ten pinned HS daily-close publications extend an offline candidate through
  2026-11-19: 2,935 rows. Each requires official-close source status, matching
  dates and integer-cent agreement with the preceding close. The program does
  not export these records to the production archive.
- Split: last pre-split traded close 2026-03-24; no invented closes for
  03/25–03/30; new units trade from 03/31. Before that date, raw/22 equals the
  existing series; afterward raw equals the existing series. No second division.
  [Issuer notice](https://api.yuantafunds.com/ECImage/ECBackstage/file/2026-03-30/3bdfb16432cf4c8c8cd10a30808802b4.pdf).
- Existing P80/P95 version and all six threshold vectors stay unchanged.
- Added calendar-month/one-year comparisons and selected-chart range returns.
  Calendar comparisons use the last verified trade on/before the target date.
  No missing-session or source gate was removed.

## Why this is not authorized to release the historical series

1. Archived sources are TWSE STOCK_DAY website reports and FinMind, not the
   currently authorized daily CSV dataset. The
   [TWSE terms](https://www.twse.com.tw/zh/terms/use.html) explicitly except
   government-open datasets; historical website access is not automatically the
   same grant. Need a grant applicable to the historical per-security closes,
   or a licensed listing-to-present archive.
2. [FinMind data terms](https://finmind.github.io/Disclaimer/) permit specified
   application uses but restrict raw redistribution/mirrors. A public static
   downloadable price history cannot silently be treated as permitted merely
   because this repository has an old copy or API access.
3. The split event is confirmed, but TWT49U explicitly excludes some combined
   events. The archived dividend/split tables plus zero matches are not a
   blanket proof of all-period company-action coverage.

Keep public historical-data publication on HOLD. Do not import the offline candidate into
`data/00631l-open-close`, claim complete historical publication, reset any
archive, or change C4/FINAL/LIVE/portfolio/Ledger. Existing licensed daily
capture remains independent. No paid service or old research schedule enabled.

## Derived-only publication review (2026-11-20)

Not offering the 2,935-row history for download is **not** itself a reuse grant.
Keep both raw redistribution and public derived-history indicators on HOLD.

| Input scope | Public derived indicators | Evidence / precise limitation |
| --- | --- | --- |
| Actual daily dataset 11549 CSV/OpenAPI captures | PASS with attribution and complete comparison window | [Dataset](https://data.gov.tw/dataset/11549), [OGL v1 sections 2 and 3](https://data.gov.tw/license): derivatives and public transmission permitted; name the provider. This does not grant other website endpoints. |
| Archived monthly STOCK_DAY and MI_INDEX website reports | UNKNOWN / do not publish | [TWSE website terms sections 6 and 8](https://www.twse.com.tw/zh/terms/use.html); [official information Q&A question 2](https://www.twse.com.tw/zh/products/information/qa.html) specifically addresses value-added information supplied to others. No grant covering this historical input and HS's public percentage-only output was found. |
| FinMind historical input | UNKNOWN / do not publish | [Pricing](https://finmind.github.io/Pricing/) permits noncommercial application development, but [data-license sections 3.2 and 3.3](https://finmind.github.io/Disclaimer/) restrict redistribution and require original-source authorization for external disclosure. [Commercial Q&A](https://finmind.github.io/CommercialUse/) does not independently establish the missing historical-source grant. No purchase or new API query performed. |

The checked free alternative [tw-chip-open-data](https://github.com/88jiayu/tw-chip-open-data)
identifies current OpenAPI captures, not an authenticated listing-to-present
replacement for this archive. A repository label alone does not prove 2014–2026
coverage or source rights for a new historical input. No substitute imported.

Company-action scope is limited to price comparability: the issuer's 22:1 event
and the once-only adjustment are verified as above. Cash dividends are **not**
reinvested or subtracted for these price-return indicators. Only other events
that change unit/price comparability (if any) need reconciliation; dividend
total-return completeness is not a release requirement for price returns.

Split the already-tested calendar-period/chart-return software into
`fix/00631l-authorized-period-ui`, based on latest main. It uses only the existing
verified continuous daily-open-data archive, publishes no new historical input
or private aggregate, and leaves all missing-window gates and fixed thresholds
unchanged. The public historical-data gate stays closed. Same-owner personal
local use is evaluated separately in `HS_00631L_PERSONAL_LOCAL_MODE.md`; it is
not a grant to redistribute the data, and no private payload enters Pages.

The minimum historical-output unblock is evidence that specifically permits
using the archived historical input to compute and publicly display HS's
noncommercial price-return/drawdown percentages (no price download or series).
Alternatively supply an equivalent source with that grant and verified coverage.
After permission, use a private calculator and an allowlisted summary artifact;
never put the raw input in this public repository/Pages or claim that a public
GitHub branch is controlled storage. Validate the overlap and price-changing
events before enabling it. There is no requirement to wait 240 days if such
an authorized historical source is established.
