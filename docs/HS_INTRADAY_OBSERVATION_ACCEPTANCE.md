# Independent C4 observation acceptance

The public and scheduler gate is off by default. Do not set
HS_INTRADAY_OBSERVATION_ENABLED on the production service until an isolated
candidate has passed the trading-session acceptance below. The official
five-symbol LIVE, FINAL, and finance consumers do not read the observation store.

On the next verified session (2026-11-16 expected), use an isolated candidate
with its own volume, schedule and private endpoint. Do not duplicate C4's
Fugle traffic. The candidate uses a four-symbol MIS request; the Fugle fallback
is tested through injection only, pending approved source use and a coordinated
quota reservation that cannot starve C4. Verify each adjusted history against
the exact previous official session and confirm corporate-action basis before
publishing. Do not use raw daily prices as a substitute for adjusted history.

Record the source, trading date, quote and calculation times, status and score
for each of 0050, 00757, 00830, 00935 across more than one bucket. Verify the
same values on the isolated API and homepage after refresh and after restart.
Check that stale observations disappear and closed/next-day states cannot
reuse the prior session as current. Check 00662 remains suspended on 11/16 and
009815 remains WAIT_NATIVE. The candidate does not implement a 00662 resumption
approval: require PR #60's actual post-split price-basis and trade evidence.

Record candidate commit, production FINAL and live contract hashes, and
Chrome/WebKit and PWA results. A fixture is TEST; a proven historical payload
is REPLAY only. No 11/13 qualifying historical capture is established.
Do not promote if any required symbol or pipeline link lacks genuine evidence.
