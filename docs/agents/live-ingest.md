# Live ERCOT ingest

**Decision (2026-09-26).** A worker (`scripts/live_cycle.py`, on Render since PR #60) fetches the newest NP3-233-CD and NP6-905-CD bodies, upserts them into `ercot_postings` / `ercot_prices` with `event=live`, then runs **one** allocate tick. `GET /v1/snapshot` on Live reads that `event=live` posting for floor, risk, and price, and `var/runs/latest.json` for delivered MW. The engine still does not import Supabase during a tick.

## Why

`latest.json` was a 2026-09-25 stub (`delivered_mw` 0, `reasons: ["temp_stub"]`). Snapshot copied that tick. Auto only wrote `var/state.json`. The wall stayed at 0.00 MW.

## Where it runs (checked 2026-09-27)

It now starts in the Render web service, beside the API:

- `render.yaml` runs `scripts/scenario_session.py`, `scripts/live_cycle.py --loop`, and uvicorn in the one `reservegate-api` service. They share the same `var/` folder while that Render instance is alive, so `/v1/runs/latest`, `/v1/live/orders`, fleet rollups, and the scenario worker see the same files.
- The worker needs `ERCOT_USERNAME`, `ERCOT_PASSWORD`, `ERCOT_SUBSCRIPTION_KEY`, `SUPABASE_URL`, and `SUPABASE_SECRET_KEY` in the Render dashboard. If ERCOT keys are missing, `/v1/snapshot` reports `quality=auth`. If Supabase keys are missing, the local file still updates while the instance is alive, but `public.runs` and the archive rows are not persisted.
- `.github/workflows/ci.yml` only runs tests. Supabase has no `pg_cron`, no `pg_net` and no Edge Functions.
- `GET /v1/runs/latest` still treats `var/runs/latest.json` as source of truth. When a Render instance has no local file yet and falls back to `public.runs`, it reads a page of rows and picks the one with the newest last tick timestamp. This keeps stale probe rows such as `persist-probe-20260926` from beating real timestamp run ids.

- `render.yaml` sets `PYTHONUNBUFFERED=1`, so the workers' `print` lines reach Render's logs instead of sitting in a pipe buffer.
- In `--loop`, a cycle that raises anything other than `SignalUnavailable` prints its traceback and `live_cycle: cycle failed, continuing in Ns`, then the next cycle runs. Before this, one bad cycle ended the worker while uvicorn's `/health` stayed green. A one-shot run (no `--loop`) still raises.
- `loop.write_atomic` writes `latest.json` and `var/fleet/tick_orders.json` to a temp file in the same folder, then `os.replace`s it, so the API never reads a half-written file.

**Free plan sleep (keep-alive ping, 2026-09-27).** Render's free plan spins the service down after about 15 minutes with no inbound HTTP request. The workers are child processes of the same instance, so ticks stop while it sleeps, and the Live page says the worker "looks stopped or asleep". The worker's own ERCOT calls are outbound and do not count as traffic. On wake Render starts a fresh filesystem, so `var/` is lost: `var/runs/latest.json` (until the first new tick, `/v1/runs/latest` falls back to `public.runs`), `var/fleet/homes.json` (fleet charge restarts from the seed) and the `var/dam/` cache (DAM is fetched again). Decision (Rajat, 2026-09-27): keep the free plan and ping it. `.github/workflows/keep-alive.yml` requests `https://reservegate-api.onrender.com/health` every 10 minutes (plus a manual run button). GitHub can start scheduled runs late, and pauses schedules in a repo with no activity for 60 days, so a short nap and a `var/` loss stay possible; only a paid instance removes them. `render.yaml` stays on `plan: free`.

Render free instances can restart or sleep, so every `var/` file the worker keeps (`var/dam/`, `var/fleet/homes.json`, `var/state.json`) is durable only for that running instance. `public.runs`, `ercot_postings`, `ercot_prices`, and `public.homes` are the cross-restart copies. Before moving the worker to a fresh filesystem per run (Render cron, GitHub Actions), keep DAM days and fleet charge in a durable store that `live_cycle.py` reads and writes and passes to `loop.run(live_dam=...)`, so the tick still never imports Supabase.

## Cycle

`run_cycle(settings)`:

1. `fetch_outages` / `fetch_price` (`signal.py`). Timeouts stay secret-free.
2. `live_posting_rows` / `live_price_rows` reuse `load_ercot_reports.posting_rows` / `price_rows`. `file_name` is null. Upsert keys stay `(report, posted_at)` and `(settlement_point, interval_ending)`. Archive events are never deleted.
3. Rate the same NP3 body (`reject_stale` + `compute_risk`). Stale or broken is risk None (60% fail-safe).
4. Hydrate HOLD / AUTO from `public.operator_settings` onto `var/state.json` (table wins; empty or failed leaves the local file). Then `loop.run(..., live=True, frames=[one 0.40 MW frame], live_risk=..., live_price=..., live_zone_prices=...)`. No second ERCOT login for outage or price. HOLD still delivers 0. Detail: `docs/agents/operator-settings.md`.
5. Day-ahead prices (added 2026-09-27). Inside that `loop.run`, when the outage fetch succeeded, `loop.read_live_dam` reads today's DAM file (plus tomorrow's from 13:30 CT) from `var/dam/`, and fetches only a day that is not cached (one ERCOT login for that fetch). So ERCOT is asked for DAM once per day, not every 5 minutes. A failed day logs `fetch_dam_prices failed`, is not cached, and is tried again next cycle; the tick uses the $25/$60 bands for zones without hours. The tick carries `dam_hours`, `dam_label` `ercot`, `dam_as_of`, `zone_hours_needed`, `zone_charge_hours` and `zone_charge_why`. Detail: `docs/agents/dam-forecast.md`.
6. `persist_latest` copies the run into `public.runs`. Missing keys print `skipped: no_config`.

`--loop` sleeps `tick_minutes` (default 5). `--dry-run` skips both upserts (it still fetches DAM into `var/dam/`).

## Schema

`event` is already a text column. Live rows use `event='live'`. No rename. No truncate. Optional index if the table is large:

```sql
create index if not exists ercot_postings_live_newest
  on public.ercot_postings (event, report, posted_at desc);
```

## Snapshot

When the last run’s `source` is `live`, `build_snapshot` calls `archive_ingest(event="live")` first. Direct `live_ingest` (ERCOT on the request) is the fallback if the table has no fresh row. Demo/archive weeks are unchanged.

## Commands

```bash
python scripts/live_cycle.py
python scripts/live_cycle.py --loop
python scripts/live_cycle.py --dry-run
```

People page: `docs/humans/live-worker.md`.
