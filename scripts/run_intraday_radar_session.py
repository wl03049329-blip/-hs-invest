#!/usr/bin/env python3
"""Run the five validated intraday radar refreshes in one GitHub Actions job."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time as time_module
from datetime import datetime, time, timedelta
from pathlib import Path
from typing import Callable
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
TAIPEI = ZoneInfo("Asia/Taipei")
TARGET_SLOTS = ("09:30", "10:30", "11:30", "12:30", "13:30")
CACHE_FILES = (
    "market-quotes.json",
    "market-quotes-meta.json",
    "market-overview.json",
    "tx-futures-quote.json",
)


def slot_datetime(trading_date: str, slot: str) -> datetime:
    return datetime.fromisoformat(f"{trading_date}T{slot}:00").replace(tzinfo=TAIPEI)


def slot_action(now: datetime, target: datetime, grace_minutes: int = 15) -> str:
    if now < target:
        return "wait"
    if now > target + timedelta(minutes=grace_minutes):
        return "skip"
    return "run"


def run(command: list[str], *, env: dict[str, str] | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    print("$", " ".join(command), flush=True)
    return subprocess.run(command, cwd=ROOT, env=env, text=True, check=check)


def read_refresh_attempt() -> dict:
    try:
        payload = json.loads((ROOT / "market-quotes-meta.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    attempt = payload.get("radar_refresh_attempt")
    return attempt if isinstance(attempt, dict) else {}


def commit_slot(trading_date: str, slot: str, success: bool) -> None:
    run(["git", "add", *CACHE_FILES])
    staged = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=ROOT)
    if staged.returncode == 0:
        print(f"[{slot}] no cache metadata change to commit", flush=True)
        return
    message = (
        f"Update intraday radar {trading_date} {slot}"
        if success
        else f"Record failed intraday radar {trading_date} {slot}"
    )
    run(["git", "commit", "-m", message])
    pushed = run(["git", "push"], check=False)
    if pushed.returncode != 0:
        run(["git", "pull", "--rebase"])
        run(["git", "push"])


def execute_slot(trading_date: str, slot: str, python: str = sys.executable) -> bool:
    run(["git", "pull", "--rebase"])
    env = dict(os.environ)
    env.update({"HS_RADAR_SLOT": slot, "HS_RADAR_TRADING_DATE": trading_date})
    run([python, "scripts/update_market_quotes.py"], env=env)
    attempt = read_refresh_attempt()
    success = (
        attempt.get("verified") is True
        and attempt.get("status") == "success"
        and attempt.get("trading_date") == trading_date
        and attempt.get("slot") == slot
    )
    commit_slot(trading_date, slot, success)
    print(f"[{slot}] {'SUCCESS' if success else 'FAILED'} {json.dumps(attempt, ensure_ascii=False)}", flush=True)
    return success


def run_session(
    now_fn: Callable[[], datetime] = lambda: datetime.now(TAIPEI),
    sleep_fn: Callable[[float], None] = time_module.sleep,
    grace_minutes: int = 15,
    settle_seconds: int = 90,
) -> None:
    started = now_fn().astimezone(TAIPEI)
    if started.weekday() >= 5:
        print("Non-trading weekday: session stopped", flush=True)
        return
    trading_date = started.date().isoformat()
    for slot in TARGET_SLOTS:
        target = slot_datetime(trading_date, slot)
        action = slot_action(now_fn().astimezone(TAIPEI), target, grace_minutes)
        if action == "skip":
            print(f"[{slot}] SKIP: scheduler started after grace window; future quote is never backfilled", flush=True)
            continue
        while now_fn().astimezone(TAIPEI) < target:
            remaining = (target - now_fn().astimezone(TAIPEI)).total_seconds()
            sleep_fn(min(30, max(1, remaining)))
        if settle_seconds:
            sleep_fn(settle_seconds)
        if slot_action(now_fn().astimezone(TAIPEI), target, grace_minutes) == "skip":
            print(f"[{slot}] SKIP: execution missed grace window", flush=True)
            continue
        execute_slot(trading_date, slot)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--slot", choices=TARGET_SLOTS, help="Run one slot immediately (manual recovery).")
    args = parser.parse_args()
    if args.slot:
        today = datetime.now(TAIPEI).date().isoformat()
        execute_slot(today, args.slot)
    else:
        run_session()


if __name__ == "__main__":
    main()
