# One demo fleet: FLEET_SIZE homes everywhere

**Decision (2026-09-27, Rajat: "do 100, keep it consistent").** Replay, Live and Fleet show one demo fleet of `FLEET_SIZE` homes (default 100). The live worker (`scripts/live_cycle.py`) allocates `settings["fleet_size"]`, not a fixed 10,000. `public.homes` keeps its 10,000 seeded rows (never deleted), but the API reads only the fleet's homes. A 10,000 figure elsewhere in `docs/agents/` describes the seed table, or a stress test or benchmark that really ran at 10,000, not the live fleet.

## Live worker

- `run_cycle` passes `settings` straight to `loop.run`, so `record.settings.fleet_size`, the tick's home counts and `var/fleet/homes.json` follow `FLEET_SIZE`.
- The call still scales with the fleet (`call_target_mw`, `scale_tick_to_fleet`): at 100 homes the 0.40 MW demo call stays 0.40 MW; the cap is `FLEET_SIZE × HOME_MAX_KW / 1000` (1.14 MW at 100 × 11.4 kW).
- `FLEET_SIZE=10000` still runs the 10k fleet (tests keep that case).

## Which rows are the fleet

- Seeded ids are `new_fleet` ids: `home-001` … `home-999`, `home-1000` … `home-10000` (checked read-only against Supabase on 2026-09-27). Sorting by text would put `home-1000` before `home-101`, so "the first 100" is `new_fleet(FLEET_SIZE)` ids, not `order=home_id&limit=100`.
- `server/api/homes.py` `fleet_filter(n)` adds `and=(home_id.in.(<ids>))` to the PostgREST query (its own key, so `home_id=eq.`/`ilike.` still work). Used by `list_homes`, `table_rollups`, `_discharging_mw` and `fleet_count`. `read_home` answers `None` (404) for an id outside the fleet, at any fleet size (`in_fleet` checks the id set in memory; no URL is built).
- Above `FLEET_FILTER_MAX_IDS` (1,000) no id filter is sent, because the URL would be too long (`fleet_scoped(n)` is false). Then nothing claims the fleet scope (fix 1, M2): `/v1/homes` rows are the whole table and the reply has no `X-Fleet-Size` or `X-Homes-Total`, so the Fleet page shows its plain `Live homes from the local API …` note; `table_rollups` raises `HomesUnavailable("fleet_unscoped")` and `GET /v1/fleet/rollups` serves `current_rollups()` (the engine's own `FLEET_SIZE` rollup) instead of counting the table. This holds at `FLEET_SIZE=10000` too.
- Snapshot counts already follow the run file's `settings.fleet_size`, which now is `FLEET_SIZE` for Live.

## Source headers on GET /v1/homes (add-only, body stays a list)

| Header | Value |
|---|---|
| `X-Homes-Source` | `supabase` (rows from `public.homes`) or `fixture` (the 3-row console sample when keys are missing or the read fails) |
| `X-Fleet-Size` | `FLEET_SIZE`. Omitted when the fleet is above `FLEET_FILTER_MAX_IDS` (the rows are not scoped to it) |
| `X-Homes-Total` | Fleet homes that have a row in `public.homes` (`Prefer: count=exact`). Supabase only; omitted if the count fails or the fleet is above `FLEET_FILTER_MAX_IDS` |

`server/app.py` exposes them to a cross-origin wall (`expose_headers`).

## Counties

- `public.homes` has no county column. Each `/v1/homes` row gets add-only `county` (FIPS) and `county_name` from `fleet.fleet_counties(n)`: the engine's own rule (`assign_county`, round-robin by place in the zone, as `scenario.seed_fleet` does), applied to the Supabase seed's zone order (see the known gap below). A row whose zone is not the zone the engine gave that id gets `null`, never a guess.
- `GET /v1/fleet/counties` returns the roster `[{zone, fips, name}]` (17 counties, `fleet.ZONE_COUNTIES`). The scenario state already carries `counties`.
- Known gap (corrected in Task 13 fix 1; Rajat's ruling: document it, no engine, settings or Supabase change). The split is the **engine** versus the **Supabase seed**, not scenario versus Live:
  - Engine, both Live and Replay: zones in `ZONES` order, default `Houston, North, South, West`. The Live worker uses `read_settings()` (`scripts/live_cycle.py:176`; default in `server/engine/cli.py:68-69`, same as `.env.example:41`), and `loop.run` builds the fleet with `new_fleet(settings)` (`server/engine/loop.py:96-101`, `335`). The scenario session also uses `read_settings()` (`scripts/scenario_session.py:56`), then `with_fleet_defaults` (`server/engine/scenario.py:274`; `loop._FLEET_DEFAULTS` zones are the same order, `server/engine/loop.py:65`) and `seed_fleet` -> `new_fleet(settings)` (`server/engine/scenario.py:211`, `334`).
  - Supabase seed: `scripts/seed_homes.py:47` calls `new_fleet(n)` with an int, which uses `seed_settings` (`server/engine/fleet.py:163-171`, `184`) and `ZONE_ORDER` `South, North, West, Houston` (`server/engine/fleet.py:17`). `fleet_counties(n)` and so `with_county` use that same seed order, which is why Live rows on the Fleet page get their counties.
  - Effect: per-zone and per-county counts agree (25 per zone at 100; 5/5/5/5/5 and 7/6/6/6). The zone of one id does not: `home-001` is South in `public.homes` (the Fleet page's Live source) and Houston in every engine output (Replay, and `/v1/live/orders`, which serves the engine's `var/fleet/tick_orders.json`). 75 of the first 100 ids differ (only ids 2, 6, 10, … are North in both).
  - Latent: `scripts/persist_homes.py` after a live cycle copies the engine's zones from `var/fleet/homes.json` into `public.homes` (`scripts/persist_homes.py:43`), rewriting those 75 zones; `with_county` would then give those rows a `null` county, because their zone no longer matches `fleet_counties(n)`. Nothing runs it automatically today. Aligning the orders (engine `ZONES` or a reseed) is a separate decision.

## Fleet page (`web/src/features/fleetgrid/`)

- Opens on Scenario when `GET /v1/scenario/state` answers and is not `worker_not_running`, else Live. A click before that check wins.
- Source note: `100-home demo fleet. Live fleet from Supabase: N of 100 homes.` or `3 sample rows (no Supabase connection), not live data.`; Scenario: `100-home demo fleet. Scenario: …`. The size comes from `X-Fleet-Size` or the scenario's home count, never a constant. When the page is full (`LIVE_LIMIT` 200 rows) and the fleet has more homes, the note says so: `… 500 of 500 homes, the first 200 shown.`
- Four regions, each titled `Houston · 25 homes · 5 counties`, with a `Split by county` toggle (`aria-pressed`). Split regions show one block per roster county, `Harris County (48201) · 5 homes`, including counties with 0 homes. The choice lives in `?split=Houston,North`.
