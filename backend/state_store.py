"""Memory plus atomic Railway Volume state for the shadow backend."""

from __future__ import annotations

import json
import os
import tempfile
import threading
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, time as wall_time
from pathlib import Path
from typing import Any, Iterator
from zoneinfo import ZoneInfo

TAIPEI = ZoneInfo("Asia/Taipei")
REQUIRED_SYMBOLS = ("0050", "00662", "00757", "00830", "00935")
WAIT_NATIVE_SYMBOL = "009815"
FORBIDDEN_TOKENS = ("finalized", "forward", "00631l", "ad_hoc", "intraday-core-snapshots")


def unavailable_public(
    reason: str,
    *,
    now: datetime,
    previous: dict[str, Any] | None = None,
    market_state: str = "UNAVAILABLE",
    completeness: str = "0/5",
) -> dict[str, Any]:
    prior = previous or {}
    tickers = {
        symbol: {"score": None, "display_score": None, "delta_vs_official": None, "quote_as_of": None, "freshness": "UNAVAILABLE", "quote_source": None, "status": "UNAVAILABLE"}
        for symbol in REQUIRED_SYMBOLS
    }
    tickers[WAIT_NATIVE_SYMBOL] = {"score": None, "display_score": None, "delta_vs_official": None, "quote_as_of": None, "freshness": "WAIT_NATIVE", "quote_source": None, "status": "WAIT_NATIVE"}
    return {
        "schema_version": 1,
        "status": "UNAVAILABLE",
        "market_state": market_state,
        "trading_date": now.astimezone(TAIPEI).date().isoformat(),
        "as_of": None,
        "calculated_at": now.isoformat(),
        "last_success_at": prior.get("last_success_at"),
        "completeness": completeness,
        "diagnostic_reason": reason,
        "tickers": tickers,
    }


class StateStore:
    def __init__(self, volume_path: str | Path | None = None) -> None:
        self.root = Path(volume_path or os.getenv("HS_LIVE_VOLUME_PATH", "/data/hs-live")).resolve()
        railway_mount = os.getenv("RAILWAY_VOLUME_MOUNT_PATH")
        if os.getenv("RAILWAY_ENVIRONMENT_ID") and not railway_mount:
            raise RuntimeError("Railway Volume must be mounted for HS Live Backend")
        if railway_mount:
            mount_root = Path(railway_mount).resolve()
            if self.root != mount_root and mount_root not in self.root.parents:
                raise RuntimeError("HS_LIVE_VOLUME_PATH must be inside RAILWAY_VOLUME_MOUNT_PATH")
        self.root.mkdir(parents=True, exist_ok=True)
        self.state_path = self._safe_path("live-state.json")
        self.parity_path = self._safe_path("shadow-parity.jsonl")
        self.history_dir = self._safe_path("history-cache")
        self.history_dir.mkdir(exist_ok=True)
        self.lock_path = self._safe_path("scheduler.lock")
        self._memory_lock = threading.RLock()
        self._state = self._load()

    def _safe_path(self, name: str) -> Path:
        if any(token in name.lower() for token in FORBIDDEN_TOKENS):
            raise ValueError(f"forbidden backend state path: {name}")
        candidate = (self.root / name).resolve()
        if candidate != self.root and self.root not in candidate.parents:
            raise ValueError("state path escapes volume")
        return candidate

    def _load(self) -> dict[str, Any]:
        try:
            value = json.loads(self.state_path.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) and value.get("schema_version") == 1 else {}
        except (OSError, ValueError):
            return {}

    def snapshot(self) -> dict[str, Any]:
        with self._memory_lock:
            return deepcopy(self._state)

    def save(self, value: dict[str, Any]) -> None:
        payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
        with self._memory_lock:
            descriptor, temporary = tempfile.mkstemp(prefix="live-state-", suffix=".tmp", dir=self.root)
            try:
                with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
                    handle.write(payload)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, self.state_path)
                self._state = deepcopy(value)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)

    def append_parity(self, record: dict[str, Any]) -> None:
        with self._memory_lock, self.parity_path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n")
            handle.flush()
            os.fsync(handle.fileno())

    @contextmanager
    def volume_lock(self) -> Iterator[bool]:
        handle = self.lock_path.open("a+b")
        acquired = False
        try:
            try:
                if os.name == "nt":
                    import msvcrt

                    if handle.seek(0, os.SEEK_END) == 0:
                        handle.write(b"0")
                        handle.flush()
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
            except OSError:
                acquired = False
            yield acquired
        finally:
            if acquired:
                if os.name == "nt":
                    import msvcrt

                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            handle.close()

    def public_state(self, now: datetime) -> dict[str, Any]:
        state = self.snapshot()
        public = state.get("current_public_state")
        if not isinstance(public, dict):
            return unavailable_public("NO_SUCCESSFUL_SHADOW_STATE", now=now)
        if public.get("status") != "AVAILABLE":
            return public
        local_now = now.astimezone(TAIPEI)
        reason = None
        if public.get("trading_date") != local_now.date().isoformat():
            reason = "TRADING_DATE_MISMATCH"
        elif not wall_time(9, 0) <= local_now.time() <= wall_time(13, 30, 59):
            reason = "MARKET_CLOSED"
        elif public.get("completeness") != "5/5":
            reason = "INCOMPLETE_REQUIRED_QUOTES"
        else:
            for symbol in REQUIRED_SYMBOLS:
                try:
                    quote_at = datetime.fromisoformat(public["tickers"][symbol]["quote_as_of"])
                    age = local_now - quote_at.astimezone(TAIPEI)
                    if age.total_seconds() < 0 or age.total_seconds() > 600:
                        reason = f"QUOTE_NOT_CURRENT:{symbol}"
                        break
                except (KeyError, TypeError, ValueError):
                    reason = f"QUOTE_INVALID:{symbol}"
                    break
        return unavailable_public(reason, now=now, previous=public, market_state="OPEN") if reason else public
