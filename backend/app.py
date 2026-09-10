"""Read-only FastAPI surface for HS Live Backend V1 runtime state."""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager, suppress
from datetime import datetime

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .live_quotes import TAIPEI
from .runtime_mode import resolve_backend_mode
from .scheduler import ShadowScheduler, bucket_run_id
from .state_store import StateStore

MODE = resolve_backend_mode()

def create_app(
    state_store: StateStore | None = None,
    shadow_scheduler: ShadowScheduler | None = None,
    *,
    backend_mode: str | None = None,
) -> FastAPI:
    active_mode = resolve_backend_mode(backend_mode)
    active_store = state_store or StateStore()
    active_scheduler = shadow_scheduler or ShadowScheduler(active_store, mode=active_mode)
    if active_scheduler.mode != active_mode:
        raise RuntimeError("scheduler/backend mode mismatch")

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        task = None
        if os.getenv("HS_LIVE_DISABLE_SCHEDULER") != "1":
            task = asyncio.create_task(active_scheduler.run_forever(), name=f"hs-live-{active_mode}-scheduler")
        yield
        if task:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

    instance = FastAPI(title="HS Live Backend V1", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    allowed_origin = os.getenv("HS_LIVE_ALLOWED_ORIGIN")
    if allowed_origin:
        instance.add_middleware(CORSMiddleware, allow_origins=[allowed_origin], allow_methods=["GET"], allow_headers=["Accept", "Content-Type"])

    @instance.get("/api/live-scores")
    def live_scores() -> dict:
        return active_store.public_state(datetime.now(TAIPEI), expected_mode=active_mode)

    @instance.get("/healthz")
    def healthz() -> dict:
        now = datetime.now(TAIPEI)
        diagnostics = active_store.readiness(now, backend_mode=active_mode, current_bucket=bucket_run_id(now))
        return {"status": "ok", "mode": active_mode, "live_status": active_store.public_state(now, expected_mode=active_mode).get("status", "UNAVAILABLE"), **diagnostics}

    return instance


app = create_app(backend_mode=MODE)
