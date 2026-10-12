from __future__ import annotations
import asyncio
import tempfile
import unittest
import json
from pathlib import Path
from datetime import timedelta
from unittest.mock import patch

from backend.scheduler import ShadowScheduler
from backend.state_store import StateStore
from test_live_backend_production_cutover import NOW, Holiday, successful_public
from backend.state_store import unavailable_public


class ReadinessTests(unittest.TestCase):
    def test_live_api_schema_for_available_unavailable_and_wait_native(self):
        from jsonschema import Draft202012Validator, ValidationError
        schema=json.loads((Path(__file__).resolve().parents[1]/"backend/live_state.schema.json").read_text(encoding="utf-8"))
        Draft202012Validator.check_schema(schema)
        validator=Draft202012Validator(schema)
        validator.validate(successful_public())
        validator.validate(unavailable_public("SOURCE_UNAVAILABLE",now=NOW))
        invalid=successful_public()
        invalid["tickers"].pop("009815")
        with self.assertRaises(ValidationError): validator.validate(invalid)
        invalid=successful_public()
        invalid["tickers"]["0050"]["score"]=True
        with self.assertRaises(ValidationError): validator.validate(invalid)

    def test_dispatch_does_not_mean_published_and_stale_quotes_do_not_mean_available(self):
        with tempfile.TemporaryDirectory() as directory:
            store = StateStore(directory)
            store.save({"schema_version": 1, "mode": "production",
                "current_public_state": successful_public(), "completeness": "5/5",
                "quote_timestamps": {s: NOW.isoformat() for s in successful_public()["tickers"]},
                "last_successful_run": {"run_id": "bucket", "at": NOW.isoformat()},
                "publication_status": "DISPATCH_ACCEPTED"})
            ready = store.readiness(NOW, backend_mode="production", current_bucket="bucket",
                                    scheduler={"status": "HEALTHY"})
            self.assertTrue(ready["service_alive"])
            self.assertEqual(ready["readiness_status"], "READY")
            self.assertEqual(ready["last_successful_bucket"], "bucket")
            self.assertFalse(ready["publication_complete"])
            self.assertEqual(ready["publication_verification"], "PENDING_EXTERNAL_VERIFICATION")
            stale = store.readiness(NOW + timedelta(seconds=601), backend_mode="production",
                                    current_bucket="next", scheduler={"status": "HEALTHY"})
            self.assertEqual(stale["readiness_status"], "DEGRADED")
            self.assertEqual(stale["data_status"], "UNAVAILABLE")
            self.assertEqual(set(stale["required_symbols_status"].values()), {"UNAVAILABLE"})

    def test_live_process_and_dead_scheduler_are_different(self):
        with tempfile.TemporaryDirectory() as directory:
            scheduler = ShadowScheduler(StateStore(directory), calendar=Holiday())
            self.assertEqual(scheduler.diagnostics(NOW, running=False, enabled=True)["status"], "STOPPED")
            self.assertEqual(scheduler.diagnostics(NOW, running=True, enabled=False)["status"], "DISABLED")
            self.assertEqual(scheduler.diagnostics(NOW, running=True, enabled=True)["status"], "STARTING")
            scheduler.last_heartbeat_at = NOW - timedelta(seconds=601)
            self.assertEqual(scheduler.diagnostics(NOW, running=True, enabled=True)["status"], "STALLED")
            scheduler.last_heartbeat_at = NOW
            self.assertEqual(scheduler.diagnostics(NOW, running=True, enabled=True)["status"], "HEALTHY")

    def test_off_session_does_not_require_live_scores_but_requires_heartbeat(self):
        with tempfile.TemporaryDirectory() as directory:
            scheduler = ShadowScheduler(StateStore(directory), calendar=Holiday())
            self.assertEqual(asyncio.run(scheduler.tick(NOW)), "HOLIDAY")
            ready = scheduler.store.readiness(NOW, backend_mode="shadow", current_bucket="none",
                                             scheduler={"status": "HEALTHY"})
            self.assertEqual(ready["data_status"], "OFF_SESSION")
            self.assertEqual(ready["readiness_status"], "READY")
            stopped = scheduler.store.readiness(NOW, backend_mode="shadow", current_bucket="none",
                                               scheduler={"status": "STOPPED"})
            self.assertEqual(stopped["readiness_status"], "DEGRADED")

    def test_real_loop_updates_heartbeat_without_collecting_closed_history(self):
        with tempfile.TemporaryDirectory() as directory:
            scheduler = ShadowScheduler(StateStore(directory), calendar=Holiday())
            async def stop(_):
                raise asyncio.CancelledError()
            with patch("backend.scheduler.asyncio.sleep", stop):
                with self.assertRaises(asyncio.CancelledError):
                    asyncio.run(scheduler.run_forever())
            self.assertIsNotNone(scheduler.last_heartbeat_at)
            self.assertFalse(scheduler.tick_in_progress)
            self.assertIsNone(scheduler.store.snapshot().get("last_successful_run"))

    def test_api_health_distinguishes_disabled_scheduler_from_liveness(self):
        import os
        from fastapi.testclient import TestClient
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
                "HS_LIVE_VOLUME_PATH": directory, "HS_LIVE_DISABLE_SCHEDULER": "1",
                "HS_BACKGROUND_ALERT_DISABLE": "1"}):
            from backend.app import create_app
            app = create_app(state_store=StateStore(directory))
            with TestClient(app) as client:
                response = client.get("/healthz")
                self.assertEqual(response.status_code, 200)
                body = response.json()
                self.assertTrue(body["service_alive"])
                self.assertEqual(body["scheduler"]["status"], "DISABLED")
                self.assertEqual(body["readiness_status"], "DEGRADED")
                self.assertFalse(body["publication_complete"])


if __name__ == "__main__":
    unittest.main()
