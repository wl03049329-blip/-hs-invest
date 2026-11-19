# 00631L personal local mode — source and storage boundary

## Source-use decision (2026-11-20)

This is the same HS owner's noncommercial personal analysis, not a public
data product or a grant to third parties. [FinMind Pricing](https://finmind.github.io/Pricing/)
explicitly permits personal/noncommercial applications and lists TaiwanStockPrice
under Free. [Terms section 4](https://finmind.github.io/PrivacyPolicy/) and
[data licence sections 3.1–3.3](https://finmind.github.io/Disclaimer/) distinguish
service use from redistribution/public disclosure. The local file is used by
the original requester on their own devices, never served from Pages or an API.
This interpretation is limited to that stated use, not commercial or public
reuse permission. No specific perpetual retention grant is asserted.

The historical input is **FinMind only**, not a relabelled TWSE website archive:

- Existing successful TaiwanStockPrice request: 2,924 rows, 2014-10-31–2026-11-04,
  retrieved 2026-11-04; source receipt SHA
  `997544cf98e76aa81e6b6f2a579b04fc119b8d4f29536bbd4f3bd2eaf503f9d9`.
- One explicitly triggered free request: HTTP/API 200, 11 rows, 2026-11-05–11-19,
  retrieved 2026-11-19T16:22:11.425Z; response SHA
  `2b6a85111a0f4bd19237f3d58aab0688c95a57a20a6faf2cd4bc9e9d87a9b609`.
- Closes reconcile with prior independently reviewed official archives and
  the ten pinned recent HS official publications. Two-instrument historical
  date overlap finds no unexplained gap; this is not a full-market calendar audit.
- 22:1 split on 2026-03-31: raw closes before that date divided exactly once;
  post-split untouched; no fabricated 03/25–03/30 suspension closes. Cash
  dividends not reinvested: all outputs are price returns, not total returns.
- No authenticated account/tier, paid entitlement or redistribution right is
  inferred from HTTP 200. This uses the documented Free personal dataset only.

Public full-history redistribution/derived publication remains unapproved.
The program never downloads this historical file from the public site.

## Owner's file and daily extension

`scripts/build_00631l_private_import.cjs` is an explicit offline exporter; it is
not called by any workflow. Output must be outside the repository, uses exclusive
creation, and the filename is ignored by Git. The 2,935-row payload is pinned by
SHA-256 `8deb877cb18e953f9124d056c8150b9472dcc4651ea7a4bfeb78266e89535580`.
An arbitrary file's rights flags/checksum are not accepted as authorization.

User selects their file, explicitly confirms import, and optionally downloads a
same-owner backup. The file is parsed locally by File API, never POSTed. Only
the independent `hs.research.00631l.personal.v1` IndexedDB is used. The existing
financial namespace/storage contract is unchanged, with no migration. Local
backup is not encrypted or suitable for distribution. Safari eviction/clear can
erase it: keep an owner-controlled backup outside the browser.

Only the existing licensed public daily archive is fetched. All its original
source/date/session/SHA checks remain. Every overlap close must match, the
immediate prior session and previous close must agree, and new records must be
after the immutable base. Conflicts/gaps retain the last verified local state.
Atomic revision-checked transactions prevent a stale writer overwriting newer
data. Restoring a shorter backup cannot roll back an existing longer history.
On a fresh browser, restored extension records must also match the actual
verified public archive fetched by the app; self-declared SHA/source fields in
an imported file are not proof. If offline, keep the backup and reconnect before
restoring newer extension records. The pinned original base can restore offline.
No timestamps, raw history or calculated personal results leave the browser.

The public mode stays available through a switch. Offline retains saved local
history with its real date; it is not proof of current market freshness. This
store is isolated by convention, not a secret vault against other same-origin
code. No C4, FINAL, LIVE, Ledger, financial formula, Writer or SW safety change.

## Acceptance

Positive tests of the real private file run only locally through
`HS_PRIVATE_INPUT`; do not upload it to CI. CI runs rejection/isolation tests and
public-fallback Chrome/WebKit/PWA regressions. Mark the private-input test SKIP
in CI, not a fictitious live/private PASS. Local browser tests exercise File API,
download, reload, empty-store restore, offline calculations and financial
sentinel preservation at 320/375/390/430/1200 px. Physical iPhone remains PENDING.
