# Backend (`server/`)

**Decision (2026-09-26).** The operator console gets a FastAPI backend in `server/`, deployed to Render from `render.yaml`. It serves the `/v1` API defined in `plans/operator-console.md`, which is also what `web/src/api/client.ts` calls. Today every read comes from the console fixtures in `web/src/fixtures/console/`, and writes only change in-memory state. The next step is to replace fixture reads with engine output. Uma approved the dependencies; the rule lives in `CONSTRAINTS.md` ("Backend").

The API contract is `plans/operator-console.md` ("Endpoints" and "Contracts"). Do not copy those shapes here. If this note and that plan disagree on a field, the plan wins.

## Run it

```bash
pip install -r requirements.txt
uvicorn server.app:app --reload          # http://localhost:8000, docs at /docs
pytest -q tests/test_server.py
```

## How the wall reaches it

- `GET /health` returns `{ "ok": true }`. Render uses it as the health check, and the wall polls it.
- `web/src/api/health.ts`: `checkHealth(fetch, baseUrl)` returns `ok`, or `down` with a reason (`http <status>`, `bad_payload`, `timeout`, `unreachable`). `useApiHealth()` checks on load and every 30 s. The masthead line in `TopStrip` shows `api ok` (OK color), `api down · <reason>` (Dead color), or `api checking`.
- Base URL: `VITE_API_BASE_URL` at build time. Empty means same origin.
- Dev: `web/vite.config.ts` proxies `/health` and `/v1` to `http://localhost:8000` (override with `API_PROXY_TARGET`), so dev needs no CORS. With the API stopped, the proxy answers 500, so the mast reads `api down · http 500`.
- Deployed: build the wall with `VITE_API_BASE_URL=https://<api host>` and add the wall's origin to `CORS_ORIGINS` on the API. `http://localhost:5173` is allowed by default.
- `createClient` in `web/src/api/client.ts` takes the `/v1` root. Pass `${apiBaseUrl()}/v1` when the wall starts using it.

## Layout

| File | What it holds |
|---|---|
| `server/app.py` | `create_app()`: CORS, `/health`, the `ApiError` handler, in-memory state. `app` is the module-level instance uvicorn loads. |
| `server/v1.py` | Every `/v1` route, the request bodies, `ConsoleState`, `ApiError`. |
| `server/fixtures.py` | `FixtureStore`: reads `<name>.json` from the fixture folder on every call. |
| `tests/test_server.py` | One test per contract rule (operator header, 409s, retry once, playback). |
| `render.yaml` | Render Blueprint for the API service. |

`web/src/fixtures/console/zone.json` was added for `GET /v1/zone`; it is the plan's example. The web tests do not use it.

## Settings (environment variables)

The server reads plain environment variables. It does not load `.env`.

| Name | Default | Meaning |
|---|---|---|
| `PORT` | set by Render | Port uvicorn binds (`--port $PORT` in `render.yaml`). |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated origins allowed to call the API. |
| `CONSOLE_SCENE` | `live-ok` | Which fixture `GET /v1/live` returns: `live-ok`, `bad-feed`, `retry-spent`, `stress-reserve`. A bad name stops startup. |
| `CONSOLE_FIXTURES_DIR` | `web/src/fixtures/console` | Folder `FixtureStore` reads. |

## Behavior today (scaffold limits, say them out loud)

- Reads are fixtures. Nothing is live ERCOT, and the fixtures do not move.
- `GET /v1/live` returns the `CONSOLE_SCENE` fixture, or `playback.json` while a tape is playing.
- `GET /v1/live/stream` sends one `tick` frame, then closes. The client falls back to `GET /v1/live`.
- `GET /v1/ticks?from=&to=` filters the five tick fixtures by `ts`. Both times need a UTC offset, or the reply is 422.
- `POST /v1/fleet/mode` records the requested mode and returns 202. The tick does not change, because the engine, not the server, applies the mode.
- `POST /v1/attention/{id}` records the choice. A retry marks that attention's retry as spent, and the next `GET /v1/live` shows `retry_spent: true` with choices `approve, skip`. No choice changes the mode.
- `POST /v1/playback` starts the named tape at tick 0. `POST /v1/playback/stop` clears it.
- State is in memory and per process. A restart (or a Render free-tier spin-down) returns to live with no playback.

## Rules for changes

- The server never allocates, rates risk, or sets a floor. Import results from `storm_prep/`; do not recompute them in a route.
- Keep the error body `{ "error", "brief" }`. Raise `ApiError`; do not use FastAPI's `HTTPException`, whose body is `{ "detail" }` and which the wall does not read.
- Every `POST` calls `_require_operator` first.
- Build each app with `create_app()` in tests so state does not leak between tests.
- New dependencies need Uma's approval (`CONSTRAINTS.md`).

## Deploy on Render

1. Render dashboard, then New, then Blueprint. Pick this repo. Render reads `render.yaml` and creates `reservegate-api`.
2. After the wall is deployed, add its URL to `CORS_ORIGINS` in the service's environment.
3. Render checks `/health` before it sends traffic to a new deploy.

Python is pinned to 3.12 through `PYTHON_VERSION`, to match CI. The free plan sleeps when idle, so the first request after a pause is slow and in-memory state is gone.

Not done: deploying `web/` itself. `vite build` only builds `index.html` today (the other HTML pages are not in `rollupOptions.input`), and only `/health` is called from the wall so far. A Render static site would build with `VITE_API_BASE_URL` set to the API URL.

## Next step: engine output instead of fixtures

Swap `FixtureStore` reads for engine data one route at a time, keeping the response shape from the plan. `var/runs/latest.json` (see `CONSTRAINTS.md`, "Engine output") has `TickResult` fields, not the console tick shape, so the mapping belongs in one server function with its own tests. The engine owner (Uma) decides how mode and attention writes reach the engine.
