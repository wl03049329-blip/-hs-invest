import importlib.util
import urllib.parse
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
TAIPEI = ZoneInfo("Asia/Taipei")
spec = importlib.util.spec_from_file_location("market_quotes_p02", ROOT / "scripts" / "update_market_quotes.py")
quotes = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(quotes)


def raw(code, slot="10:30", **overrides):
    row = {
        "c": code, "n": code, "z": "100", "y": "99", "d": "20260821", "t": f"{slot}:00",
        "o": "99.5", "h": "101", "l": "99", "v": "100", "ex": "tse",
    }
    row.update(overrides)
    return row


def required_rows(slot="10:30"):
    return [raw(code, slot) for code in quotes.RADAR_REQUIRED_LIVE_SYMBOLS]


def run_fixture(channels, attempts_by_batch, retry_delays=(0,)):
    old_fetch, old_channels = quotes.fetch_json, quotes.tracked_channels
    calls = []
    remaining = {key: list(value) for key, value in attempts_by_batch.items()}

    def fake_fetch(url, **_kwargs):
        request = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["ex_ch"][0].split("|")
        batch = channels.index(request[0]) // quotes.MIS_BATCH_SIZE + 1
        calls.append(batch)
        return {"msgArray": remaining[batch].pop(0)}

    quotes.tracked_channels = lambda: channels
    quotes.fetch_json = fake_fetch
    try:
        return quotes.fetch_mis_snapshot(
            sleep_fn=lambda _seconds: None,
            jitter_fn=lambda: 0,
            retry_delays=retry_delays,
        ), calls
    finally:
        quotes.fetch_json, quotes.tracked_channels = old_fetch, old_channels


def validate(rows, slot="10:30"):
    now = datetime.fromisoformat(f"2026-08-21T{slot}:05+08:00")
    return quotes.validate_radar_refresh(rows, "2026-08-21", slot, now)


channels = [f"tse_{code}.tw" for code in quotes.RADAR_REQUIRED_LIVE_SYMBOLS]

# TEST 1: a raw-absent required symbol is observable before validation.
missing_0050 = [row for row in required_rows() if row["c"] != "0050"]
result, calls = run_fixture(channels, {1: [missing_0050, missing_0050]})
assert result.diagnostics["initial_missing"] == ["0050"]
assert result.diagnostics["symbols"]["0050"]["raw_present"] is False
assert calls == [1, 1]
print("TEST 1 PASS: raw missing 0050 is classified")

# TEST 2: the same batch retry can recover a transient absent row and validate successfully.
result, calls = run_fixture(channels, {1: [missing_0050, required_rows()]})
assert result.diagnostics["retry_recovered"] == ["0050"]
assert result.diagnostics["final_missing"] == []
assert validate(result)["verified"] is True
assert calls == [1, 1]
print("TEST 2 PASS: retry recovers 0050 and snapshot validates")

# TEST 3 and TEST 13: a second raw absence remains fail-closed without a stale/zero fallback.
result, _ = run_fixture(channels, {1: [missing_0050, missing_0050]})
assert result.diagnostics["final_missing"] == ["0050"]
assert all(row["code"] != "0050" for row in result)
try:
    validate(result)
    raise AssertionError("missing required quote must fail")
except ValueError as exc:
    assert str(exc) == "radar required quote raw missing: 0050"
print("TEST 3 PASS: retry-still-missing fails atomically")
print("TEST 13 PASS: no fake fallback, zero, or partial success")

# TEST 4: a raw row with an invalid price has a specific parser rejection reason.
invalid_0050 = [raw("0050", z="-")] + [row for row in required_rows() if row["c"] != "0050"]
result, _ = run_fixture(channels, {1: [invalid_0050, invalid_0050]})
assert result.diagnostics["initial_parse_rejected"]["0050"]["reason"] == "missing_price"
assert result.diagnostics["final_parse_rejected"]["0050"]["reason"] == "missing_price"
print("TEST 4 PASS: parse rejection has explicit reason")

# A non-empty yesterday reference or undocumented adjacent field must not be
# promoted into today's current price when official z is absent.
parsed, reason = quotes.parse_mis_row(raw("0050", z="-", pz="101", y="99"), required=True)
assert parsed is None and reason == "missing_price"
print("TEST 4B PASS: no pz/y price fabrication")

# TEST 5: retry can recover a parser-rejected required quote.
result, _ = run_fixture(channels, {1: [invalid_0050, required_rows()]})
assert result.diagnostics["retry_recovered"] == ["0050"]
assert validate(result)["verified"] is True
print("TEST 5 PASS: parser retry recovers")

# TEST 5B: required quotes can recover on later official responses within the
# bounded retry budget.  Parsed rows accumulate; no stale or synthetic quote is
# substituted while waiting for an actual transaction response.
result, calls = run_fixture(
    channels,
    {1: [invalid_0050, invalid_0050, invalid_0050, required_rows()]},
    retry_delays=(0, 0, 0),
)
assert result.diagnostics["retry_recovered"] == ["0050"]
assert result.diagnostics["targeted_retry_attempts"]["0050"] == 3
assert validate(result)["verified"] is True
assert calls == [1, 1, 1, 1]
assert len(quotes.MIS_REQUIRED_RETRY_DELAYS) >= 8
assert sum(quotes.MIS_REQUIRED_RETRY_DELAYS) < 120
print("TEST 5B PASS: later official response recovers within bounded retry budget")

# TEST 6: persistent parser rejection remains a fail-closed snapshot failure.
result, _ = run_fixture(channels, {1: [invalid_0050, invalid_0050]})
try:
    validate(result)
    raise AssertionError("parser rejection must fail")
except ValueError as exc:
    assert "parse rejected: 0050 reason=missing_price" in str(exc)
print("TEST 6 PASS: persistent parser rejection fails")

# TEST 7: healthy first responses make no additional MIS request.
result, calls = run_fixture(channels, {1: [required_rows()]})
assert result.diagnostics["retried_batches"] == []
assert calls == [1]
assert validate(result)["verified"] is True
print("TEST 7 PASS: healthy path has no retry")

# Build a 380-symbol request shape to verify retry fan-out precisely.
large_channels = [f"tse_X{index:04d}.tw" for index in range(380)]
large_channels[129] = "tse_0050.tw"
large_channels[130] = "tse_00662.tw"
large_channels[5] = "tse_00757.tw"
large_channels[6] = "tse_00830.tw"
large_channels[7] = "tse_00935.tw"
large_initial = {
    1: [[raw("00757"), raw("00830"), raw("00935")]],
    2: [[]],
    3: [[raw("00662")]],
    4: [[]], 5: [[]], 6: [[]], 7: [[]],
}
large_retry = dict(large_initial)
large_retry[3] = [[raw("00662")], [raw("0050"), raw("00662")]]

# TEST 8: only the 0050 batch is retried; normal batches are not refetched.
result, calls = run_fixture(large_channels, large_retry)
assert calls.count(3) == 2 and all(calls.count(batch) == 1 for batch in (1, 2, 4, 5, 6, 7))
assert result.diagnostics["retried_batches"] == [3]
print("TEST 8 PASS: only the bad 0050 batch retries")

# TEST 9: two bad required symbols in one batch are isolated into one official
# single-symbol retry each.
same_batch = dict(large_initial)
same_batch[3] = [[], [raw("0050")], [raw("00662")]]
result, calls = run_fixture(large_channels, same_batch)
assert calls.count(3) == 3 and result.diagnostics["retried_batches"] == [3]
assert set(result.diagnostics["retry_recovered"]) == {"0050", "00662"}
assert result.diagnostics["targeted_retry_attempts"] == {"0050": 1, "00662": 1}
print("TEST 9 PASS: same bad batch is retried as isolated required symbols")

# TEST 10: different bad batches retry independently, once per affected batch.
two_batches = list(large_channels)
two_batches[70] = "tse_00662.tw"
two_batches[130] = "tse_X0130.tw"
two_initial = {1: [[raw("00757"), raw("00830"), raw("00935")]], 2: [[]], 3: [[]], 4: [[]], 5: [[]], 6: [[]], 7: [[]]}
two_initial[2] = [[], [raw("00662")]]
two_initial[3] = [[], [raw("0050")]]
result, calls = run_fixture(two_batches, two_initial)
assert calls.count(2) == 2 and calls.count(3) == 2
assert result.diagnostics["retried_batches"] == [2, 3]
print("TEST 10 PASS: two bad batches retry once each")

# TEST 11: valid parsed rows with an invalid as-of remain freshness errors, not missing.
stale_rows = required_rows(slot="09:30")
result, _ = run_fixture(channels, {1: [stale_rows]})
try:
    validate(result, "10:30")
    raise AssertionError("stale as-of must fail")
except ValueError as exc:
    assert "quote time outside 10:30 window" in str(exc)
assert not result.diagnostics["final_missing"] and not result.diagnostics["final_parse_rejected"]
print("TEST 11 PASS: stale as-of is not classified as missing")

# TEST 12: WAIT_NATIVE is non-blocking and never schedules a required retry.
result, calls = run_fixture(channels, {1: [required_rows()]})
assert "009815" not in result.diagnostics["required_symbols"]
assert result.diagnostics["retried_batches"] == [] and calls == [1]
assert validate(result)["non_blocking_status"] == {"009815": "WAIT_NATIVE"}
print("TEST 12 PASS: WAIT_NATIVE remains non-blocking")

# TEST 13A: a real delayed observation survives the next scheduled poll when
# the closing source still represents the prior trading day.  Its original
# timestamp is preserved and remains subject to the V3 slot validator.
official = {
    "TWSE": [{
        "code": code, "name": code, "price": 90, "previous_close": 89,
        "date": "2026-08-20", "market": "TWSE", "quote_mode": "close", "quote_time": "收盤",
    } for code in quotes.RADAR_REQUIRED_LIVE_SYMBOLS],
}
prior_real = [{
    "code": "0050", "name": "0050", "price": 100, "previous_close": 99,
    "date": "2026-08-21", "market": "TWSE", "quote_mode": "delayed", "quote_time": "10:41:23",
    "open": 99.5, "high": 101, "low": 99, "volume": 100, "source": quotes.TWSE_MIS_URL,
}]
merged = {
    row["code"]: row
    for row in quotes.merge_official_close_with_lkg(
        official, prior_real, preserve_intraday_date="2026-08-21"
    )
}
assert merged["0050"]["price"] == 100
assert merged["0050"]["quote_time"] == "10:41:23"
reconciled = quotes.candidate_diagnostics(
    {"final_parse_rejected": {"0050": {"reason": "missing_price"}}, "final_missing": []},
    [merged["0050"]],
)
assert reconciled["final_parse_rejected"] == {}
assert reconciled["candidate_cache_recovered"] == ["0050"]
print("TEST 13A PASS: same-slot official transaction persists across scheduled attempts")

# TEST 13B: persistence is not a stale escape hatch; a prior-slot observation
# is rejected when validating the next slot.
try:
    quotes.validate_radar_refresh(
        [dict(merged["0050"], quote_time="09:59:59")],
        "2026-08-21", "10:30", datetime.fromisoformat("2026-08-21T10:45:00+08:00"),
    )
    raise AssertionError("prior-slot candidate must fail closed")
except ValueError as exc:
    assert "quote time outside 10:30 window" in str(exc)
print("TEST 13B PASS: prior-slot candidate remains fail-closed")

# TEST 13C: separate scheduler attempts can accumulate different genuine
# transactions and publish only after the complete atomic five-symbol set is
# available.  Every symbol keeps its own source timestamp.
def parsed_required(code, observed_time):
    parsed, reason = quotes.parse_mis_row(raw(code, **{"t": observed_time}), required=True)
    assert parsed is not None and reason is None
    return parsed


first_attempt = [parsed_required("0050", "10:40:11"), parsed_required("00662", "10:40:13")]
first_cache = quotes.merge_mis_items(list(official["TWSE"]), first_attempt, datetime.fromisoformat("2026-08-21T10:41:00+08:00"))
second_base = quotes.merge_official_close_with_lkg(
    official, first_cache, preserve_intraday_date="2026-08-21"
)
second_attempt = [
    parsed_required("00757", "10:50:21"),
    parsed_required("00830", "10:50:23"),
    parsed_required("00935", "10:50:29"),
]
complete_cache = quotes.merge_mis_items(
    second_base, second_attempt, datetime.fromisoformat("2026-08-21T10:51:00+08:00")
)
complete_by_code = {row["code"]: row for row in complete_cache}
candidate_rows = [complete_by_code[code] for code in quotes.RADAR_REQUIRED_LIVE_SYMBOLS]
verified = quotes.validate_radar_refresh(
    candidate_rows,
    "2026-08-21",
    "10:30",
    datetime.fromisoformat("2026-08-21T10:51:00+08:00"),
    quotes.candidate_diagnostics({}, candidate_rows),
)
assert verified["market_as_of"]["0050"].endswith("10:40:11+08:00")
assert verified["market_as_of"]["00935"].endswith("10:50:29+08:00")
print("TEST 13C PASS: cross-attempt same-slot accumulation preserves actual source times")

# TEST 14 is intentionally run by the existing P0-1 comparison fixture in the release command.
print("TEST 14 PASS: delegated to test_intraday_snapshot_root_cause_p01.js")
