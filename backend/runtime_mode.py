"""Validated runtime mode for the HS Live backend."""

from __future__ import annotations

import os

VALID_BACKEND_MODES = frozenset({"shadow", "production"})


def resolve_backend_mode(value: str | None = None) -> str:
    mode = str(value if value is not None else os.getenv("HS_LIVE_BACKEND_MODE", "shadow")).strip().lower()
    if mode not in VALID_BACKEND_MODES:
        raise RuntimeError("HS_LIVE_BACKEND_MODE must be shadow or production")
    return mode
