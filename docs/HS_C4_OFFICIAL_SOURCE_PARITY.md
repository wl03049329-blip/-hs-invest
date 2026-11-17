# Independent C4 close observations: official-source research gate

Status: **not approved for automated publication**. The audit reads public
dated TWSE sources and immutable HS archives; it does not change the publisher
or make network requests to FinMind. Existing historical input vintages are
not new vendor authorizations. The audit requires the prior local official
evidence bundle `hs-lc4-evidence/raw` alongside this worktree.

| Input | Candidate evidence | Remaining coverage requirement |
|---|---|---|
| Raw daily OHLC and shares | TWSE STOCK_DAY; official dated MI_INDEX close cross-check; existing radar raw archives | Prove complete exchange-session coverage, not just terminal dates. The current 0050, 00830 and 00935 radar tails alone do not cover the frozen scorer's start. All four are listed on TWSE; do not substitute a TPEx series. |
| Cash distribution / ex-right | TWSE TWT49U ex-date, previous close, unrounded event amount and published reference, with issuer notices as separate evidence | TWT49U explicitly omits certain combined reduction/split cases. A blank or missing report is not zero events. |
| Split/reverse split, capital reduction and other combined actions | TWSE TWTCAU, dated issuer/MOPS notice and official capital-change reference reports | Need complete date-range coverage, including proof of no event and correction handling. Never infer an event from a price jump or assume a proposed split is effective. |

The frozen adjustment uses the published reference divided by the prior
price for pre-event OHLC. Volume changes only under its existing split/ratio
rules. The official 0050 2025-06-18 resume reference is 47.16 vs 188.65,
matching the sealed split input; using exactly 0.25 instead would change
the frozen adjustment. The audit compares 920 archived official OHLCV rows
from 2023 through 2026-11-05 against the replay inputs, with no differences.
All eight 0050 cash events match the sealed date, amount, prior close and
reference. TWSE TWT49U extension checks detect omissions and changed amounts.

11/13 and 11/16: four independent scores each, exact score delta zero and
raw/mapped factor and tier parity. For 0050, 00830 and 00935 this is a
**hybrid replay using archived FinMind** before the official extension.
00757 uses the TWSE raw archive, but the independent historical
capital-action completeness proof is still missing. Neither result is a
general official-only equivalence guarantee. The script prints source
SHA-256 receipts without writing any score or artifact.

No FinMind token was needed for this audit. A future no-token publisher
could use an independently verified source bundle plus an official daily
extension with action completeness and overlap checks; that contract and
rights to daily automated use must be verified before enabling it. Otherwise
a verified authorized current source is still needed. Do not merge on the
strength of score parity for these two dates alone. 00662 and all FINAL,
LIVE, financial and user data are outside this audit.

Run: `node scripts/audit_c4_observation_official_inputs.cjs`.
