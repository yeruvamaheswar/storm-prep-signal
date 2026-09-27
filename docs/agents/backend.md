# Backend (`server/`)

**Decision (2026-09-26).** The operator console gets a FastAPI backend in `server/`, deployed to Render from `render.yaml`. It serves the `/v1` API defined in `plans/operator-console.md`, which is also what `web/src/api/client.ts` calls. Today every read comes from the console fixtures in `web/src/fixtures/console/`, and writes only change in-memory state. The next step is to replace fixture reads with engine output. Uma approved the dependencies; the rule lives in `CONSTRAINTS.md` ("Backend").

The API contract is `plans/operator-console.md` ("Endpoints" and "Contracts"). Do not copy those shapes here. If this note and that plan disagree on a field, the plan wins.

## Run it

```bash
pip install -r requirements.txt
uvicorn server.app:app --reload          # http://localhost:8000, docs at /docs
python -m server.engine.cli --fixture    # risk CLI
python -m server.engine --tape PATH      # tick loop
pytest -q
```

## How the wall reaches it

- `GET /health` returns `{ "ok": true }`. Render uses it as the health check, and the wall polls it.
- `web/src/api/health.ts`: `checkHealth(fetch, baseUrl)` returns `ok`, or `down` with a reason (`http <status>`, `bad_payload`, `timeout`, `unreachable`). `useApiHealth()` checks on load and every 30 s. The masthead line in `TopStrip` shows `api ok` (OK color), `api down · <reason>` (Dead color), or `api checking`.
- Base URL: `VITE_API_BASE_URL` at build time. Empty means same origin.
- Dev: `web/vite.config.ts` proxies `/health` and `/v1` to `http://localhost:8000` (override with `API_PROXY_TARGET`), so dev needs no CORS. With the API stopped, the proxy answers 500, so the mast reads `api down · http 500`.
- Deployed on Vercel: `web/vercel.json` rewrites `/health` and `/v1/*` to the Render API, so the wall stays same origin. Leave `VITE_API_BASE_URL` empty and `CORS_ORIGINS` unchanged. See "Deploy the wall on Vercel" below.
- Another host without rewrites: build the wall with `VITE_API_BASE_URL=https://<api host>` and add the wall's origin to `CORS_ORIGINS` on the API. `http://localhost:5173` is allowed by default.
- `createClient` in `web/src/api/client.ts` takes the `/v1` root. Pass `${apiBaseUrl()}/v1` when the wall starts using it.

## Layout

| File | What it holds |
|---|---|
| `server/app.py` | `create_app()`: loads `server/env.py`, CORS, `/health`, the `ApiError` handler, in-memory state. `app` is the module-level instance uvicorn loads. |
| `server/env.py` | `load_env()`: reads `server/.env`, then leaves process env in place. Used by FastAPI and the ERCOT/Supabase scripts. |
| `server/api/v1.py` | Every `/v1` route, the request bodies, `ConsoleState`, `ApiError`. |
| `server/api/snapshot.py` | `GET /v1/snapshot` TickView and `GET /v1/runs/latest`. Live reads `event=live` postings, then `/v1/feeds`. Demo/Synthetic reads the archive at the tape clock. |
| `server/api/feeds.py` | `GET /v1/feeds` catalog, plus `/v1/feeds/outage` and `/v1/feeds/price`. Live: ROPC + ERCOT GETs, cache at `var/signal/`. Demo/Synthetic: `server/api/archive.py`. |
| `server/api/archive.py` | Newest archived NP3-233-CD payload and NP6-905-CD LZ_NORTH row at or before a clock. |
| `server/api/fixtures.py` | `FixtureStore`: reads `<name>.json` from the fixture folder on every call. |
| `server/engine/` | Risk, policy, contracts, tick loop. Routes import results from here; they do not recompute them. |
| `tests/test_server.py` | One test per contract rule (operator header, 409s, retry once, playback). |
| `render.yaml` | Render Blueprint for the API service. |

`web/src/fixtures/console/zone.json` was added for `GET /v1/zone`; it is the plan's example. The web tests do not use it.

## Settings (environment variables)

`create_app()` and the feed routes call `load_env()` in `server/env.py`. That reads `server/.env`, then leaves process env (Render, the shell) in place so it wins. Scripts `load_ercot_archive.py`, `load_ercot_reports.py`, and `check_margin.py` use the same loader. Do not put those names in Vite.

| Name | Default | Meaning |
|---|---|---|
| `PORT` | set by Render | Port uvicorn binds (`--port $PORT` in `render.yaml`). |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated origins allowed to call the API. |
| `CONSOLE_SCENE` | `live-ok` | Which fixture `GET /v1/live` returns: `live-ok`, `bad-feed`, `retry-spent`, `stress-reserve`. A bad name stops startup. |
| `CONSOLE_FIXTURES_DIR` | `web/src/fixtures/console` | Folder `FixtureStore` reads. |
| `ERCOT_USERNAME`, `ERCOT_PASSWORD`, `ERCOT_SUBSCRIPTION_KEY` | unset | Feed proxy only. Missing keys return quality `auth`. |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | unset | Optional history. Names only in `.env.example`. Loaders skip with `no_config` when both are missing. |
| `FETCH_TIMEOUT_S` | `3` | Per-call timeout for the feed proxy's ERCOT reads. |
| `STALE_AFTER_MIN` | `90` | Outage posting older than this is quality `stale`. Price uses a fixed 30 min window. |

## Behavior today (scaffold limits, say them out loud)

- `GET /v1/feeds/outage` and `GET /v1/feeds/price` return `{ quality, cached, body, http_status }`. Live reuses `fetch_outages()` and `fetch_price()`; last good bodies sit in `var/signal/`. Demo/Synthetic reads the archive at the tape clock (`docs/agents/archive-feeds.md`). 401/403 → `auth`; 429/5xx → last good inside the stale window, else `unavailable`. `http_status` is the last ERCOT code, or null. `GET /v1/feeds?event=` is the product catalog from latest `ercot_postings` plus `var/signal/` quality. Details: `docs/agents/feeds-proxy.md`.
- `GET /v1/meta` returns `{ mode: live|demo, fleet_size, source, event, clock }`. `source` is `live`, `archive`, or `fixture` (a tape-only engine run may still say `scenario`). `event` is `beryl`, `heather`, `tuning-2026`, or null. `clock` is `wall`, `archive`, or `fixture`. `?event=` selects a weekend replay. Discovery uses `data/events/<event>/replay.csv`; `web/src/fixtures/layout-run.json` is the copy/fallback path when that file is missing.
- `GET /v1/snapshot` returns one `TickView` (wall contract in `web/src/contracts.ts`). Live reads the newest `event=live` posting (`docs/agents/live-ingest.md`), then those two feeds. When `source=archive`, it GETs `ercot_postings` (same payload as `check_margin.py`), then `compute_risk` and `reserve_policy`, and sends `trigger_mw`, `peak_mw`, zone hour totals, and `policy_reason` from that rating — not tape `22348`. A missing posting is `signal_unavailable` and floor 60%. Stale windows stay in Python (90 / 30). Each feed is `{ product, path, as_of, age_min, quality, hold_on_fail, http_status }` for NP3-233-CD and NP6-905-CD. An outage `LiveFailure` (`auth|timeout|stale|malformed|unavailable`) sets `hold_on_fail` true and `policy_reason` `signal_unavailable`. A price fail is named and does not hold. A failed ingest clears tape 185 and the tape trigger. `brief` is rewritten from the tick's reason codes (`server/engine/brief.py`); Live does not keep "missed on purpose".
- `GET /v1/runs/latest` serves `var/runs/latest.json`. That file is the source of truth (`CONSTRAINTS.md`, `PROJECT_CONTEXT.md`). `public.runs` may be empty. `load_latest_run` only uses table rows when `run_from_table_rows` sees a real run; it reads a page and chooses the run whose last tick has the newest timestamp, so stale probe rows do not win by `run_id` text. `[]` or a pointer in `result` falls back to the snapshot file, then `layout-run.json`. Do not GET PostgREST `/runs` from Vite. Layout-run briefs stay as written for the Demo tape.
- Reads for the console routes are fixtures. Those fixtures do not move.
- `GET /v1/live` returns the `CONSOLE_SCENE` fixture, or `playback.json` while a tape is playing.
- `GET /v1/live/stream` sends scaffold event names `tick`, `attention`, and `home`, plus `feeds`. `home` is a fleet rollup (`live`, `stale`, `dead`, `unconfirmed`, `breaches`), never one row per home. The burst then closes; `createClient().liveStream` falls back to `GET /v1/live`. Live on the wall polls `GET /v1/snapshot` every 20 s instead.
- `GET /v1/ticks?from=&to=` filters the five tick fixtures by `ts`. Both times need a UTC offset, or the reply is 422.
- `POST /v1/fleet/mode` writes `AUTO` or `HOLD` to `var/state.json` and best-effort upserts `public.operator_settings`, then returns 202. The route does not allocate. `allocate()` reads that mode on the next live tick and delivers 0 on HOLD. `GET /v1/snapshot` overlays `mode` from the local file. Detail: `docs/agents/operator-settings.md`.
- `POST /v1/attention/{id}` records the choice. A retry marks that attention's retry as spent, and the next `GET /v1/live` shows `retry_spent: true` with choices `approve, skip`. No choice changes the mode.
- `POST /v1/playback` starts the named tape at tick 0. `POST /v1/playback/stop` clears it.
- State is in memory and per process. A restart (or a Render free-tier spin-down) returns to live with no playback.

## Rules for changes

- Routes never allocate or write a second risk rule. `GET /v1/snapshot` imports `compute_risk` and `reserve_policy` from `server.engine`.
- Keep the error body `{ "error", "brief" }`. Raise `ApiError`; do not use FastAPI's `HTTPException`, whose body is `{ "detail" }` and which the wall does not read.
- Every `POST` calls `_require_operator` first.
- Build each app with `create_app()` in tests so state does not leak between tests.
- New dependencies need an update to `CONSTRAINTS.md` ("Backend"). A new dependency is its own gap.

## Deploy on Render

Live service (2026-09-26): `reservegate-api` at `https://reservegate-api.onrender.com`, free plan, Oregon, auto-deploys `main`. It was created with the build and start commands from `render.yaml`, not through a Blueprint sync, so dashboard edits do not flow back to `render.yaml`.

1. To recreate it: Render dashboard, then New, then Blueprint. Pick this repo. Render reads `render.yaml` and creates `reservegate-api`.
2. Set `ERCOT_*` and, if you want history, `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in the dashboard. `render.yaml` lists the names with `sync: false`. Without them, feeds report quality `auth` and archive Demo fails safe.
3. Set the health check path to `/health` in the dashboard (Settings, Health Checks) if the service was not made from the Blueprint. Likewise copy `startCommand` from `render.yaml` into Settings, Start Command; it starts the `/flow` session worker, the live ERCOT worker, and uvicorn in one instance ([grid-flow.md, Run it on Render](grid-flow.md#run-it-on-render), [live-ingest.md](live-ingest.md)).
4. `CORS_ORIGINS` needs the wall's origin only when the wall calls the API cross-origin. The Vercel wall uses rewrites, so it does not.
5. Non-secret settings the API computes with (`FLEET_SIZE`, `HOME_KWH`, `HOME_MAX_KW`, `BASE_RESERVE_PCT`, `STORM_RESERVE_PCT`, `CHARGE_BELOW_USD`, `DISCHARGE_ABOVE_USD`) are pinned in `render.yaml` with the `.env.example` values, so Render and the laptop worker that writes runs agree. Change them in both files; `tests/test_render_settings.py` fails if they differ. A Blueprint sync applies them; a service not made from the Blueprint needs them copied into the dashboard.

Python is pinned to 3.12 through `PYTHON_VERSION`, to match CI. The free plan sleeps when idle, so the first request after a pause is slow and in-memory state is gone.

## Deploy the wall on Vercel

The wall (`web/`) deploys to Vercel from GitHub. `web/vercel.json` holds the config: Vite build, rewrites of `/health` and `/v1/*` to `https://reservegate-api.onrender.com`, and a fallback to `index.html` so `/fleet` and `/flow` load. Static files (`/assets`, `/geo/ercot-load-zones.json`) are served before the rewrites.

1. Vercel dashboard, then Add New, then Project. Import `yeruvamaheswar/storm-prep-signal`.
2. Root Directory: `web`. Leave "Include files outside the root directory" on; the build reads `../geo/ercot-load-zones.json`.
3. Framework: Vite (from `vercel.json`). Production branch: `main`. No environment variables.
4. Deploy. Every push to `main` redeploys; other branches get preview URLs.

Check: `https://<vercel host>/health` returns `{ "ok": true }`, and the masthead reads `api ok`.

If the Render URL changes, edit the two destinations in `web/vercel.json`. The first request after Render sleeps can take about a minute; the masthead shows `api down · timeout` until the API wakes.

`GET /v1/fleet/rollups` returns zone counts and MW, never the seeded homes. Shape: `docs/agents/fleet-rollups.md`.

## Next step: engine output instead of fixtures

Swap `FixtureStore` reads for engine data one route at a time, keeping the response shape from the plan. `var/runs/latest.json` (see `CONSTRAINTS.md`, "Engine output") has `TickResult` fields, not the console tick shape, so the mapping belongs in one server function with its own tests. How mode and attention writes reach the engine is a later gap; this note does not invent that path.
