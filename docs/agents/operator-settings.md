# Persist operator HOLD / AUTO

**Decision (2026-09-26).** `POST /v1/fleet/mode` still writes `var/state.json`, and also upserts one row in Supabase `public.operator_settings`. `scripts/live_cycle.py` hydrates that row onto the local file before `loop.run()`, so `allocate()` sees HOLD even when the wall and the laptop do not share a disk. The engine never imports this table. A missing config or a failed call prints nothing on the wall and leaves the local file.

Open this file when you change the operator settings table, the mode POST persist, or how the live worker reads HOLD / AUTO.

## Why

Hold and Auto already survive a local restart in `var/state.json`. The API on Render and the live worker on the laptop do not share that file, so a wall HOLD never reached the next allocate tick.

## Table

One fleet-wide row, id `fleet`. No default insert: an empty table means "use the local file". RLS on, no policies; only the service role key reads or writes. Migration: `supabase/migrations/20260926_operator_settings.sql`.

| Column | Meaning |
|---|---|
| `id` | Always `fleet` |
| `mode` | `AUTO` or `HOLD` |
| `updated_by` | `X-Operator-Id` from the POST |
| `updated_at` | Server clock on upsert |

## Writers and readers

- `server/api/operator_settings.py`: `persist_mode` (best-effort upsert), `load_mode` (None when missing or offline), `hydrate_local_mode` (table wins, else the local file).
- `POST /v1/fleet/mode` writes the file, then `persist_mode`. The route still does not allocate.
- `scripts/live_cycle.py` `run_cycle` calls `hydrate_local_mode` when the caller passes `http_get` (production `main()` passes `requests.get`). Then `loop.run` reads the file as before.
- Tape runs stay AUTO and never read this table.

## What this is not

- Not a second mode in the engine. `allocate` still takes `mode` from `loop.py`.
- Not charge / discharge bands. Those stay in `.env` (`CHARGE_BELOW_USD`, `DISCHARGE_ABOVE_USD`).
- Not a snapshot overlay change. The wall still overlays `var/state.json` on this process.

People page: `docs/humans/operator-settings.md`.
