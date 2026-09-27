# Live ERCOT ingest

**Decision (2026-09-26).** A laptop worker (`scripts/live_cycle.py`) fetches the newest NP3-233-CD and NP6-905-CD bodies, upserts them into `ercot_postings` / `ercot_prices` with `event=live`, then runs **one** allocate tick. `GET /v1/snapshot` on Live reads that `event=live` posting for floor, risk, and price, and `var/runs/latest.json` for delivered MW. The engine still does not import Supabase during a tick.

## Why

`latest.json` was a 2026-09-25 stub (`delivered_mw` 0, `reasons: ["temp_stub"]`). Snapshot copied that tick. Auto only wrote `var/state.json`. The wall stayed at 0.00 MW.

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
