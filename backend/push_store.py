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


SCHEMA_VERSION = "HS_PUSH_SUBSCRIPTIONS_V2"
LEGACY_SCHEMA_VERSION = "HS_PUSH_SUBSCRIPTIONS_V1"


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
        if value.get("schema_version") not in (SCHEMA_VERSION, LEGACY_SCHEMA_VERSION) or not isinstance(value.get("subscriptions"), list):
            return {"schema_version": SCHEMA_VERSION, "subscriptions": []}
        value["schema_version"] = SCHEMA_VERSION
        for record in value["subscriptions"]:
            record.setdefault("push_rules_version", None)
            record.setdefault("push_rules", None)
            record.setdefault("rules_sync_status", "NOT_SYNCED")
            record.setdefault("baseline_finalized_date", None)
            record.setdefault("baseline_finalized_fingerprint", None)
            record.setdefault("baseline_rule_version", None)
            record.setdefault("alert_state", None)
            record.setdefault("handled_alert_ids", [])
            record.setdefault("handled_bundle_ids", [])
            record.setdefault("last_evaluated_finalized_fingerprint", None)
            record.setdefault("last_background_push_at", None)
            record.setdefault("background_push_failure_count", 0)
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
                    "push_rules_version": None,
                    "push_rules": None,
                    "rules_sync_status": "NOT_SYNCED",
                    "baseline_finalized_date": None,
                    "baseline_finalized_fingerprint": None,
                    "baseline_rule_version": None,
                    "alert_state": None,
                    "handled_alert_ids": [],
                    "handled_bundle_ids": [],
                    "last_evaluated_finalized_fingerprint": None,
                    "last_background_push_at": None,
                    "background_push_failure_count": 0,
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

    def active_records(self) -> list[dict[str, Any]]:
        with self._lock:
            return deepcopy([item for item in self._load()["subscriptions"] if item.get("status") == "ACTIVE"])

    def sync_rules(self, subscription_id: str, *, rules: dict[str, Any], rule_version: str, baseline: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            data = self._load()
            record = next((item for item in data["subscriptions"] if secrets.compare_digest(str(item.get("subscription_id", "")), subscription_id)), None)
            if not record or record.get("status") != "ACTIVE":
                raise KeyError("UNKNOWN_SUBSCRIPTION")
            first_sync = not record.get("baseline_finalized_fingerprint")
            fields = {"push_rules": deepcopy(rules), "push_rules_version": rule_version, "rules_sync_status": "SYNCED", "updated_at": utc_now()}
            if first_sync:
                fields.update({
                    "baseline_finalized_date": baseline["date"],
                    "baseline_finalized_fingerprint": baseline["fingerprint"],
                    "baseline_rule_version": rule_version,
                    "last_evaluated_finalized_fingerprint": baseline["fingerprint"],
                    "alert_state": deepcopy(baseline["alert_state"]),
                })
            record.update(fields)
            self._save(data)
            return deepcopy(record)

    def mark_rules_sync_failed(self, subscription_id: str) -> None:
        self._update(subscription_id, {"rules_sync_status": "FAILED", "updated_at": utc_now()})

    def save_evaluation(self, subscription_id: str, *, fingerprint: str, alert_state: dict[str, Any], handled_alert_ids: list[str], handled_bundle_ids: list[str], pushed_at: str | None = None, failure_increment: int = 0) -> None:
        with self._lock:
            data = self._load()
            record = next((item for item in data["subscriptions"] if secrets.compare_digest(str(item.get("subscription_id", "")), subscription_id)), None)
            if not record:
                return
            record.update({
                "last_evaluated_finalized_fingerprint": fingerprint,
                "alert_state": deepcopy(alert_state),
                "handled_alert_ids": list(dict.fromkeys(handled_alert_ids))[-500:],
                "handled_bundle_ids": list(dict.fromkeys(handled_bundle_ids))[-300:],
                "updated_at": utc_now(),
            })
            if pushed_at:
                record["last_background_push_at"] = pushed_at
            if failure_increment:
                record["background_push_failure_count"] = int(record.get("background_push_failure_count") or 0) + failure_increment
            self._save(data)
