from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
intraday = (ROOT / ".github" / "workflows" / "update-market-quotes.yml").read_text(encoding="utf-8")
eod = (ROOT / ".github" / "workflows" / "finalize-core-score-history.yml").read_text(encoding="utf-8")
fetcher = (ROOT / "scripts" / "fetch_official_eod_market.py").read_text(encoding="utf-8")
finalizer = (ROOT / "scripts" / "finalize_core_score_history.js").read_text(encoding="utf-8")

assert '--expected-date "$expected_date"' in intraday
assert 'cron: "30 7,10,12,14,15 * * 1-5"' in eod
assert "cancel-in-progress: false" in eod
assert "fetch_official_eod_market.py" in eod
assert "official-eod-market.json" in eod
assert "TWSE_OPENAPI_STOCK_DAY_ALL" in fetcher
assert "TWSE_EXCHANGE_REPORT_OPEN_DATA" in fetcher
assert "git add finalized-core-score-snapshots-v1.json" in eod
for forbidden in ("git add .", "git add -A", "market-quotes.json market-quotes-meta.json"):
    assert forbidden not in eod
assert "official_eod_date_${d}_before_expected_${expected}" in finalizer
assert "look_ahead_official_eod_date_${d}_after_expected_${expected}" in finalizer
assert "stale_date_backfill_" in finalizer
assert "weight!==WEIGHTS[name]" in finalizer
print("PASS EOD expected-date, official-only fallback, isolated input, no-look-ahead, and exact artifact staging guards")
