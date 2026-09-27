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

## One zone and one name per home: the engine's

**Decision (2026-09-27, Rajat, Task 17): engine zone everywhere.** Every screen shows a home in the zone the engine gives it and by the engine's name, `Zone-County-Number` (`fleet.home_label`, e.g. `Houston-FortBend-005`). This supersedes the Task 13 ruling that only documented the seed-versus-engine mismatch.

- The engine (Live worker and Replay's scenario session) orders zones by `ZONES`, default `Houston, North, South, West` (`server/engine/cli.py` `read_settings`; `loop._FLEET_DEFAULTS` for the scenario). `assign_zone` deals ids round-robin over that order and `assign_county` deals each zone's homes over its roster counties (`fleet.fleet_counties`, the same rule as `scenario.seed_fleet`).
- `public.homes` was seeded with `new_fleet(n)` on `seed_settings` (`ZONE_ORDER` `South, North, West, Houston`), so its `zone` column disagrees with the engine for 75 of the first 100 ids. **The table is never rewritten.** Only what the API reports changes.
- `server/api/homes.py` (demo fleet, `FLEET_SIZE <= FLEET_FILTER_MAX_IDS`): `engine_homes(n)` builds `{home_id: {zone, county, county_name, name}}` from `fleet_counties` over the engine's zone order (`engine_zones()`: `ZONES` parsed as `cli.read_settings` does, else `loop._FLEET_DEFAULTS`; it does not call `read_settings()`, whose `load_dotenv()` would load the repo-root `.env` into the API). `as_fleet_home` gives every `/v1/homes` and `/v1/homes/{id}` row the engine `zone` (set before the floor is read, so a per-zone floor applies to the engine zone), add-only `county`, `county_name` and `name`.
- Filters and rollups follow the same assignment: `?zone=` and each zone in `table_rollups` / `_discharging_mw` send `and=(home_id.in.(<that engine zone's ids>))` instead of `zone=eq.`.
- Above `FLEET_FILTER_MAX_IDS` (non-default sizes) nothing changed: rows keep the table's `zone`, `with_county` still derives the county on the seed order (null when the row's zone disagrees), no `name`, and rollups fall back to `current_rollups()`.
- `GET /v1/fleet/counties` returns the roster `[{zone, fips, name}]` (17 counties, `fleet.ZONE_COUNTIES`). The scenario state already carries `counties`.
- `scripts/persist_homes.py` (not run automatically) copies engine zones into `public.homes`; the API reports the same engine zone either way.
- Tests: `tests/test_home_names.py` (a demo id has the same zone, county and name from `/v1/homes` as from the scenario state; the same zone as the live engine's `new_fleet`).

### Web: `homeName` (`web/src/features/replay/homeName.ts`)

- `homeName(home)` returns the row's `name`; else builds `{zone}-{county name without spaces}-{the id's last "-" part}` from `zone` and `county_name` (or the Fleet grid's `countyName`); else the raw id. A bare FIPS is not used (the engine prints the county name for a roster county). `homeNameById(homes, id)` names another home, or keeps its id.
- Used for every visible or aria name: the "What happened" feed (`narrate.ts`), zone-board lot aria labels and story tags (`zoneModel.lotLook().name`/`aria`), the home panel title, "Also took over …", "Taken over from …" and "Its order was handed to …" (`HomePanel`, `journeySteps(…, nameOf)`), Fleet grid cell tooltips (`title`), aria labels and the detail title, and the Fleet table (`/fleet/table`) row buttons, home page title and a single-home range. A range of many homes keeps its row numbers (`Homes 1–50`). A Fleet grid cell still prints only the number (`005`), the name's last part, because the 36 px cell has no room; its tooltip and aria label carry the full name.
- Open: `/fleet/table` reads homes through `web/src/domain/parse.ts` `parseHome`, which keeps neither `name` nor `county_name`, so that page shows raw ids until `parseHome` passes them through (add-only). Replay's zone panel feed (`ZonePanel.tsx`) passes no homes to `feedLines`, and `ReplayPage.tsx` does not pass `homes` to `HomePanel`, so those spots keep raw ids until they do.
- `data-home`, `?home=`, search and keys stay on the raw `home_id`. The ledger names no home.

## Fleet page (`web/src/features/fleetgrid/`)

- Opens on Scenario when `GET /v1/scenario/state` answers and is not `worker_not_running`, else Live. A click before that check wins.
- Source note: `100-home demo fleet. Live fleet from Supabase: N of 100 homes.` or `3 sample rows (no Supabase connection), not live data.`; Scenario: `100-home demo fleet. Scenario: …`. The size comes from `X-Fleet-Size` or the scenario's home count, never a constant. When the page is full (`LIVE_LIMIT` 200 rows) and the fleet has more homes, the note says so: `… 500 of 500 homes, the first 200 shown.`
- Four regions, each titled `Houston · 25 homes · 5 counties`, with a `Split by county` toggle (`aria-pressed`). Split regions show one block per roster county, `Harris County (48201) · 5 homes`, including counties with 0 homes. The choice lives in `?split=Houston,North`.
