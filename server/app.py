"""FastAPI entry point. Run locally with `uvicorn server.app:app --reload`."""

import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from server.api import v1
from server.api.fixtures import FixtureStore
from server.env import load_env


def cors_origins() -> list[str]:
    # The Vite dev server is allowed by default; a deployed wall adds its URL in CORS_ORIGINS.
    raw = os.environ.get("CORS_ORIGINS", "http://localhost:5173")
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


def create_app(fixtures: FixtureStore | None = None) -> FastAPI:
    load_env()
    app = FastAPI(title="ReserveGate console API", version="0.1.0")
    app.state.fixtures = fixtures or FixtureStore()
    # State lives in memory, so a restart returns to live, AUTO, and no playback.
    app.state.console = v1.ConsoleState(scene=v1.valid_scene(os.environ.get("CONSOLE_SCENE", "live-ok")))

    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins(),
        allow_methods=["GET", "POST"],
        allow_headers=["Accept", "Content-Type", "X-Operator-Id"],
    )

    @app.exception_handler(v1.ApiError)
    def api_error(_: Request, exc: v1.ApiError):
        return JSONResponse({"error": exc.error, "brief": exc.brief}, status_code=exc.status)

    @app.get("/health")
    def health():
        return {"ok": True}

    app.include_router(v1.router)
    return app


app = create_app()
