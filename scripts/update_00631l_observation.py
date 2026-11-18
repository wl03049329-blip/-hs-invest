"""Description-only 00631L closes, derived from the pinned historical source."""
import datetime as dt
import os
import sys
from pathlib import Path
from scripts.lc4_research_daily import (
    ROOT, Client, TZ, encoded, load_history, months, official_sessions,
    parse_month, read, ref, require, research_expected_day, sha, twse_actions,
)

SYMBOL = "00631L"
FILE = "data/00631l-observation-v1.json"
TRAIN = "2020-12-31"
PERIODS = (20, 60, 120, 240, "all")


def thresholds(rows):
    samples = {k: [] for k in ("speed", *map(str, PERIODS))}
    historical_high = 0
    for i, row in enumerate(rows):
        historical_high = max(historical_high, row[2])
        if i >= 5:
            samples["speed"].append(max(0, 100 * (1 - row[1] / rows[i-5][1])))
        for days in PERIODS:
            if i + 1 >= (240 if days == "all" else days):
                high = historical_high if days == "all" else max(x[2] for x in rows[i-days+1:i+1])
                samples[str(days)].append(max(0, 100 * (1 - row[1] / high)))
    def pair(values):
        values = sorted(values)
        n = len(values)
        require(n >= 240, "TRAINING_SAMPLE_SHORT")
        return [values[(80*n+99)//100-1], values[(95*n+99)//100-1], n]
    return {k: pair(v) for k, v in samples.items()}


def build(root, client, now):
    root = Path(root)
    pointer = read(root / "data/lc4-research/latest.json")
    history = load_history(root)
    anchor = history["asof"]
    rows = [[r["date"], r["close"], r["high"], r["low"]] for r in history["histories"][SYMBOL]]
    target, _, _ = research_expected_day(client, now)
    filename = root / FILE
    old = read(filename) if filename.exists() else None
    require(target >= anchor and (not old or target >= old["asof"]), "ROLLBACK_REJECTED")
    if old and target == old["asof"]:
        return None
    expected, fresh, overlap = [], [], False
    refs = []
    for month in months(anchor, target):
        sessions, evidence = official_sessions(client, "twse", month, target)
        expected.extend(d for d in sessions if anchor < d <= target)
        refs.append(evidence)
        entry = client.get(f"https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date={month}01&stockNo={SYMBOL}")
        refs.append(ref(entry))
        for r in parse_month(entry["payload"], SYMBOL, month, target):
            values = [r["date"], r["close"], r["max"], r["min"]]
            if r["date"] == anchor:
                require(values == rows[-1], "OFFICIAL_OVERLAP_CONFLICT")
                overlap = True
            elif r["date"] > anchor:
                fresh.append(values)
    require(overlap and [r[0] for r in fresh] == expected and (rows + fresh)[-1][0] == target, "MISSING_OFFICIAL_SESSIONS")
    _, action_refs, _ = twse_actions(client, SYMBOL, anchor, target)
    lo, hi = [d.replace("-", "") for d in (anchor, target)]
    split = client.get(f"https://www.twse.com.tw/rwd/zh/split/TWTCAU?response=json&startDate={lo}&endDate={hi}")
    payload = split["payload"]
    require(payload.get("stat") == "OK" and payload.get("fields", [])[:2] == ["恢復買賣日期", "ETF代號"] and isinstance(payload.get("data"), list), "SPLIT_COVERAGE_UNKNOWN")
    require(all(len(r) >= 2 and r[1] != SYMBOL for r in payload["data"]), "NEW_SPLIT_REQUIRES_REVIEW")
    all_rows = rows + fresh
    require(not old or old["rows"] == all_rows[:len(old["rows"])], "PUBLISHED_HISTORY_REVISION")
    limits = thresholds([r for r in rows if r[0] <= TRAIN])
    require(not old or old["thresholds"] == limits, "THRESHOLD_CHANGED")
    return {"schema": "HS_00631L_OBSERVATION_V1", "asof": target,
            "threshold_version": "P80_P95_FIXED_20201231_V1", "training_end": TRAIN,
            "thresholds": limits, "rows": all_rows,
            "verified_at": now.isoformat(), "history_sha256": pointer["sha256"],
            "source": "TWSE/STOCK_DAY + FMTQIK + TWT49U + TWTCAU",
            "evidence": refs + action_refs + [ref(split)]}


if __name__ == "__main__":
    require(os.environ.get("HS_00631L_AUTHORIZED_HISTORY_COLLECTION") == "1",
            "OFFICIAL_HISTORY_COLLECTION_AUTHORIZATION_NOT_CONFIGURED")
    artifact = build(ROOT, Client(sys.argv[1]), dt.datetime.now(TZ))
    if artifact is not None:
        tmp = ROOT / (FILE + ".tmp")
        tmp.write_bytes(encoded(artifact))
        tmp.replace(ROOT / FILE)
        print("00631L verified:", artifact["asof"], "sha256:", sha(encoded(artifact)))
