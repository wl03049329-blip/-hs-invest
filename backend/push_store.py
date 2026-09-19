"""Durable, minimal Web Push subscription storage on the Railway Volume."""

from __future__ import annotations

import json
import os
import secrets
import tempfile
import threading
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "HS_PUSH_SUBSCRIPTIONS_V1"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class PushSubscriptionStore:
    """Atomic JSON storage. Endpoints and keys never leave this backend module."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = (self.root / "push-subscriptions.json").resolve()
        if self.root not in self.path.parents:
            raise ValueError("push store path escapes volume")
        self._lock = threading.RLock()
        if not self.path.exists():
            self._save({"schema_version": SCHEMA_VERSION, "subscriptions": []})

    def _load(self) -> dict[str, Any]:
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"schema_version": SCHEMA_VERSION, "subscriptions": []}
        if value.get("schema_version") != SCHEMA_VERSION or not isinstance(value.get("subscriptions"), list):
            return {"schema_version": SCHEMA_VERSION, "subscriptions": []}
        return value

    def _save(self, value: dict[str, Any]) -> None:
        payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
        with self._lock:
            descriptor, temporary = tempfile.mkstemp(prefix="push-subscriptions-", suffix=".tmp", dir=self.root)
            try:
                with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
                    handle.write(payload)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, self.path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)

    def upsert(self, *, endpoint: str, p256dh: str, auth: str, user_agent_family: str) -> dict[str, Any]:
        with self._lock:
            data = self._load()
            now = utc_now()
            existing = next((item for item in data["subscriptions"] if item.get("endpoint") == endpoint), None)
            if existing:
                existing.update({"p256dh": p256dh, "auth": auth, "user_agent_family": user_agent_family, "status": "ACTIVE", "updated_at": now})
                record = existing
            else:
                record = {
                    "subscription_id": secrets.token_urlsafe(24),
                    "endpoint": endpoint,
                    "p256dh": p256dh,
                    "auth": auth,
                    "user_agent_family": user_agent_family,
                    "status": "ACTIVE",
                    "created_at": now,
                    "updated_at": now,
                    "last_success_at": None,
                    "last_failure_at": None,
                    "last_failure_class": None,
                    "last_test_push_at": None,
                }
                data["subscriptions"].append(record)
            self._save(data)
            return deepcopy(record)

    def get(self, subscription_id: str, *, active_only: bool = True) -> dict[str, Any] | None:
        with self._lock:
            record = next((item for item in self._load()["subscriptions"] if secrets.compare_digest(str(item.get("subscription_id", "")), subscription_id)), None)
            if not record or (active_only and record.get("status") != "ACTIVE"):
                return None
            return deepcopy(record)

    def deactivate(self, subscription_id: str, *, status: str = "INACTIVE") -> bool:
        with self._lock:
            data = self._load()
            record = next((item for item in data["subscriptions"] if secrets.compare_digest(str(item.get("subscription_id", "")), subscription_id)), None)
            if not record:
                return False
            record.update({"status": status, "updated_at": utc_now()})
            self._save(data)
            return True

    def mark_test_attempt(self, subscription_id: str, sent_at: str) -> None:
        self._update(subscription_id, {"last_test_push_at": sent_at, "updated_at": sent_at})

    def mark_success(self, subscription_id: str, sent_at: str) -> None:
        self._update(subscription_id, {"last_success_at": sent_at, "last_failure_class": None, "updated_at": sent_at})

    def mark_failure(self, subscription_id: str, *, error_class: str, failed_at: str, expired: bool = False) -> None:
        fields = {"last_failure_at": failed_at, "last_failure_class": error_class[:64], "updated_at": failed_at}
        if expired:
            fields["status"] = "EXPIRED"
        self._update(subscription_id, fields)

    def _update(self, subscription_id: str, fields: dict[str, Any]) -> None:
        with self._lock:
            data = self._load()
            record = next((item for item in data["subscriptions"] if secrets.compare_digest(str(item.get("subscription_id", "")), subscription_id)), None)
            if record:
                record.update(fields)
                self._save(data)

    def active_count(self) -> int:
        with self._lock:
            return sum(item.get("status") == "ACTIVE" for item in self._load()["subscriptions"])
