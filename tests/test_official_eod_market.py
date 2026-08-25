from datetime import datetime
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = spec_from_file_location("official_eod", ROOT / "scripts" / "fetch_official_eod_market.py")
eod = module_from_spec(spec)
spec.loader.exec_module(eod)


def items(day="2026-08-25", shift=0.0, missing=None):
    result = {}
    for index, symbol in enumerate(eod.REQUIRED_SYMBOLS):
        if symbol == missing:
            continue
        close = 100.0 + index + shift
        result[symbol] = {"symbol": symbol, "date": day, "open": close, "high": close + 1, "low": close - 1, "close": close, "volume": 1000}
    return result


def state(provider, rows):
    return eod.source_state(provider, rows)


fetched = "2026-08-25T14:00:00Z"
primary = state(eod.PRIMARY_PROVIDER, items())
fallback = state(eod.FALLBACK_PROVIDER, items())
result = eod.resolve("2026-08-25", primary, fallback, False, fetched)
assert result["status"] == "READY" and result["provider"] == eod.PRIMARY_PROVIDER and result["fallback_used"] is False
print("PASS primary official ready")

stale_primary = state(eod.PRIMARY_PROVIDER, items("2026-08-24"))
result = eod.resolve("2026-08-25", stale_primary, fallback, False, fetched)
assert result["status"] == "READY" and result["provider"] == eod.FALLBACK_PROVIDER and result["fallback_used"] is True
print("PASS primary not ready uses same-date official fallback")

result = eod.resolve("2026-08-25", stale_primary, state(eod.FALLBACK_PROVIDER, items("2026-08-24")), False, fetched)
assert result["status"] == "SOURCE_NOT_READY" and result["items"] == {}
print("PASS both official sources not ready publish nothing")

try:
    eod.resolve("2026-08-25", primary, state(eod.FALLBACK_PROVIDER, items(shift=0.01)), False, fetched)
    raise AssertionError("source conflict accepted")
except eod.SourceConflict:
    pass
print("PASS same-date official source conflict fails closed")

try:
    eod.resolve("2026-08-25", state(eod.PRIMARY_PROVIDER, items("2026-08-26")), fallback, False, fetched)
    raise AssertionError("future source accepted")
except eod.LookAheadRejected:
    pass
print("PASS future source rejected; no-look-ahead preserved")

incomplete = state(eod.FALLBACK_PROVIDER, items(missing="00935"))
result = eod.resolve("2026-08-25", stale_primary, incomplete, False, fetched)
assert result["status"] == "SOURCE_NOT_READY"
assert set(primary["items"]) == set(eod.REQUIRED_SYMBOLS) and "009815" not in eod.REQUIRED_SYMBOLS
print("PASS five required ETF completeness and 009815 non-blocking")

result = eod.resolve("2026-08-25", stale_primary, state(eod.FALLBACK_PROVIDER, items("2026-08-24")), True, fetched)
assert result["status"] == "NO_TRADING_DAY"
print("PASS holiday/no-trading day is a safe no-op")
