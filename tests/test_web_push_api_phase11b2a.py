from __future__ import annotations

import os
import tempfile
import unittest

from fastapi.testclient import TestClient

from backend.push_service import PushConfig, PushService
from backend.push_store import PushSubscriptionStore
from backend.state_store import StateStore


SUBSCRIPTION = {
    "endpoint": "https://fcm.googleapis.com/fcm/send/api-test",
    "keys": {"p256dh": "A" * 87, "auth": "B" * 22},
}


class SchedulerStub:
    mode = "production"

    async def run_forever(self) -> None:
        return None


class WebPushApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        os.environ["HS_LIVE_DISABLE_SCHEDULER"] = "1"
        os.environ["HS_LIVE_VOLUME_PATH"] = self.temporary.name
        os.environ["HS_LIVE_ALLOWED_ORIGIN"] = "https://wl03049329-blip.github.io"
        from backend.app import create_app

        store = StateStore(self.temporary.name)
        push = PushService(
            PushSubscriptionStore(store.root),
            config=PushConfig("B" + "A" * 86, "private-test-value", "https://example.test"),
            sender=lambda **_: None,
        )
        self.client = TestClient(create_app(store, SchedulerStub(), backend_mode="production", push_service=push))

    def test_01_config_is_public_and_no_private_key_leaks(self) -> None:
        response = self.client.get("/api/push/config")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["available"])
        self.assertNotIn("private-test-value", response.text)

    def test_02_subscribe_test_and_unsubscribe_contract(self) -> None:
        subscribed = self.client.post("/api/push/subscribe", json={"subscription": SUBSCRIPTION})
        self.assertEqual(subscribed.status_code, 200)
        subscription_id = subscribed.json()["subscription_id"]
        sent = self.client.post("/api/push/test", json={"subscription_id": subscription_id})
        self.assertEqual((sent.status_code, sent.json()["status"]), (200, "SENT"))
        removed = self.client.post("/api/push/unsubscribe", json={"subscription_id": subscription_id})
        self.assertEqual((removed.status_code, removed.json()["status"]), (200, "UNSUBSCRIBED"))

    def test_03_arbitrary_message_body_is_rejected(self) -> None:
        response = self.client.post("/api/push/test", json={"subscription_id": "unknown", "message": "arbitrary"})
        self.assertEqual(response.status_code, 422)

    def test_04_unknown_subscription_is_rejected(self) -> None:
        response = self.client.post("/api/push/test", json={"subscription_id": "unknown"})
        self.assertEqual(response.status_code, 404)

    def test_05_health_reports_push_readiness_without_secret(self) -> None:
        response = self.client.get("/healthz")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["push_status"], "READY")
        self.assertNotIn("private-test-value", response.text)

    def test_06_cors_allows_only_configured_pages_origin_for_post(self) -> None:
        response = self.client.options(
            "/api/push/subscribe",
            headers={"Origin": "https://wl03049329-blip.github.io", "Access-Control-Request-Method": "POST"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("access-control-allow-origin"), "https://wl03049329-blip.github.io")


if __name__ == "__main__":
    unittest.main(verbosity=2)
