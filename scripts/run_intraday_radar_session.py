#!/usr/bin/env python3
"""Run the five validated intraday radar refreshes in one GitHub Actions job."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, time, timezone
from pathlib import Path
from typing import Callable
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
TAIPEI = ZoneInfo("Asia/Taipei")
TARGET_SLOTS = ("09:30", "10:30", "11:30", "12:30", "13:30")
SLOT_CONTRACT = "HS_LIVE_INTRADAY_SLOT_V4"
FINAL_SLOT_CLOSE = time(14, 20)
SLOT_PENDING = "PENDING"
SLOT_SUCCESS = "SUCCESS"
SLOT_FAILED = "FAILED"
SLOT_MISSED = "MISSED"
SNAPSHOT_SUCCESS = "SNAPSHOT_SUCCESS"
SNAPSHOT_PARTIAL = "SNAPSHOT_PARTIAL"
SNAPSHOT_MISSED = "SNAPSHOT_MISSED"
SNAPSHOT_FAILED = "SNAPSHOT_FAILED"
FAILURE_OPERATIONAL_SOURCE = "OPERATIONAL_SOURCE"
FAILURE_OPERATIONAL_SCHEDULER = "OPERATIONAL_SCHEDULER"
FAILURE_INTEGRITY = "INTEGRITY"
CACHE_FILES = (
    "market-quotes.json",
    "market-quotes-meta.json",
    "market-overview.json",
    "tx-futures-quote.json",
    "intraday-core-snapshots-v1.json",
)


def slot_datetime(trading_date: str, slot: str) -> datetime:
    return datetime.fromisoformat(f"{trading_date}T{slot}:00").replace(tzinfo=TAIPEI)


def slot_end_datetime(trading_date: str, slot: str) -> datetime:
    index = TARGET_SLOTS.index(slot)
    if index + 1 < len(TARGET_SLOTS):
        return slot_datetime(trading_date, TARGET_SLOTS[index + 1])
    return datetime.combine(datetime.fromisoformat(trading_date).date(), FINAL_SLOT_CLOSE, tzinfo=TAIPEI)


def current_slot_for_time(now: datetime) -> str | None:
    """Classify an actual Taipei runtime into one forward-only V4 slot."""
    local_now = now.astimezone(TAIPEI)
    trading_date = local_now.date().isoformat()
    for slot in TARGET_SLOTS:
        if slot_datetime(trading_date, slot) <= local_now < slot_end_datetime(trading_date, slot):
            return slot
    return None


def slot_action(now: datetime, target: datetime) -> str:
    if now < target:
        return "wait"
    slot = target.strftime("%H:%M")
    if slot not in TARGET_SLOTS or now >= slot_end_datetime(target.date().isoformat(), slot):
        return "skip"
    return "run"


def run(command: list[str], *, env: dict[str, str] | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    print("$", " ".join(command), flush=True)
    return subprocess.run(command, cwd=ROOT, env=env, text=True, check=check)


def run_observed(command: list[str], *, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    print("$", " ".join(command), flush=True)
    completed = subprocess.run(command, cwd=ROOT, env=env, text=True, capture_output=True, check=False)
    if completed.stdout:
        print(completed.stdout.rstrip(), flush=True)
    if completed.stderr:
        print(completed.stderr.rstrip(), file=sys.stderr, flush=True)
    return completed


def read_refresh_attempt() -> dict:
    try:
        payload = json.loads((ROOT / "market-quotes-meta.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    attempt = payload.get("radar_refresh_attempt")
    return attempt if isinstance(attempt, dict) else {}


def read_json(path: Path) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def write_json_atomic(path: Path, payload: dict) -> None:
    handle, temp_name = tempfile.mkstemp(prefix=f"{path.stem}-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
            stream.write("\n")
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def new_completeness(trading_date: str) -> dict:
    return {
        "version": 3,
        "contract": SLOT_CONTRACT,
        "trading_date": trading_date,
        "expected_slots": list(TARGET_SLOTS),
        "slots": {slot: {"status": SLOT_PENDING} for slot in TARGET_SLOTS},
        "workflow_status": "OPERATIONAL_OK",
        "integrity_status": "PASS",
        "snapshot_status": SNAPSHOT_PARTIAL,
    }


def load_completeness(trading_date: str) -> dict:
    existing = read_json(ROOT / "market-quotes-meta.json").get("intraday_completeness")
    state = existing if isinstance(existing, dict) and existing.get("trading_date") == trading_date else new_completeness(trading_date)
    state = json.loads(json.dumps(state))
    state["version"] = 3
    state["contract"] = SLOT_CONTRACT
    state["expected_slots"] = list(TARGET_SLOTS)
    slots = state.setdefault("slots", {})
    for slot in TARGET_SLOTS:
        if not isinstance(slots.get(slot), dict):
            slots[slot] = {"status": SLOT_PENDING}
    return summarize_completeness(state)


def summarize_completeness(state: dict, updated_at: datetime | None = None) -> dict:
    slots = state.setdefault("slots", {})
    successful = [slot for slot in TARGET_SLOTS if slots.get(slot, {}).get("status") == SLOT_SUCCESS]
    missed = [
        slot for slot in TARGET_SLOTS
        if slots.get(slot, {}).get("status") == SLOT_MISSED or slots.get(slot, {}).get("expired") is True
    ]
    failed = [slot for slot in TARGET_SLOTS if slots.get(slot, {}).get("status") == SLOT_FAILED]
    pending = [slot for slot in TARGET_SLOTS if slots.get(slot, {}).get("status") == SLOT_PENDING]
    if len(successful) == len(TARGET_SLOTS):
        snapshot_status = SNAPSHOT_SUCCESS
    elif missed and not successful and not failed and not pending:
        snapshot_status = SNAPSHOT_MISSED
    elif failed and not successful:
        snapshot_status = SNAPSHOT_FAILED
    else:
        snapshot_status = SNAPSHOT_PARTIAL
    degraded = sorted(set(missed + failed), key=TARGET_SLOTS.index)
    integrity_failed = any(str(slots.get(slot, {}).get("failure_class", "")).startswith(FAILURE_INTEGRITY) for slot in TARGET_SLOTS)
    state.update({
        "version": 3,
        "contract": SLOT_CONTRACT,
        "expected_slots": list(TARGET_SLOTS),
        "successful_slots": successful,
        "missed_slots": missed,
        "failed_slots": failed,
        "pending_slots": pending,
        "expected_count": len(TARGET_SLOTS),
        "success_count": len(successful),
        "completeness": f"{len(successful)}/{len(TARGET_SLOTS)}",
        "snapshot_status": snapshot_status,
        "degraded_slots": degraded,
        "degraded_count": len(degraded),
        "workflow_status": "INTEGRITY_FAILURE" if integrity_failed else ("OPERATIONAL_DEGRADED" if degraded else "OPERATIONAL_OK"),
        "integrity_status": "FAIL" if integrity_failed else "PASS",
    })
    if updated_at is not None:
        state["updated_at"] = updated_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return state


def reconcile_closed_slots(state: dict, now: datetime) -> dict:
    """Mark a slot MISSED only after its complete V4 window has closed."""
    trading_date = str(state.get("trading_date") or now.astimezone(TAIPEI).date().isoformat())
    for slot in TARGET_SLOTS:
        row = state["slots"][slot]
        if row.get("status") in {SLOT_SUCCESS, SLOT_MISSED}:
            continue
        if now.astimezone(TAIPEI) >= slot_end_datetime(trading_date, slot):
            missed_at = now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
            if row.get("status") == SLOT_FAILED:
                row["last_failure"] = {
                    "attempted_at": row.get("attempted_at"),
                    "failure_class": row.get("failure_class"),
                    "reason": row.get("error"),
                    "diagnostic": row.get("diagnostic"),
                }
            row.update({
                "status": SLOT_MISSED,
                "verified": False,
                "reason": "slot_window_closed_without_success",
                "missed_at": missed_at,
            })
            row.pop("expired", None)
            row.pop("expired_at", None)
            row.pop("expiry_reason", None)
    return summarize_completeness(state, now)


def eligible_slot(state: dict, now: datetime) -> str | None:
    slot = current_slot_for_time(now)
    if slot is None:
        return None
    row = state["slots"][slot]
    return None if row.get("status") in {SLOT_SUCCESS, SLOT_MISSED} else slot


def record_slot_outcome(state: dict, slot: str, status: str, attempt: dict | None, now: datetime) -> dict:
    if slot not in TARGET_SLOTS or status not in {SLOT_SUCCESS, SLOT_FAILED, SLOT_MISSED}:
        raise ValueError("invalid slot outcome")
    row = state["slots"][slot]
    if row.get("status") in {SLOT_SUCCESS, SLOT_MISSED}:
        return summarize_completeness(state, now)
    attempt = attempt if isinstance(attempt, dict) else {}
    attempted_at = attempt.get("attempted_at") or attempt.get("verified_at") or now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    row.update({
        "status": status,
        "attempts": int(row.get("attempts") or 0) + (0 if status == SLOT_MISSED else 1),
        "attempted_at": attempted_at,
    })
    if status == SLOT_SUCCESS:
        as_of = attempt.get("market_as_of")
        row.update({
            "verified": True,
            "market_as_of": as_of,
            "source": attempt.get("source"),
            "first_success_at": attempted_at,
        })
        for key in ("error", "reason", "failure_class", "last_failure", "missed_at"):
            row.pop(key, None)
    elif status == SLOT_FAILED:
        failure_class = str(attempt.get("failure_class") or FAILURE_OPERATIONAL_SOURCE)
        failure_record = {
            "attempted_at": attempted_at,
            "failure_class": failure_class,
            "reason": str(attempt.get("error") or "snapshot_update_failed")[:160],
            "diagnostic": attempt.get("slot_diagnostic"),
        }
        failures = list(row.get("retry_failures") or [])
        failures.append(failure_record)
        row.update({
            "verified": False,
            "error": failure_record["reason"],
            "failure_class": failure_class,
            "last_failure": failure_record,
            "retry_failures": failures[-24:],
        })
    diagnostic = attempt.get("slot_diagnostic")
    if isinstance(diagnostic, dict):
        row["diagnostic"] = diagnostic
    return summarize_completeness(state, now)


def persist_completeness(state: dict) -> None:
    for filename in ("market-quotes.json", "market-quotes-meta.json"):
        path = ROOT / filename
        payload = read_json(path)
        if payload:
            payload["intraday_completeness"] = state
            write_json_atomic(path, payload)


def stageable_cache_files() -> tuple[str, ...]:
    """Return only cache artifacts emitted by this scheduler invocation.

    Some failure paths intentionally do not create the canonical snapshot
    artifact.  A missing optional artifact must not hide the real upstream
    failure by turning persistence into a Git pathspec error.
    """
    stageable: list[str] = []
    for filename in CACHE_FILES:
        if (ROOT / filename).is_file():
            stageable.append(filename)
        else:
            print(f"[staging] skip unavailable cache artifact: {filename}", flush=True)
    return tuple(stageable)


def commit_slot(trading_date: str, slot: str, success: bool) -> None:
    stageable = stageable_cache_files()
    if stageable:
        run(["git", "add", "--", *stageable])
    else:
        print(f"[{slot}] no cache artifacts available to stage", flush=True)
    staged = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=ROOT)
    if staged.returncode == 0:
        print(f"[{slot}] COMMIT_NOT_NEEDED no cache metadata change", flush=True)
        return
    message = (
        f"Update intraday radar {trading_date} {slot}"
        if success
        else f"Record failed intraday radar {trading_date} {slot}"
    )
    run(["git", "commit", "-m", message])
    print(f"[{slot}] COMMIT_OK", flush=True)
    pushed = run(["git", "push"], check=False)
    if pushed.returncode != 0:
        run(["git", "pull", "--rebase"])
        run(["git", "push"])
    print(f"[{slot}] PUSH_OK", flush=True)


def complete_slot_diagnostic(
    trading_date: str,
    slot: str,
    attempt: dict,
    now: datetime,
    *,
    existing_slot_success: bool,
    retry_number: int,
) -> dict:
    source = attempt.get("slot_diagnostic") if isinstance(attempt.get("slot_diagnostic"), dict) else {}
    required_diagnostics = attempt.get("required_symbol_diagnostics") if isinstance(attempt.get("required_symbol_diagnostics"), dict) else {}
    success = attempt.get("verified") is True and attempt.get("status") == "success"
    market_fetch = source.get("market_fetch") or ("PASS" if success else "FAIL")
    core_input = source.get("core_input") or ("PASS" if success else "NOT_RUN")
    score = source.get("score") or ("PASS" if success else "NOT_RUN")
    snapshot_append = source.get("snapshot_append") or ("PASS" if success else "NOT_RUN")
    return {
        "schema_version": 3,
        "contract": SLOT_CONTRACT,
        "trigger_status": "TRIGGERED",
        "trading_date": trading_date,
        "classified_slot": slot,
        "actual_run_time": attempt.get("attempted_at") or attempt.get("verified_at") or now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "market_fetch": market_fetch,
        "fetch_status": "FETCH_OK" if market_fetch == "PASS" else "FETCH_FAILED",
        "required_symbols": source.get("required_symbols") or required_diagnostics.get("symbols", {}),
        "market_as_of": attempt.get("market_as_of"),
        "core_input": core_input,
        "score": score,
        "core_status": "CORE_OK" if core_input == "PASS" and score == "PASS" else "CORE_FAILED",
        "snapshot_append": snapshot_append,
        "snapshot_write_status": "SNAPSHOT_WRITTEN" if snapshot_append == "PASS" else "SNAPSHOT_NOT_WRITTEN",
        "existing_slot_success": existing_slot_success,
        "retry_number": retry_number,
        "failure_class": None if success else attempt.get("failure_class") or source.get("failure_class") or FAILURE_OPERATIONAL_SOURCE,
        "reason": None if success else attempt.get("error") or source.get("reason") or "snapshot_update_failed",
    }


def execute_slot(trading_date: str, slot: str, python: str = sys.executable) -> tuple[bool, dict]:
    env = dict(os.environ)
    env.update({"HS_RADAR_SLOT": slot, "HS_RADAR_TRADING_DATE": trading_date})
    updater = run_observed([python, "scripts/update_market_quotes.py"], env=env)
    attempt = read_refresh_attempt()
    if updater.returncode != 0:
        output = "\n".join(part for part in (updater.stdout, updater.stderr) if part)
        message = (output or "market_input_updater_failed").strip().splitlines()[-1][:160]
        failure_class = FAILURE_INTEGRITY if "INTEGRITY_FAILURE" in output else FAILURE_OPERATIONAL_SOURCE
        attempt = {
            "verified": False,
            "status": "failed",
            "trading_date": trading_date,
            "slot": slot,
            "error": message,
            "failure_class": failure_class,
            "slot_diagnostic": {
                "schema_version": 3,
                "contract": SLOT_CONTRACT,
                "trading_date": trading_date,
                "classified_slot": slot,
                "actual_run_time": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "market_fetch": "FAIL",
                "required_symbols": {},
                "market_as_of": None,
                "core_input": "NOT_RUN",
                "score": "NOT_RUN",
                "snapshot_append": "NOT_RUN",
                "existing_slot_success": False,
                "retry_number": None,
                "failure_class": failure_class,
                "reason": message,
            },
        }
    success = (
        updater.returncode == 0
        and attempt.get("verified") is True
        and attempt.get("status") == "success"
        and attempt.get("trading_date") == trading_date
        and attempt.get("slot") == slot
    )
    if success:
        # The raw quote cache is only an input.  A slot is successful only
        # after the single canonical JS Core publisher has atomically emitted
        # its scored artifact.  This avoids browser-local Core publication.
        published = run_observed(["node", "scripts/build_intraday_core_snapshots.js", "--trading-date", trading_date, "--slot", slot])
        success = published.returncode == 0
        diagnostic = dict(attempt.get("slot_diagnostic") or {})
        if success:
            diagnostic.update({"core_input": "PASS", "score": "PASS", "snapshot_append": "PASS", "failure_class": None, "reason": None})
            attempt = {**attempt, "slot_diagnostic": diagnostic}
        else:
            output = "\n".join(part for part in (published.stdout, published.stderr) if part)
            failure_class = FAILURE_INTEGRITY if "INTRADAY_CORE_INTEGRITY" in output else FAILURE_OPERATIONAL_SOURCE
            reason = (output.strip().splitlines()[-1] if output.strip() else "canonical_intraday_core_snapshot_failed")[:160]
            diagnostic.update({
                "core_input": "FAIL",
                "score": "NOT_PUBLISHED",
                "snapshot_append": "FAIL",
                "failure_class": failure_class,
                "reason": reason,
            })
            attempt = {
                **attempt,
                "verified": False,
                "status": "failed",
                "error": reason,
                "failure_class": failure_class,
                "slot_diagnostic": diagnostic,
            }
    elif "failure_class" not in attempt:
        attempt = {**attempt, "failure_class": FAILURE_OPERATIONAL_SOURCE}
    print(f"[{slot}] {'SUCCESS' if success else 'FAILED'} {json.dumps(attempt, ensure_ascii=False)}", flush=True)
    return success, attempt


def workflow_should_fail(state: dict, now: datetime, attempted_success: bool | None = None) -> bool:
    del now, attempted_success
    return state.get("integrity_status") == "FAIL" or any(
        str(state.get("slots", {}).get(slot, {}).get("failure_class", "")).startswith(FAILURE_INTEGRITY)
        for slot in TARGET_SLOTS
    )


def run_scheduled_once(
    now_fn: Callable[[], datetime] = lambda: datetime.now(TAIPEI),
    execute_fn: Callable[[str, str], tuple[bool, dict]] = execute_slot,
    git_sync: bool = True,
) -> int:
    now = now_fn().astimezone(TAIPEI)
    if now.weekday() >= 5:
        print("Non-trading weekday: scheduler tick stopped", flush=True)
        return 0
    if git_sync:
        run(["git", "pull", "--rebase"])
    trading_date = now.date().isoformat()
    state = load_completeness(trading_date)
    state = reconcile_closed_slots(state, now)
    classified_slot = current_slot_for_time(now)
    slot = eligible_slot(state, now)
    attempted_success: bool | None = None
    if slot:
        retry_number = int(state["slots"][slot].get("attempts") or 0) + 1
        attempted_success, attempt = execute_fn(trading_date, slot)
        attempt = dict(attempt or {})
        attempt["slot_diagnostic"] = complete_slot_diagnostic(
            trading_date,
            slot,
            attempt,
            now,
            existing_slot_success=False,
            retry_number=retry_number,
        )
        print(f"SLOT_DIAGNOSTIC {json.dumps(attempt['slot_diagnostic'], ensure_ascii=False)}", flush=True)
        state = record_slot_outcome(state, slot, SLOT_SUCCESS if attempted_success else SLOT_FAILED, attempt, now)
    elif classified_slot and state["slots"][classified_slot].get("status") == SLOT_SUCCESS:
        locked = complete_slot_diagnostic(
            trading_date,
            classified_slot,
            {"verified": True, "status": "success", "market_as_of": state["slots"][classified_slot].get("market_as_of")},
            now,
            existing_slot_success=True,
            retry_number=int(state["slots"][classified_slot].get("attempts") or 1),
        )
        locked.update({"market_fetch": "NOT_RUN", "fetch_status": "FETCH_NOT_RUN", "core_input": "NOT_RUN", "score": "NOT_RUN", "core_status": "CORE_NOT_RUN", "snapshot_append": "FIRST_SUCCESS_LOCKED", "snapshot_write_status": "FIRST_SUCCESS_LOCKED"})
        print(f"SLOT_DIAGNOSTIC {json.dumps(locked, ensure_ascii=False)}", flush=True)
    state = reconcile_closed_slots(state, now)
    persist_completeness(state)
    if git_sync:
        commit_slot(
            trading_date,
            slot or "audit",
            attempted_success is not False and state.get("snapshot_status") != SNAPSHOT_MISSED,
        )
    print(
        f"INTRADAY_COMPLETENESS {trading_date} {state['completeness']} "
        f"{state['snapshot_status']} success={state['successful_slots']} "
        f"missed={state['missed_slots']} failed={state['failed_slots']}",
        flush=True,
    )
    return 1 if workflow_should_fail(state, now, attempted_success) else 0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--slot", choices=TARGET_SLOTS, help="Run one slot only while its legal as-of window is open.")
    parser.add_argument("--scheduled-once", action="store_true", help="Run one idempotent scheduler tick.")
    args = parser.parse_args()
    if args.scheduled_once or args.slot:
        if args.slot:
            now = datetime.now(TAIPEI)
            classified_slot = current_slot_for_time(now)
            if args.slot != classified_slot:
                print(f"[{args.slot}] refused: current classified slot is {classified_slot or 'NONE'}", flush=True)
                raise SystemExit(1)
        raise SystemExit(run_scheduled_once())
    else:
        raise SystemExit(run_scheduled_once())


if __name__ == "__main__":
    main()
