from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from backend.push_service import (
    PAYLOAD_VERSION,
    SW_VERSION,
    TEST_BODY,
    TEST_TITLE,
    PushConfig,
    PushConfigurationError,
    PushRateLimitError,
    PushService,
    PushValidationError,
    user_agent_family,
    validate_subscription,
)
from backend.push_store import PushSubscriptionStore


NOW = datetime(2026, 9, 19, 3, 0, tzinfo=timezone.utc)
SUBSCRIPTION = {
    "endpoint": "https://fcm.googleapis.com/fcm/send/test-capability-url",
    "keys": {"p256dh": "A" * 87, "auth": "B" * 22},
}
CONFIG = PushConfig("B" + "A" * 86, "private-is-test-only", "https://example.test")


class ResponseError(RuntimeError):
    def __init__(self, status_code: int) -> None:
        super().__init__("provider body must not be persisted")
        self.response = type("Response", (), {"status_code": status_code})()


class WebPushBackendTests(unittest.TestCase):
    def service(self, root: str, sender=lambda **_: None) -> PushService:
        return PushService(PushSubscriptionStore(root), config=CONFIG, sender=sender)

    def subscribe(self, service: PushService) -> dict:
        return service.subscribe(SUBSCRIPTION, user_agent="Mozilla/5.0 Chrome/140.0")

    def test_01_config_exposes_only_public_material(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            config = self.service(root).public_config()
            self.assertTrue(config["available"])
            self.assertEqual(config["service_worker_version"], SW_VERSION)
            self.assertNotIn(CONFIG.private_key, json.dumps(config))

    def test_02_missing_private_configuration_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            service = PushService(PushSubscriptionStore(root), config=PushConfig("public", "", "subject"))
            with self.assertRaises(PushConfigurationError):
                service.subscribe(SUBSCRIPTION, user_agent="Chrome")

    def test_03_subscription_validation_accepts_known_https_provider(self) -> None:
        self.assertEqual(validate_subscription(SUBSCRIPTION), (SUBSCRIPTION["endpoint"], "A" * 87, "B" * 22))

    def test_04_subscription_validation_rejects_ssrf_endpoint(self) -> None:
        with self.assertRaises(PushValidationError):
            validate_subscription({**SUBSCRIPTION, "endpoint": "https://example.com/internal"})

    def test_05_subscription_validation_rejects_http(self) -> None:
        with self.assertRaises(PushValidationError):
            validate_subscription({**SUBSCRIPTION, "endpoint": "http://fcm.googleapis.com/test"})

    def test_06_duplicate_endpoint_upserts_one_record(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            service = self.service(root)
            first, second = self.subscribe(service), self.subscribe(service)
            self.assertEqual(first["subscription_id"], second["subscription_id"])
            self.assertEqual(service.store.active_count(), 1)

    def test_07_subscription_id_is_opaque_and_endpoint_is_not_returned(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            result = self.subscribe(self.service(root))
            self.assertGreaterEqual(len(result["subscription_id"]), 22)
            self.assertNotIn("endpoint", result)

    def test_08_storage_survives_store_restart(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            result = self.subscribe(self.service(root))
            restarted = PushSubscriptionStore(root)
            self.assertIsNotNone(restarted.get(result["subscription_id"]))

    def test_09_unsubscribe_marks_only_push_subscription_inactive(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            service = self.service(root)
            result = self.subscribe(service)
            self.assertEqual(service.unsubscribe(result["subscription_id"])["status"], "UNSUBSCRIBED")
            self.assertIsNone(service.store.get(result["subscription_id"]))

    def test_10_unknown_unsubscribe_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(PushValidationError):
                self.service(root).unsubscribe("unknown")

    def test_11_fixed_test_payload_has_no_etf_alert_data(self) -> None:
        captured = {}
        with tempfile.TemporaryDirectory() as root:
            service = self.service(root, lambda **kwargs: captured.update(kwargs))
            result = self.subscribe(service)
            service.send_test(result["subscription_id"], now=NOW)
        payload = json.loads(captured["data"])
        self.assertEqual((payload["version"], payload["type"], payload["title"], payload["body"]), (PAYLOAD_VERSION, "TEST_PUSH", TEST_TITLE, TEST_BODY))
        self.assertEqual(set(payload), {"version", "type", "title", "body", "route", "sent_at", "notification_id"})

    def test_12_sender_receives_private_key_without_persisting_it(self) -> None:
        captured = {}
        with tempfile.TemporaryDirectory() as root:
            service = self.service(root, lambda **kwargs: captured.update(kwargs))
            result = self.subscribe(service)
            service.send_test(result["subscription_id"], now=NOW)
            self.assertEqual(captured["private_key"], CONFIG.private_key)
            self.assertNotIn(CONFIG.private_key, Path(root, "push-subscriptions.json").read_text(encoding="utf-8"))

    def test_13_test_push_rate_limit_is_per_subscription(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            service = self.service(root)
            result = self.subscribe(service)
            service.send_test(result["subscription_id"], now=NOW)
            with self.assertRaises(PushRateLimitError):
                service.send_test(result["subscription_id"], now=NOW + timedelta(seconds=59))

    def test_14_test_push_allowed_after_rate_window(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            service = self.service(root)
            result = self.subscribe(service)
            service.send_test(result["subscription_id"], now=NOW)
            self.assertEqual(service.send_test(result["subscription_id"], now=NOW + timedelta(seconds=60))["status"], "SENT")

    def test_15_404_and_410_expire_subscription(self) -> None:
        for status in (404, 410):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as root:
                service = self.service(root, lambda **_: (_ for _ in ()).throw(ResponseError(status)))
                result = self.subscribe(service)
                with self.assertRaises(ResponseError):
                    service.send_test(result["subscription_id"], now=NOW)
                self.assertIsNone(service.store.get(result["subscription_id"]))

    def test_16_transient_failure_is_recorded_without_expiry_or_queue(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            service = self.service(root, lambda **_: (_ for _ in ()).throw(ResponseError(503)))
            result = self.subscribe(service)
            with self.assertRaises(ResponseError):
                service.send_test(result["subscription_id"], now=NOW)
            record = service.store.get(result["subscription_id"])
            self.assertEqual(record["last_failure_class"], "HTTP_503")
            self.assertEqual(record["status"], "ACTIVE")

    def test_17_success_metadata_survives_restart(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            service = self.service(root)
            result = self.subscribe(service)
            service.send_test(result["subscription_id"], now=NOW)
            record = PushSubscriptionStore(root).get(result["subscription_id"])
            self.assertEqual(record["last_success_at"], NOW.isoformat())

    def test_18_user_agent_is_family_only(self) -> None:
        self.assertEqual(user_agent_family("Mozilla/5.0 (private model) Edg/140.0"), "Edge")

    def test_19_store_contains_no_ip_or_hardware_fingerprint_fields(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            self.subscribe(self.service(root))
            payload = json.loads(Path(root, "push-subscriptions.json").read_text(encoding="utf-8"))
            self.assertFalse({"ip", "location", "hardware", "fingerprint"} & set(payload["subscriptions"][0]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
