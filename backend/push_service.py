"""VAPID Web Push service for the manually requested Phase 11B2-A test push."""

from __future__ import annotations

import json
import math
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import urlparse

from .push_store import PushSubscriptionStore

PUSH_API_VERSION = "HS_WEB_PUSH_API_V1"
PAYLOAD_VERSION = "HS_WEB_PUSH_PAYLOAD_V1"
SW_VERSION = "HS_PUSH_SW_V1"
TEST_TITLE = "HS ETF 雷達"
TEST_BODY = "背景通知測試成功"
MIN_TEST_INTERVAL_SECONDS = 60
ALLOWED_ENDPOINT_HOSTS = (
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com",
    "push.services.mozilla.com",
    "web.push.apple.com",
)
ALLOWED_ENDPOINT_SUFFIXES = (".notify.windows.com", ".push.apple.com")
BASE64URL = re.compile(r"^[A-Za-z0-9_-]+$")


class PushConfigurationError(RuntimeError):
    pass


class PushValidationError(ValueError):
    pass


class PushRateLimitError(RuntimeError):
    pass


@dataclass(frozen=True)
class PushConfig:
    public_key: str
    private_key: str
    subject: str

    @property
    def ready(self) -> bool:
        return bool(self.public_key and self.private_key and self.subject)


def load_push_config() -> PushConfig:
    return PushConfig(
        public_key=os.getenv("VAPID_PUBLIC_KEY", "").strip(),
        private_key=os.getenv("VAPID_PRIVATE_KEY", "").strip(),
        subject=os.getenv("VAPID_SUBJECT", "").strip(),
    )


def user_agent_family(value: str) -> str:
    text = value.lower()
    if "edg/" in text:
        return "Edge"
    if "firefox/" in text:
        return "Firefox"
    if "crios/" in text or "chrome/" in text:
        return "Chrome"
    if "iphone" in text or "ipad" in text:
        return "iOS Safari"
    if "safari/" in text:
        return "Safari"
    return "Other"


def validate_subscription(subscription: dict[str, Any]) -> tuple[str, str, str]:
    endpoint = subscription.get("endpoint")
    keys = subscription.get("keys")
    if not isinstance(endpoint, str) or not isinstance(keys, dict):
        raise PushValidationError("INVALID_SUBSCRIPTION")
    parsed = urlparse(endpoint)
    host = (parsed.hostname or "").lower()
    host_allowed = host in ALLOWED_ENDPOINT_HOSTS or any(host.endswith(suffix) for suffix in ALLOWED_ENDPOINT_SUFFIXES)
    if parsed.scheme != "https" or not host_allowed or len(endpoint) > 2048:
        raise PushValidationError("INVALID_PUSH_ENDPOINT")
    p256dh, auth = keys.get("p256dh"), keys.get("auth")
    if not all(isinstance(item, str) and 8 <= len(item) <= 512 and BASE64URL.fullmatch(item) for item in (p256dh, auth)):
        raise PushValidationError("INVALID_PUSH_KEYS")
    return endpoint, p256dh, auth


def _default_sender(*, subscription_info: dict[str, Any], data: str, private_key: str, subject: str) -> Any:
    from pywebpush import webpush

    return webpush(
        subscription_info=subscription_info,
        data=data,
        vapid_private_key=private_key,
        vapid_claims={"sub": subject},
        ttl=60,
        timeout=10,
    )


class PushService:
    def __init__(self, store: PushSubscriptionStore, *, config: PushConfig | None = None, sender: Callable[..., Any] | None = None) -> None:
        self.store = store
        self.config = config or load_push_config()
        self.sender = sender or _default_sender

    def public_config(self) -> dict[str, Any]:
        return {
            "version": PUSH_API_VERSION,
            "available": self.config.ready,
            "public_key": self.config.public_key if self.config.ready else None,
            "service_worker_version": SW_VERSION,
            "minimum_test_interval_seconds": MIN_TEST_INTERVAL_SECONDS,
        }

    def subscribe(self, subscription: dict[str, Any], *, user_agent: str) -> dict[str, Any]:
        if not self.config.ready:
            raise PushConfigurationError("PUSH_NOT_CONFIGURED")
        endpoint, p256dh, auth = validate_subscription(subscription)
        record = self.store.upsert(endpoint=endpoint, p256dh=p256dh, auth=auth, user_agent_family=user_agent_family(user_agent))
        return {"status": "SUBSCRIBED", "subscription_id": record["subscription_id"], "updated_at": record["updated_at"]}

    def unsubscribe(self, subscription_id: str) -> dict[str, Any]:
        if not self.store.deactivate(subscription_id):
            raise PushValidationError("UNKNOWN_SUBSCRIPTION")
        return {"status": "UNSUBSCRIBED"}

    def send_test(self, subscription_id: str, *, now: datetime | None = None) -> dict[str, Any]:
        if not self.config.ready:
            raise PushConfigurationError("PUSH_NOT_CONFIGURED")
        record = self.store.get(subscription_id)
        if not record:
            raise PushValidationError("UNKNOWN_SUBSCRIPTION")
        instant = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        previous = record.get("last_test_push_at")
        if previous:
            try:
                elapsed = (instant - datetime.fromisoformat(previous).astimezone(timezone.utc)).total_seconds()
            except ValueError:
                elapsed = 0
            if elapsed < MIN_TEST_INTERVAL_SECONDS:
                raise PushRateLimitError("TEST_PUSH_RATE_LIMITED")
        sent_at = instant.isoformat()
        self.store.mark_test_attempt(subscription_id, sent_at)
        payload = {
            "version": PAYLOAD_VERSION,
            "type": "TEST_PUSH",
            "title": TEST_TITLE,
            "body": TEST_BODY,
            "route": "./",
            "sent_at": sent_at,
            "notification_id": f"test-{subscription_id[:12]}-{math.floor(instant.timestamp())}",
        }
        try:
            self.sender(
                subscription_info={"endpoint": record["endpoint"], "keys": {"p256dh": record["p256dh"], "auth": record["auth"]}},
                data=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                private_key=self.config.private_key,
                subject=self.config.subject,
            )
        except Exception as error:
            response = getattr(error, "response", None)
            status_code = getattr(response, "status_code", None) or getattr(error, "status_code", None)
            expired = status_code in (404, 410)
            error_class = f"HTTP_{status_code}" if isinstance(status_code, int) else type(error).__name__
            self.store.mark_failure(subscription_id, error_class=error_class, failed_at=sent_at, expired=expired)
            raise
        self.store.mark_success(subscription_id, sent_at)
        return {"status": "SENT", "sent_at": sent_at, "notification_id": payload["notification_id"]}
