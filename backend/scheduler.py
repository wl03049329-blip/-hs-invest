"""Persistent Asia/Taipei shadow scheduler with bucket and Volume locking."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import time
from datetime import datetime, time as wall_time
from pathlib import Path
from typing import Any, Callable

from .live_quotes import REQUIRED_SYMBOLS, TAIPEI, QuoteBatch, fetch_live_batch
from .runtime_mode import resolve_backend_mode
from .state_store import StateStore, unavailable_public
from .trading_calendar import TradingCalendar

C4_VERSION = "FINAL_CORE_WEIGHT_V1"
ROOT = Path(__file__).resolve().parents[1]


def compare_legacy_anchor(snapshot: dict[str, Any], artifact_path: Path = ROOT / "intraday-core-snapshots-v1.json") -> dict[str, Any]:
    """Compare scores only when the old publisher has the identical raw fingerprint."""
    try:
        artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
        fingerprint = str(snapshot.get("source", {}).get("input_fingerprint", ""))
        candidate = next(
            item for item in artifact.get("snapshots", [])
            if item.get("trading_date") == snapshot.get("trading_date")
            and item.get("source", {}).get("input_fingerprint") == fingerprint
        )
    except (OSError, ValueError, StopIteration):
        return {"status": "NO_MATCHING_FINGERPRINT", "score_comparison": "NOT_APPLICABLE"}
    mismatches = [
        symbol for symbol in REQUIRED_SYMBOLS
        if candidate.get("items", {}).get(symbol, {}).get("score") != snapshot.get("items", {}).get(symbol, {}).get("score")
    ]
    return {
        "status": "EXACT_MATCH" if not mismatches else "MISMATCH",
        "score_comparison": "EXACT" if not mismatches else "RAW_SCORE_MISMATCH",
        "mismatched_symbols": mismatches,
        "legacy_market_as_of": candidate.get("market_as_of"),
        "legacy_completeness": candidate.get("source_completeness"),
    }


def five_minute_bucket(now: datetime) -> datetime:
    local = now.astimezone(TAIPEI)
    return local.replace(minute=(local.minute // 5) * 5, second=0, microsecond=0)


def bucket_run_id(now: datetime) -> str:
    return five_minute_bucket(now).isoformat(timespec="minutes")


def session_state(now: datetime) -> str:
    local = now.astimezone(TAIPEI)
    return "OPEN" if wall_time(9, 0) <= local.time() <= wall_time(13, 30, 59) else "CLOSED"


class C4Bridge:
    def __init__(self, store: StateStore, node_binary: str | None = None) -> None:
        self.store = store
        self.node_binary = node_binary or os.getenv("HS_NODE_BINARY", "node")
        self.script = Path(__file__).with_name("c4_bridge.js")

    def score(self, batch: QuoteBatch, calculated_at: str) -> dict[str, Any]:
        request = {
            "trading_date": batch.trading_date,
            "slot": batch.slot,
            "captured_at": batch.captured_at,
            "calculated_at": calculated_at,
            "quotes": batch.items,
            "history_cache_dir": str(self.store.history_dir),
        }
        process = subprocess.run(
            [self.node_binary, str(self.script)], input=json.dumps(request), text=True,
            capture_output=True, timeout=120, check=False,
        )
        if process.returncode != 0:
            raise RuntimeError(f"C4_BRIDGE:{process.stderr.strip()[:300]}")
        output = json.loads(process.stdout)
        if output.get("status") != "SUCCESS":
            raise RuntimeError("C4_BRIDGE_INVALID_STATUS")
        return output


class ShadowScheduler:
    def __init__(
        self,
        store: StateStore,
        *,
        calendar: TradingCalendar | None = None,
        quote_fetcher: Callable[[datetime], QuoteBatch] = fetch_live_batch,
        scorer: Any | None = None,
        mode: str | None = None,
    ) -> None:
        self.store = store
        self.mode = resolve_backend_mode(mode)
        self.calendar = calendar or TradingCalendar()
        self.quote_fetcher = quote_fetcher
        self.scorer = scorer or C4Bridge(store)
        self._lock = asyncio.Lock()

    def _save_unavailable(
        self,
        now: datetime,
        reason: str,
        market_state: str,
        calendar_revision: str | None,
        run_id: str | None = None,
        gap: dict[str, Any] | None = None,
        completeness: str = "0/5",
        quote_timestamps: dict[str, str] | None = None,
        quote_freshness: dict[str, str] | None = None,
        quote_sources: dict[str, str] | None = None,
    ) -> None:
        previous = self.store.snapshot()
        public = unavailable_public(
            reason, now=now, previous=previous.get("current_public_state"),
            market_state=market_state, completeness=completeness,
        )
        self.store.save({
            "schema_version": 1, "mode": self.mode, "current_public_state": public,
            "last_successful_run": previous.get("last_successful_run"),
            "last_attempted_run": {"run_id": run_id, "at": now.isoformat(), "status": "UNAVAILABLE", "reason": reason} if run_id else previous.get("last_attempted_run"),
            "market_date": now.astimezone(TAIPEI).date().isoformat(), "calendar_revision": calendar_revision,
            "quote_timestamps": quote_timestamps if quote_timestamps is not None else previous.get("quote_timestamps", {}),
            "quote_freshness": quote_freshness if quote_freshness is not None else previous.get("quote_freshness", {}),
            "quote_sources": quote_sources if quote_sources is not None else previous.get("quote_sources", {}),
            "completeness": completeness, "error_class": reason.split(":", 1)[0],
            "scheduler_gap": gap, "c4_version": previous.get("c4_version"), "input_fingerprint": previous.get("input_fingerprint"),
        })

    async def tick(self, now: datetime | None = None) -> str:
        now = (now or datetime.now(TAIPEI)).astimezone(TAIPEI)
        async with self._lock:
            calendar = self.calendar.check(now.date())
            if calendar.status != "TRADING_DAY":
                state = "HOLIDAY" if calendar.status == "HOLIDAY" else "UNAVAILABLE"
                self._save_unavailable(now, calendar.reason or "CALENDAR_UNKNOWN", state, calendar.revision)
                return state
            if session_state(now) != "OPEN":
                self._save_unavailable(now, "MARKET_CLOSED", "CLOSED", calendar.revision)
                return "CLOSED"

            run_id = bucket_run_id(now)
            before = self.store.snapshot()
            last_attempt = before.get("last_attempted_run") or {}
            if before.get("mode") == self.mode and last_attempt.get("run_id") == run_id:
                return "DUPLICATE"
            gap = None
            try:
                previous_id = str(last_attempt.get("run_id") or "")
                previous_bucket = datetime.fromisoformat(previous_id)
                missing = int((five_minute_bucket(now) - previous_bucket).total_seconds() // 300) - 1
                if previous_bucket.date() == now.date() and missing > 0:
                    gap = {"missed_buckets": missing, "after": previous_id, "before": run_id}
            except ValueError:
                pass

            with self.store.volume_lock() as acquired:
                if not acquired:
                    return "LOCKED"
                started = time.monotonic()
                batch: QuoteBatch | None = None
                try:
                    batch = await asyncio.to_thread(self.quote_fetcher, now)
                    calculated_at = datetime.now(TAIPEI).isoformat()
                    result = await asyncio.to_thread(self.scorer.score, batch, calculated_at)
                    snapshot = result["snapshot"]
                    if result.get("score_version") != C4_VERSION or snapshot.get("score_version") != C4_VERSION:
                        raise RuntimeError("INVALID_SCORE_VERSION")
                    legacy_anchor = compare_legacy_anchor(snapshot)
                    if legacy_anchor["status"] == "MISMATCH":
                        raise RuntimeError("C4_PARITY_MISMATCH")
                    tickers: dict[str, Any] = {}
                    for symbol in REQUIRED_SYMBOLS:
                        item = snapshot.get("items", {}).get(symbol, {})
                        if item.get("status") != "SUCCESS" or not isinstance(item.get("score"), (int, float)):
                            raise RuntimeError(f"INVALID_C4_RESULT:{symbol}")
                        tickers[symbol] = {
                            "score": item["score"], "display_score": item.get("display_score"),
                            "delta_vs_official": item.get("delta_vs_previous_close"),
                            "quote_as_of": batch.quote_timestamps[symbol], "freshness": batch.freshness[symbol],
                            "quote_source": batch.sources.get(symbol), "status": "AVAILABLE",
                        }
                    tickers["009815"] = {"score": None, "display_score": None, "delta_vs_official": None, "quote_as_of": None, "freshness": "WAIT_NATIVE", "quote_source": None, "status": "WAIT_NATIVE"}
                    public = {
                        "schema_version": 1, "status": "AVAILABLE", "market_state": "OPEN",
                        "trading_date": batch.trading_date, "as_of": min(batch.quote_timestamps.values()),
                        "calculated_at": calculated_at, "last_success_at": calculated_at,
                        "completeness": batch.completeness, "diagnostic_reason": None,
                        "c4_version": result["score_version"], "tickers": tickers,
                    }
                    parity = {
                        "run_id": run_id, "quote_as_of": batch.quote_timestamps, "completeness": batch.completeness,
                        "input_fingerprint": result["input_fingerprint"],
                        "raw_c4_scores": {symbol: tickers[symbol]["score"] for symbol in REQUIRED_SYMBOLS},
                        "display_scores": {symbol: tickers[symbol]["display_score"] for symbol in REQUIRED_SYMBOLS},
                        "freshness": batch.freshness, "quote_sources": batch.sources,
                        "duration_ms": round((time.monotonic() - started) * 1000),
                        "last_success_at": calculated_at,
                        "legacy_anchor": legacy_anchor,
                    }
                    state = {
                        "schema_version": 1, "mode": self.mode, "current_public_state": public,
                        "last_successful_run": {"run_id": run_id, "at": calculated_at},
                        "last_attempted_run": {"run_id": run_id, "at": calculated_at, "status": "SUCCESS"},
                        "market_date": batch.trading_date, "calendar_revision": calendar.revision,
                        "quote_timestamps": batch.quote_timestamps, "quote_freshness": batch.freshness,
                        "quote_sources": batch.sources, "completeness": batch.completeness,
                        "error_class": None, "scheduler_gap": gap, "c4_version": result["score_version"],
                        "input_fingerprint": result["input_fingerprint"],
                    }
                    self.store.save(state)
                    self.store.append_parity(parity)
                    return "SUCCESS"
                except Exception as exc:  # noqa: BLE001
                    reason = f"{type(exc).__name__}:{exc}"
                    self._save_unavailable(
                        now, reason, "OPEN", calendar.revision, run_id, gap,
                        completeness=batch.completeness if batch else "0/5",
                        quote_timestamps=batch.quote_timestamps if batch else None,
                        quote_freshness=batch.freshness if batch else None,
                        quote_sources=batch.sources if batch else None,
                    )
                    return "UNAVAILABLE"

    async def run_forever(self) -> None:
        while True:
            await self.tick()
            await asyncio.sleep(30)
