"""Dispatch validated Railway live snapshots to the repository publisher."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable


DISPATCH_EVENT = "hs_live_snapshot_ready"
DEFAULT_REPOSITORY = "wl03049329-blip/-hs-invest"


@dataclass(frozen=True)
class PublicationResult:
    status: str
    artifact_commit_sha: str | None = None


def _safe_quote(row: dict[str, Any]) -> dict[str, Any]:
    fields = (
        "code", "name", "price", "price_field", "previous_close", "date",
        "quote_time", "market", "high", "low", "open", "volume", "source",
        "quote_source",
    )
    return {field: row.get(field) for field in fields}


class GitHubArtifactPublisher:
    """Send no-secret, already-scored payloads through repository_dispatch."""

    def __init__(
        self,
        *,
        token: str | None = None,
        repository: str | None = None,
        opener: Callable[..., Any] = urllib.request.urlopen,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.token = token if token is not None else os.getenv("HS_GITHUB_ARTIFACT_TOKEN")
        self.repository = repository or os.getenv("HS_GITHUB_REPOSITORY", DEFAULT_REPOSITORY)
        self.opener = opener
        self.sleep = sleep

    def publish(self, *, batch: Any, score_result: dict[str, Any], run_id: str, mode: str) -> PublicationResult:
        if mode != "production":
            return PublicationResult("SHADOW_SKIPPED")
        if not self.token:
            return PublicationResult("SECRET_MISSING")
        snapshot = score_result.get("snapshot")
        if not isinstance(snapshot, dict):
            return PublicationResult("INVALID_SNAPSHOT")
        payload = {
            "schema_version": 1,
            "trigger_source": "RAILWAY_PRIMARY",
            "run_id": run_id,
            "trading_date": batch.trading_date,
            "slot": batch.slot,
            "captured_at": batch.captured_at,
            "completeness": batch.completeness,
            "quote_timestamps": batch.quote_timestamps,
            "quote_freshness": batch.freshness,
            "quote_sources": batch.sources,
            "input_fingerprint": score_result.get("input_fingerprint"),
            "score_version": score_result.get("score_version"),
            "quotes": {symbol: _safe_quote(row) for symbol, row in batch.items.items()},
            "snapshot": snapshot,
        }
        body = json.dumps({"event_type": DISPATCH_EVENT, "client_payload": payload}, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            f"https://api.github.com/repos/{self.repository}/dispatches",
            data=body,
            method="POST",
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
                "User-Agent": "HS-Live-Artifact-Publisher/1.0",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        for attempt in range(3):
            try:
                with self.opener(request, timeout=10) as response:
                    status_value = getattr(response, "status", None)
                    status = int(status_value if status_value is not None else response.getcode())
                if status == 204:
                    return PublicationResult("DISPATCH_ACCEPTED")
                if status != 429 and status < 500:
                    return PublicationResult(f"HTTP_{status}")
            except urllib.error.HTTPError as exc:
                if exc.code != 429 and exc.code < 500:
                    return PublicationResult(f"HTTP_{exc.code}")
            except (urllib.error.URLError, TimeoutError, OSError):
                pass
            if attempt < 2:
                self.sleep(2 ** attempt)
        return PublicationResult("DISPATCH_FAILED")
