# HS_STABLE_APP_UPDATE_POLICY — mandatory for every HS release

Read `docs/HS_STABLE_APP_UPDATE_POLICY.md` before changing or releasing this app.
The only production App entry is `https://wl03049329-blip.github.io/-hs-invest/`.
Preserve the existing manifest identity/start_url/scope/icons. Integrate features
into its existing tabs, never claim a version-specific entry is a completed release.
Never clear/reset/migrate financial storage as an update/cache workaround.
Use `scripts/build_stable_app.cjs` and the main-only Pages workflow; never publish
unbuilt source HTML or bypass asset/Worker hashes. Verify actual public root UI,
all five tabs, installed-launch aliases, offline/update/failure recovery and data
isolation, not just Pages SUCCESS. Physical iPhone/PWA is PENDING unless tested.
Keep a byte-verifiable rollback and preserve original dirty worktrees. Do not
enable the production Financial Writer or change financial formulas for UI updates.
