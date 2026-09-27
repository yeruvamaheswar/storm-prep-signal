# Live ERCOT ingest

**Decision (2026-09-26).** A laptop worker (`scripts/live_cycle.py`) fetches the newest NP3-233-CD and NP6-905-CD bodies, upserts them into `ercot_postings` / `ercot_prices` with `event=live`, then runs **one** allocate tick. `GET /v1/snapshot` on Live reads that `event=live` posting for floor, risk, and price, and `var/runs/latest.json` for delivered MW. The engine still does not import Supabase during a tick.

## Why

`latest.json` was a 2026-09-25 stub (`delivered_mw` 0, `reasons: ["temp_stub"]`). Snapshot copied that tick. Auto only wrote `var/state.json`. The wall stayed at 0.00 MW.

## Where it runs (checked 2026-09-27)

Only on a laptop, started by hand. Nothing in production runs it:

- `render.yaml` and the Render account have one service, `reservegate-api`. Its start command runs `scripts/scenario_session.py` and uvicorn, never `live_cycle.py`. There is no Render cron job or worker.
- `.github/workflows/ci.yml` only runs tests. Supabase has no `pg_cron`, no `pg_net` and no Edge Functions.
- Supabase `runs`: all 51 `source=live` rows fall between 2026-09-26 19:46 and 2026-09-27 00:34 UTC, one `--loop` session at the 5-minute cadence.

So every `var/` file the worker keeps (`var/dam/`, `var/fleet/homes.json`, `var/state.json`) sits on the laptop disk and survives each cycle and a restart of `--loop`. Run it from the repo root: `var/` is relative to the working folder. If the worker ever moves to a host with a fresh filesystem per run (Render cron, GitHub Actions), those files reset every run. Before that move, keep the DAM days in a durable store that `live_cycle.py` reads and writes and passes to `loop.run(live_dam=...)`, so the tick still never imports Supabase; the fleet's charge needs the same treatment.

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
