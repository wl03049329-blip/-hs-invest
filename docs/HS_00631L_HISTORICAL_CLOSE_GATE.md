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

Keep this candidate Draft. Do not import the offline candidate into
`data/00631l-open-close`, claim complete historical publication, reset any
archive, or change C4/FINAL/LIVE/portfolio/Ledger. Existing licensed daily
capture remains independent. No paid service or old research schedule enabled.

The minimal release unblock is a documented historical-close reuse grant (for
the existing sources or an equivalent full-period source), plus completed
calendar/company-action coverage; then validate the full candidate against the
immutable live archive at the overlap before allowing the UI to read it.
