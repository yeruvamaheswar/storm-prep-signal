# One demo fleet: FLEET_SIZE homes everywhere

**Decision (2026-09-27, Rajat: "do 100, keep it consistent").** Replay, Live and Fleet show one demo fleet of `FLEET_SIZE` homes (default 100). The live worker (`scripts/live_cycle.py`) allocates `settings["fleet_size"]`, not a fixed 10,000. `public.homes` keeps its 10,000 seeded rows (never deleted), but the API reads only the fleet's homes. A 10,000 figure elsewhere in `docs/agents/` describes the seed table, or a stress test or benchmark that really ran at 10,000, not the live fleet.

## Live worker

- `run_cycle` passes `settings` straight to `loop.run`, so `record.settings.fleet_size`, the tick's home counts and `var/fleet/homes.json` follow `FLEET_SIZE`.
- The call still scales with the fleet (`call_target_mw`, `scale_tick_to_fleet`): at 100 homes the 0.40 MW demo call stays 0.40 MW; the cap is `FLEET_SIZE × HOME_MAX_KW / 1000` (1.14 MW at 100 × 11.4 kW).
- `FLEET_SIZE=10000` still runs the 10k fleet (tests keep that case).

## Which rows are the fleet

- Seeded ids are `new_fleet` ids: `home-001` … `home-999`, `home-1000` … `home-10000` (checked read-only against Supabase on 2026-09-27). Sorting by text would put `home-1000` before `home-101`, so "the first 100" is `new_fleet(FLEET_SIZE)` ids, not `order=home_id&limit=100`.
- `server/api/homes.py` `fleet_filter(n)` adds `and=(home_id.in.(<ids>))` to the PostgREST query (its own key, so `home_id=eq.`/`ilike.` still work). Used by `list_homes`, `table_rollups`, `_discharging_mw` and `fleet_count`. `read_home` answers `None` (404) for an id outside the fleet.
- Above `FLEET_FILTER_MAX_IDS` (1,000) no id filter is sent, because the URL would be too long. That is only right when the whole table is the fleet (FLEET_SIZE=10000).
- Snapshot counts already follow the run file's `settings.fleet_size`, which now is `FLEET_SIZE` for Live.

## Source headers on GET /v1/homes (add-only, body stays a list)

| Header | Value |
|---|---|
| `X-Homes-Source` | `supabase` (rows from `public.homes`) or `fixture` (the 3-row console sample when keys are missing or the read fails) |
| `X-Fleet-Size` | `FLEET_SIZE` |
| `X-Homes-Total` | Fleet homes that have a row in `public.homes` (`Prefer: count=exact`). Supabase only; omitted if the count fails |

`server/app.py` exposes them to a cross-origin wall (`expose_headers`).

## Counties

- `public.homes` has no county column. Each `/v1/homes` row gets add-only `county` (FIPS) and `county_name` from `fleet.fleet_counties(n)`: the engine's own rule (`assign_county`, round-robin by place in the zone, as `scenario.seed_fleet` does). A row whose zone is not the zone the engine gave that id gets `null`, never a guess.
- `GET /v1/fleet/counties` returns the roster `[{zone, fips, name}]` (17 counties, `fleet.ZONE_COUNTIES`). The scenario state already carries `counties`.
- Known gap: the scenario session orders zones `Houston, North, South, West` (`loop._FLEET_DEFAULTS`), the live fleet and the seed `South, North, West, Houston` (`seed_settings`). So `home-001` is Houston in a scenario and South in Live. Counts per zone and county match (25 per zone; 5/5/5/5/5 and 7/6/6/6), the ids do not.

## Fleet page (`web/src/features/fleetgrid/`)

- Opens on Scenario when `GET /v1/scenario/state` answers and is not `worker_not_running`, else Live. A click before that check wins.
- Source note: `100-home demo fleet. Live fleet from Supabase: N of 100 homes.` or `3 sample rows (no Supabase connection), not live data.`; Scenario: `100-home demo fleet. Scenario: …`. The size comes from `X-Fleet-Size` or the scenario's home count, never a constant.
- Four regions, each titled `Houston · 25 homes · 5 counties`, with a `Split by county` toggle (`aria-pressed`). Split regions show one block per roster county, `Harris County (48201) · 5 homes`, including counties with 0 homes. The choice lives in `?split=Houston,North`.
