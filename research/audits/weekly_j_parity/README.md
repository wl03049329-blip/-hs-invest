# Phase 6.5A — Weekly J parity audit only

No `RESEARCH_HISTORICAL` dataset is published by this audit. Run `node scripts/audit_weekly_j_parity_phase65a.js` to generate three local `PARITY_AUDIT` JSON traces in this directory. Those large diagnostic files are not part of the audit-code commit. They contain current FinMind raw and as-of-adjusted inputs, full weekly bars and RSV/K/D/J replay, and the stored FINALIZED values. They are not the original point-in-time production input bundles.

## First reproducible divergence

`buy-point-core.js:weeklyKdj` parses `${date}T00:00:00+08:00`, then calls local-time `getDay()` and `setDate()` and serializes a UTC ISO date as the week key. The GitHub Actions Node step does not export `TZ=Asia/Taipei`; its `TZ=Asia/Taipei date +%F` is scoped to a separate shell command. In a UTC Node process, an exchange Monday at 00:00 Taipei is still Sunday UTC. It is assigned to the prior week, while Tuesday starts the new week. In a Taipei-local Node process, Monday starts the new week (although its ISO week-key string is Sunday). The first differing week-boundary decision in the 2023–2026 input window is 2023-01-09.

The exact same current FinMind input and unmodified production helper, replayed under UTC, reproduces all three stored FINALIZED Weekly J values and Core totals. Taipei-local replay reproduces the Phase 6.5 research mismatch. Target-date RSV happens to match in these cases; prior K/D differ because earlier weekly bars were grouped differently. The helper seeds K=D=50 and uses unrounded JS floating-point `K=2/3*previousK+1/3*RSV`, `D=2/3*previousD+1/3*K`, `J=3*K-2*D`.

| Case | Stored FINALIZED J | Taipei-local J | UTC replay J | Target-week daily membership (Taipei vs UTC replay) |
| --- | ---: | ---: | ---: | --- |
| 0050 2026-09-18 | 100.99812531854704 | 101.88526432173711 | 100.99812531854704 | 09/14–09/18 vs 09/15–09/18 |
| 00662 2026-09-17 | 46.935222189938884 | 49.96017164534835 | 46.935222189938884 | 09/14–09/17 vs 09/15–09/17 |
| 00830 2026-09-18 | 40.427473449632515 | 39.436665395947 | 40.427473449632515 | 09/14–09/18 vs 09/15–09/18 |

Additional confirmation dates using the retained adjusted audit inputs (no future event between the selected date and audit target): 0050 2026-09-11, 00662 2026-09-04, and 00830 2026-08-26. In all three, UTC replay matches stored J exactly and Taipei replay differs. No complete 72-date rerun was performed.

## Evidence boundary

FINALIZED snapshots store the terminal J and factors, but **not** the historical raw response, corporate-action response/hash, adjusted daily rows, weekly bars, prior K/D or RSV trace. The current FinMind response hashes are in each audit JSON; they cannot prove the original response was byte-identical. Thus the cross-environment week grouping is a confirmed code-level cause of the reproduced mismatch, while historical source byte equality remains unverifiable. Do not attribute the mismatch to an upstream FinMind revision without additional point-in-time evidence.

No future bars are used: the Thursday case ends at Thursday's close, and all event inputs are filtered through each case date. The research builder remains on HOLD; a follow-up should decide how to preserve the frozen production interpretation versus a corrected Monday–Friday research methodology, with explicit versioning and no rewrite of official history.
