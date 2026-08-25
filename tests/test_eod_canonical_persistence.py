from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
intraday = (ROOT / ".github" / "workflows" / "update-market-quotes.yml").read_text(encoding="utf-8")
eod = (ROOT / ".github" / "workflows" / "finalize-core-score-history.yml").read_text(encoding="utf-8")
updater = (ROOT / "scripts" / "update_market_quotes.py").read_text(encoding="utf-8")
finalizer = (ROOT / "scripts" / "finalize_core_score_history.js").read_text(encoding="utf-8")

assert '--expected-date "$expected_date"' in intraday
assert 'cron: "30 7,10,12,14 * * 1-5"' in eod
assert "cancel-in-progress: false" in eod
assert "HS_MARKET_OUTPUT_DIR" in eod and "HS_MARKET_OUTPUT_DIR" in updater
assert "hs-eod-probe/market-quotes.json" in eod
assert "git add finalized-core-score-snapshots-v1.json" in eod
for forbidden in ("git add .", "git add -A", "market-quotes.json market-quotes-meta.json"):
    assert forbidden not in eod
assert "official_eod_date_${d}_before_expected_${expected}" in finalizer
assert "look_ahead_official_eod_date_${d}_after_expected_${expected}" in finalizer
assert "stale_date_backfill_" in finalizer
assert "weight!==WEIGHTS[name]" in finalizer
print("PASS EOD expected-date, limited retry, isolated probe, no-look-ahead, and exact artifact staging guards")
