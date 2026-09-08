"""Read-only FastAPI surface for HS Live Backend V1 shadow state."""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager, suppress
from datetime import datetime

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .live_quotes import TAIPEI
from .scheduler import ShadowScheduler
from .state_store import StateStore

MODE = os.getenv("HS_LIVE_BACKEND_MODE", "shadow")
if MODE != "shadow":
    raise RuntimeError("HS_LIVE_BACKEND_MODE must remain shadow in Phase A")

def create_app(state_store: StateStore | None = None, shadow_scheduler: ShadowScheduler | None = None) -> FastAPI:
    active_store = state_store or StateStore()
    active_scheduler = shadow_scheduler or ShadowScheduler(active_store)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        task = None
        if os.getenv("HS_LIVE_DISABLE_SCHEDULER") != "1":
            task = asyncio.create_task(active_scheduler.run_forever(), name="hs-live-shadow-scheduler")
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
        return active_store.public_state(datetime.now(TAIPEI))

    @instance.get("/healthz")
    def healthz() -> dict:
        current = active_store.snapshot().get("current_public_state", {})
        return {"status": "ok", "mode": MODE, "live_status": current.get("status", "UNAVAILABLE")}

    return instance


app = create_app()
