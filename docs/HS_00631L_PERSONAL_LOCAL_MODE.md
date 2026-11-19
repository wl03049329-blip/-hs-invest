# 00631L personal local mode — source and storage boundary

## Automatic device bootstrap (2026-11-20, V3.9.15)

No private data service is necessary. A real browser-origin test from the HS
origin to FinMind's existing Free TaiwanStockPrice endpoint succeeded with CORS,
HTTP/API 200, 2,935 rows. Independently tested Chrome and WebKit candidate code
then each made one genuine provider GET, verified/stored the history and reused
it after reload without a file, login or shared key. This is not a live intraday
test and is not a claim of production deployment until its separate acceptance.

This follows the documented personal/noncommercial application use in the same
FinMind terms below: the requesting user receives data directly from the vendor.
HS does not host, proxy, mirror or redistribute that history. This is not an
unauthenticated HS "private endpoint" or hidden URL/password scheme. It does not
grant commercial/public data reuse or assume that paying for another API helps.

The sole direct GET URL selects 00631L, TaiwanStockPrice, 2014-10-01 through
2026-11-19. No token, login cookie or referrer is sent; redirects are rejected.
It runs only on the original HS app origin/path, not CI/localhost/clones. Future
daily prices use the existing licensed public archive, not another scheduler.

The normalized split-once close array must hash exactly to
`9079de2db57bd184ec020978de47df21544f5659a1843658584e101d4291b94b`.
Only raw pre-2026-03-31 prices divide by 22. Partial, duplicate, zero-volume,
invalid-date, double-adjusted or revised history is rejected, not approximated.
The new direct-response backup schema keeps the actual response hash and local
retrieval time; the original manually imported schema remains valid unchanged.

An existing saved history or explicit public-mode preference prevents another
vendor query. A browser Web Lock coordinates tabs. Attempts/cooldowns are in
the same separate research DB, never financial storage. One attempt has a
20-second full-body deadline/4 MB cap. No looping retries: ordinary source errors
cool down 30 minutes, 402/429 at least one hour plus Retry-After, 401/403 and
historical content conflicts one day. Retry is on reopening/online or explicit
retry, still subject to the cooldown. No account/key/IP rotation or paid upgrade.

Clearing browser storage/changing phones allows a new direct verified fetch;
no JSON transfer is required while the provider is available. Backup remains an
optional same-owner fallback. Offline retains verified saved values/dates. If
automatic access fails, the home status names activation/source/quota failure
instead of suggesting another 240-day wait. No arbitrary browser/carrier or
future provider availability is guaranteed. Physical iPhone remains PENDING.

Private positive replay tests run locally, not CI. CI mocks failure statuses
and ensures cross-tab/cooldown behavior without receiving private history;
localhost PWA tests cannot call the historical endpoint because of the origin
guard. Real provider acceptance is separately recorded, never labelled REPLAY
or synthetic tests as a successful vendor/live run.

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
