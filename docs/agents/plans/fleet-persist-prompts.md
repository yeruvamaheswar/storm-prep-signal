# 10k fleet persist: parallel prompts

Launch prompts 1–7 together. They do not share files. The table contract below is the shared API; no prompt waits for another to land.

This supersedes the “do not persist a homes table” line in `docs/agents/fleet-rollups.md` for the live 10k fleet. Local `var/fleet/` stays the snapshot the engine writes. Supabase `public.homes` is the copy, same pattern as `public.runs`. The engine still never imports Supabase during a tick.

Copy-paste each block into its own agent. The product limits stay in `CONSTRAINTS.md`. Look stays `DESIGN.md`. Do not edit those two files.

## Shared contract (`public.homes`)

Exactly 10,000 current-state rows. Telemetry streams as upserts onto these rows, not as one row per reading.

| Column | Type | Notes |
|---|---|---|
| `home_id` | text PK | `home-001` style, same as `new_fleet` |
| `zone` | text not null | `South` \| `North` \| `West` \| `Houston` (`ZONE_ORDER`) |
| `capacity_kwh` | numeric not null | `HOME_KWH` (20) |
| `soc_kwh` | numeric not null | truth after `discharge` |
| `max_kw` | numeric not null | `HOME_MAX_KW` (5) |
| `status` | text not null | `live` \| `stale` \| `dead` |
| `assigned_kw` | numeric not null default 0 | last tick’s `Allocation.per_home_kw`, 0 if idle |
| `last_seen` | timestamptz | latest accepted telemetry ingest, nullable until the feed writes |
| `charge_state` | text | `CHARGING` \| `DISCHARGING` \| `HOLDING` \| `FULL` \| `EMPTY`, nullable |
| `power_kw` | numeric | + discharge, − charge, nullable |
| `boot_id` | text | nullable |
| `last_seq` | int | nullable |
| `run_id` | text | last engine run that wrote the row |
| `tick` | int | last tick number |
| `updated_at` | timestamptz | `now()` on write |

Indexes: `zone`, `(zone, status)`, `updated_at`. Replica identity FULL (Realtime). Service role can upsert. The wall still never fetches 10k rows: `GET /v1/fleet/rollups` aggregates by `zone`; `GET /v1/homes` is paged.

## Shared rules

- Do not edit files outside your list. If you need a file you do not own, stop and name it.
- Do not add a dependency. PostgREST `send()` in `scripts/load_ercot_archive.py` is the writer.
- `allocate` stays pure. `discharge` is still the only place `soc_kwh` falls.
- The engine never imports Supabase during a tick (`docs/agents/persist-run.md`, `PROJECT_CONTEXT.md`).
- Fields on `Home`, `TickResult`, and `/v1` shapes are add-only. Do not rename or remove.
- Demo tape stays 100 homes / 0.40 MW. Live/archive 10k is `FLEET_SIZE`.
- `pytest -q` (and `npx vitest run` / `npx tsc --noEmit` when you touch `web/`) before you stop.
- Append one `docs/agents/progress.md` line. Update `docs/agents/code-flow.md` diagrams only if you add a module or a call.

## Prompt 1 — Schema and seed

```markdown
**[Enhancement] Add A 10k Homes Current-State Table And Seed**: Today Supabase only has `ercot_postings`, `ercot_prices`, and `runs`; `docs/agents/fleet-rollups.md` still says do not persist a homes table, and `new_fleet` writes at most `var/fleet/homes.json`. We need `public.homes` as exactly 10,000 current-state rows (upsert-heavy, ready for telemetry streaming), each assigned to an ERCOT load zone so the wall can group them. Own only `supabase/migrations/20260926_homes.sql`, `scripts/seed_homes.py`, and `tests/test_seed_homes.py`. Columns: `home_id` PK (`home-001` style), `zone` in South/North/West/Houston, `capacity_kwh`, `soc_kwh`, `max_kw`, `status` live|stale|dead, `assigned_kw` default 0, `last_seen`, `charge_state`, `power_kw`, `boot_id`, `last_seq`, `run_id`, `tick`, `updated_at`; indexes on `zone` and `(zone, status)`; replica identity FULL; no RLS that blocks the service role. Seed with the same `assign_zone` / 45–75% SOC rules as `new_fleet`; `--dry-run` builds 10k rows and sends nothing; missing config prints `homes_skipped: no_config` and exits 0. Research `server/engine/fleet.py`, `docs/agents/fleet-rollups.md`, `scripts/load_ercot_archive.py` `send()`, and `docs/agents/PROJECT_CONTEXT.md` before writing SQL.
```

## Prompt 2 — High-write upsert after a tick

```markdown
**[Enhancement] Batch-Upsert Discharged Homes Into public.homes**: After each tick, `discharge` lowers `soc_kwh` on live homes and `loop.py` writes only `var/fleet/rollups.json`; nothing copies the 10k current-state rows to Supabase, so SOC and zone are lost when the process exits. Add `scripts/persist_homes.py` that reads `var/fleet/homes.json` (list of `Home` dicts plus optional `assigned_kw`, `run_id`, `tick`) and batch-upserts `public.homes` on `home_id` with `Prefer: resolution=merge-duplicates`, same `send()` helper as `persist_run.py`. Own only `scripts/persist_homes.py` and `tests/test_persist_homes.py`. Use batches of 200–500 (rows are tiny vs 93 KB postings); `--dry-run` builds rows and sends nothing; missing keys print `homes_skipped: no_config` and exit 0; a failed POST prints `homes_skipped: <reason>` and exits 0. Do not import this module from `server/engine/`. Research `scripts/persist_run.py`, `scripts/load_ercot_archive.py` `send()`, `server/engine/fleet.py` `save_fleet`/`asdict(Home)`, and `docs/agents/persist-run.md` before writing.
```

## Prompt 3 — Engine snapshot after discharge

```markdown
**[Enhancement] Persist Fleet Truth After Discharge And Reload It**: `loop.run` calls `new_fleet(settings)` at the start of every run, then `allocate` (pure) and `discharge` (the only place `soc_kwh` falls); it writes rollups but never `save_fleet`, so the next process reseeds 45–75% and forgets who already discharged. After each tick’s `discharge`, write `var/fleet/homes.json` with current `soc_kwh`, `status`, `zone`, and `updated_at`, and on the next run load that file when its length matches `FLEET_SIZE` instead of reseeding. Own only `server/engine/loop.py`. Reuse `save_fleet` / `load_fleet` already in `fleet.py`; do not import Supabase, do not change `allocate` or `discharge`, and keep Demo at 100 homes when `FLEET_SIZE` is 100. Research `server/engine/loop.py` (the apply_events → allocate → discharge path), `server/engine/fleet.py` `new_fleet`/`save_fleet`/`load_fleet`/`discharge`, `server/engine/controller.py` `allocate`, and `docs/agents/epic-3-controller.md` before editing.
```

## Prompt 4 — API from the table, never 10k in one body

```markdown
**[Enhancement] Serve Paged Homes And Zone Rollups From Supabase**: `GET /v1/homes` still returns the three-row console fixture and `GET /v1/fleet/rollups` reads `var/fleet/` or reseeds in memory, so the frontend cannot show a persisted 10k fleet by load zone. Add a PostgREST reader that aggregates `public.homes` into the existing rollups shape (`n`, `zones.{South,North,West,Houston}` counts and MW, `clusters`) and pages `GET /v1/homes?zone=&status=&q=&limit=&offset=` (default limit 50, max 200) plus `GET /v1/homes/{home_id}`; keep the console Home JSON add-only (`zone` may be added). Own `server/api/homes.py` (new), the `get_homes` / `get_home` / `get_fleet_rollups` functions in `server/api/v1.py` only, and `tests/test_homes_api.py`. Missing Supabase config falls back to `current_rollups()` / fixtures, never 500. Research `server/api/v1.py`, `server/api/archive.py`, `server/engine/fleet.py` `fleet_rollups`/`current_rollups`, `docs/agents/plans/operator-console.md` Home contract, and `docs/agents/backend.md` before editing.
```

## Prompt 5 — Wall paints real LZ rollups

```markdown
**[Enhancement] Bind The Wall To Persisted Load-Zone Rollups**: The map, zone lens, and call caption still invent per-zone counts with `index % 4` over `fleetCells(tick)`, so a 10k fleet assigned by `assign_zone` will not match the dots or the ack bars. Read `GET /v1/fleet/rollups` and paint South/North/West/Houston from that body (`live`, `reserved`, `discharging`, `stale`, `dead`, `silent`, MW, `clusters`); keep `MAX_VISIBLE_POINTS` and never expand 10k DOM nodes. Own `web/src/api/rollups.ts` (new), `web/src/fleetAggregate.ts`, `web/src/zoneLens.ts`, `web/tests/fleetAggregate.test.ts`, and `web/tests/zoneLens.test.ts`. Leave `FleetPage`, `client.ts`, and Python alone; a missing rollups fetch keeps today’s `index % 4` fallback. Research `docs/agents/fleet-scale.md`, `docs/agents/fleet-rollups.md`, `web/src/fleetAggregate.ts`, `web/src/components/organisms/homeNodes.ts` `ZONE_ORDER`/`CLUSTER` centroids, and `web/src/contracts.ts` `FleetRollups` before editing.
```

## Prompt 6 — Fleet console pages by zone

```markdown
**[Enhancement] Page The Fleet List By Zone Instead Of Loading Every Home**: `/fleet` (`web/src/features/fleet/FleetPage.tsx`) renders every row from `createClient().homes()`, which today is three fixture homes and would freeze at 10k; there is no zone column, search, or windowed table. Point the list at paged `GET /v1/homes?zone=&status=&q=&limit=&offset=`, show `zone` and `soc_kwh`, keep a fixed-height window (no new dependency), and default the zone filter to the wall’s selected LZ when one is set. Own `web/src/api/client.ts` (`homes` query params only), `web/src/domain/types.ts` / `web/src/domain/parse.ts` add-only `zone` on Home, `web/src/features/fleet/**`, and the fleet tests under `web/tests/` that you add. Do not fetch the full 10k list; do not change the map. Research `docs/agents/fleet-scale.md` slice 5, `docs/agents/plans/operator-console.md` Home contract, `web/src/api/client.ts`, and `web/src/features/fleet/FleetPage.tsx` before editing.
```

## Prompt 7 — Telemetry last-reading upsert

```markdown
**[Enhancement] Stream Last Telemetry Onto The Same 10k Homes Rows**: `TelemetryState` holds `HomeState.last` (soc, power, charge_state, boot_id, seq, last_seen) in memory only; the spec says that lane reads no database, so a laptop restart loses stale/dead/suspect and the wall cannot show last-seen by zone. After a tick (or `--telemetry` run) write a `var/fleet/telemetry.json` snapshot of those last readings keyed by `home_id`, then `scripts/persist_telemetry.py` merge-upserts only the telemetry columns (`last_seen`, `charge_state`, `power_kw`, `boot_id`, `last_seq`, `soc_kwh` if reported) onto `public.homes` without inserting a history table. Own `scripts/persist_telemetry.py` and `tests/test_persist_telemetry.py` only; do not import Supabase from `server/engine/telemetry.py`. Missing config or a failed POST is `telemetry_skipped: <reason>`, exit 0. Research `docs/agents/telemetry-vpp.md` (HomeState, Reading, data_status), `server/engine/telemetry.py`, `scripts/persist_run.py`, and `server/engine/orchestration.py` `--telemetry` before writing.
```
