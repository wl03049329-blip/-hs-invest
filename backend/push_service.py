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
ALERT_PAYLOAD_VERSION = "HS_ETF_ALERT_PUSH_V1"
SW_VERSION = "HS_PUSH_SW_V2"
TEST_TITLE = "HS ETF 雷達"
TEST_BODY = "背景通知測試成功"
SIMULATION_TITLE = "HS ETF 雷達｜背景提醒測試"
SIMULATION_BODY = "00830 模擬進入「加碼條件浮現」"
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

    def _send_payload(self, record: dict[str, Any], payload: dict[str, Any], *, retry_transient: bool) -> None:
        for attempt in range(2 if retry_transient else 1):
            try:
                self.sender(subscription_info={"endpoint": record["endpoint"], "keys": {"p256dh": record["p256dh"], "auth": record["auth"]}}, data=json.dumps(payload, ensure_ascii=False, separators=(",", ":")), private_key=self.config.private_key, subject=self.config.subject)
                return
            except Exception as error:
                response = getattr(error, "response", None)
                status_code = getattr(response, "status_code", None) or getattr(error, "status_code", None)
                expired = status_code in (404, 410)
                error_class = f"HTTP_{status_code}" if isinstance(status_code, int) else type(error).__name__
                self.store.mark_failure(record["subscription_id"], error_class=error_class, failed_at=datetime.now(timezone.utc).isoformat(), expired=expired)
                transient = status_code in (408, 429) or (isinstance(status_code, int) and status_code >= 500) or status_code is None
                if expired or not transient or attempt + 1 >= (2 if retry_transient else 1):
                    raise

    @staticmethod
    def _alert_presentation(bundle: dict[str, Any]) -> tuple[str, str]:
        alerts = list(bundle.get("alerts") or [])
        order = {"DATA_STATUS": 0, "CROSS_LEVEL": 1, "SCORE_THRESHOLD": 2, "HISTORICAL_PERCENTILE": 3, "NEXT_LEVEL": 4}
        alerts.sort(key=lambda item: (order.get(str(item.get("rule_type")), 9), str(item.get("alert_id", ""))))
        primary = alerts[0] if alerts else {}
        etf = str(bundle.get("etf", ""))
        title = f"{etf}｜{len(alerts)} 項正式變化" if len(alerts) > 1 else f"{etf}｜{primary.get('title', '正式狀態更新')}"
        body = str(primary.get("title") or "正式狀態更新")
        if primary.get("description"):
            body += f"\n{primary['description']}"
        if len(alerts) > 1:
            body += f"\n另有 {len(alerts)-1} 項正式變化"
        return title, body

    def send_alert_bundle(self, subscription_id: str, bundle: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
        if not self.config.ready:
            raise PushConfigurationError("PUSH_NOT_CONFIGURED")
        record = self.store.get(subscription_id)
        if not record:
            raise PushValidationError("UNKNOWN_SUBSCRIPTION")
        title, body = self._alert_presentation(bundle)
        sent_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat()
        payload = {"version": ALERT_PAYLOAD_VERSION, "type": "ETF_ALERT_BUNDLE", "bundle_id": str(bundle["bundle_id"]), "etf": str(bundle["etf"]), "finalized_date": str(bundle["trigger_date"]), "title": title, "body": body, "route": f"?radarEtf={bundle['etf']}", "alert_ids": [str(item["alert_id"]) for item in bundle.get("alerts", [])], "sent_at": sent_at}
        self._send_payload(record, payload, retry_transient=True)
        self.store.mark_success(subscription_id, sent_at)
        return {"status": "ACCEPTED", "sent_at": sent_at, "bundle_id": payload["bundle_id"]}

    def send_alert_simulation(self, subscription_id: str, *, now: datetime | None = None) -> dict[str, Any]:
        if not self.config.ready:
            raise PushConfigurationError("PUSH_NOT_CONFIGURED")
        record = self.store.get(subscription_id)
        if not record:
            raise PushValidationError("UNKNOWN_SUBSCRIPTION")
        instant = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        previous = record.get("last_test_push_at")
        if previous and (instant - datetime.fromisoformat(previous).astimezone(timezone.utc)).total_seconds() < MIN_TEST_INTERVAL_SECONDS:
            raise PushRateLimitError("TEST_PUSH_RATE_LIMITED")
        sent_at = instant.isoformat()
        self.store.mark_test_attempt(subscription_id, sent_at)
        payload = {"version": ALERT_PAYLOAD_VERSION, "type": "TEST_ETF_ALERT_BUNDLE", "bundle_id": f"TEST:BUNDLE:{math.floor(instant.timestamp())}", "etf": "00830", "finalized_date": "TEST", "title": SIMULATION_TITLE, "body": SIMULATION_BODY, "route": "?radarEtf=00830", "alert_ids": [f"TEST:00830:CROSS_LEVEL:{math.floor(instant.timestamp())}"], "sent_at": sent_at}
        self._send_payload(record, payload, retry_transient=False)
        self.store.mark_success(subscription_id, sent_at)
        return {"status": "SENT", "sent_at": sent_at, "bundle_id": payload["bundle_id"]}
