"""Read-only FastAPI surface for HS Live Backend V1 runtime state."""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager, suppress
from datetime import datetime

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict

from .live_quotes import TAIPEI
from .background_alerts import BackgroundAlertError, BackgroundAlertEvaluator
from .runtime_mode import resolve_backend_mode
from .scheduler import ShadowScheduler, bucket_run_id
from .push_service import PushConfigurationError, PushRateLimitError, PushService, PushValidationError
from .push_store import PushSubscriptionStore
from .state_store import StateStore

MODE = resolve_backend_mode()


class PushKeysInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    p256dh: str
    auth: str


class PushSubscriptionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    endpoint: str
    expirationTime: int | None = None
    keys: PushKeysInput


class PushSubscribeInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    subscription: PushSubscriptionInput
    rules: dict | None = None


class PushIdInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    subscription_id: str


class PushRulesInput(PushIdInput):
    rules: dict

def create_app(
    state_store: StateStore | None = None,
    shadow_scheduler: ShadowScheduler | None = None,
    *,
    backend_mode: str | None = None,
    push_service: PushService | None = None,
    background_evaluator: BackgroundAlertEvaluator | None = None,
) -> FastAPI:
    active_mode = resolve_backend_mode(backend_mode)
    active_store = state_store or StateStore()
    active_scheduler = shadow_scheduler or ShadowScheduler(active_store, mode=active_mode)
    active_push_service = push_service or PushService(PushSubscriptionStore(active_store.root))
    active_background_evaluator = background_evaluator or BackgroundAlertEvaluator(active_push_service)
    if active_scheduler.mode != active_mode:
        raise RuntimeError("scheduler/backend mode mismatch")

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        task = None
        alert_task = None if os.getenv("HS_BACKGROUND_ALERT_DISABLE") == "1" else asyncio.create_task(active_background_evaluator.run_forever(), name="hs-background-alert-evaluator")
        if os.getenv("HS_LIVE_DISABLE_SCHEDULER") != "1":
            task = asyncio.create_task(active_scheduler.run_forever(), name=f"hs-live-{active_mode}-scheduler")
        yield
        for running in (task, alert_task):
            if running:
                running.cancel()
                with suppress(asyncio.CancelledError):
                    await running

    instance = FastAPI(title="HS Live Backend V1", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    allowed_origin = os.getenv("HS_LIVE_ALLOWED_ORIGIN")
    if allowed_origin:
        instance.add_middleware(CORSMiddleware, allow_origins=[allowed_origin], allow_methods=["GET", "POST"], allow_headers=["Accept", "Content-Type"])

    @instance.get("/api/live-scores")
    def live_scores() -> dict:
        return active_store.public_state(datetime.now(TAIPEI), expected_mode=active_mode)

    @instance.get("/healthz")
    def healthz() -> dict:
        now = datetime.now(TAIPEI)
        diagnostics = active_store.readiness(now, backend_mode=active_mode, current_bucket=bucket_run_id(now))
        return {
            "status": "ok",
            "mode": active_mode,
            "live_status": active_store.public_state(now, expected_mode=active_mode).get("status", "UNAVAILABLE"),
            "push_status": "READY" if active_push_service.config.ready else "NOT_CONFIGURED",
            "push_service_worker_version": active_push_service.public_config()["service_worker_version"],
            "push_active_subscription_count": active_push_service.store.active_count(),
            **active_background_evaluator.diagnostics(),
            **diagnostics,
        }

    @instance.get("/api/push/config")
    def push_config() -> dict:
        return {
            **active_push_service.public_config(),
            "background_alerts_enabled": active_background_evaluator.enabled,
            "background_alert_engine": active_background_evaluator.diagnostics()["background_alert_engine"],
        }

    @instance.post("/api/push/subscribe")
    def push_subscribe(body: PushSubscribeInput, request: Request) -> dict:
        try:
            result = active_push_service.subscribe(body.subscription.model_dump(exclude_none=True), user_agent=request.headers.get("user-agent", ""))
            if body.rules is not None:
                result["rules"] = active_background_evaluator.sync_rules(result["subscription_id"], body.rules)
            return result
        except PushConfigurationError as error:
            raise HTTPException(status_code=503, detail=str(error)) from None
        except PushValidationError as error:
            raise HTTPException(status_code=422, detail=str(error)) from None
        except BackgroundAlertError as error:
            raise HTTPException(status_code=422, detail=str(error)) from None

    @instance.post("/api/push/unsubscribe")
    def push_unsubscribe(body: PushIdInput) -> dict:
        try:
            return active_push_service.unsubscribe(body.subscription_id)
        except PushValidationError as error:
            raise HTTPException(status_code=404, detail=str(error)) from None

    @instance.post("/api/push/test")
    def push_test(body: PushIdInput) -> dict:
        try:
            return active_push_service.send_test(body.subscription_id)
        except PushConfigurationError as error:
            raise HTTPException(status_code=503, detail=str(error)) from None
        except PushValidationError as error:
            raise HTTPException(status_code=404, detail=str(error)) from None
        except PushRateLimitError as error:
            raise HTTPException(status_code=429, detail=str(error)) from None
        except Exception as error:
            response = getattr(error, "response", None)
            status_code = getattr(response, "status_code", None) or getattr(error, "status_code", None)
            if status_code in (404, 410):
                raise HTTPException(status_code=410, detail="PUSH_SUBSCRIPTION_EXPIRED") from None
            raise HTTPException(status_code=502, detail="PUSH_PROVIDER_UNAVAILABLE") from None

    @instance.post("/api/push/rules")
    def push_rules(body: PushRulesInput) -> dict:
        try:
            return active_background_evaluator.sync_rules(body.subscription_id, body.rules)
        except KeyError:
            raise HTTPException(status_code=404, detail="UNKNOWN_SUBSCRIPTION") from None
        except BackgroundAlertError as error:
            active_push_service.store.mark_rules_sync_failed(body.subscription_id)
            raise HTTPException(status_code=422, detail=str(error)) from None

    @instance.post("/api/push/test-alert")
    def push_test_alert(body: PushIdInput) -> dict:
        try:
            return active_push_service.send_alert_simulation(body.subscription_id)
        except PushConfigurationError as error:
            raise HTTPException(status_code=503, detail=str(error)) from None
        except PushValidationError as error:
            raise HTTPException(status_code=404, detail=str(error)) from None
        except PushRateLimitError as error:
            raise HTTPException(status_code=429, detail=str(error)) from None
        except Exception as error:
            status_code = getattr(getattr(error, "response", None), "status_code", None) or getattr(error, "status_code", None)
            if status_code in (404, 410):
                raise HTTPException(status_code=410, detail="PUSH_SUBSCRIPTION_EXPIRED") from None
            raise HTTPException(status_code=502, detail="PUSH_PROVIDER_UNAVAILABLE") from None

    return instance


app = create_app(backend_mode=MODE)
