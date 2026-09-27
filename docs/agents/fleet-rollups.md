# Fleet seed and rollups

The live fleet is `FLEET_SIZE` homes (default 100); see [demo-fleet.md](demo-fleet.md). The 10k figures below describe the seed table and the scale work.

**Decision.** `new_fleet` still takes the settings dict. It also takes an int `n`. `new_fleet(n)` uses `HOME_KWH=25`, `HOME_MAX_KW=11.4`, a 45–75% charge spread, status `live`, and round-robin zones `South, North, West, Houston` (the wall `ZONE_ORDER`). Persist is opt-in under `var/fleet/` (git-ignored). The wall never receives one row per home. `GET /v1/fleet/rollups` returns per-zone counts and MW. The wall (`web/src/api/rollups.ts`) reads that body and paints South/North/West/Houston from it; a missing fetch keeps `index % 4`. Each tick fills `TickResult.zone_delivered_mw`.

## Why

The main stub seeded `FLEET_SIZE=100` at a flat 0.6 SOC with `Home.zone=""`. The map still assigns zone by `index % 4` in `homeNodes.ts` / `fleetCells.ts`. Rajat's `assign_zone(index, zones)` on `origin/controller-rajat-dev` already round-robins by settings order. A 10k home list would freeze the wall (`docs/agents/fleet-scale.md`).

## API

`GET /v1/fleet/rollups` body:

```json
{
  "n": 10000,
  "zones": {
    "South": {
      "live": 2500, "reserved": 0, "discharging": 0,
      "stale": 0, "dead": 0, "silent": 0,
      "reserved_mw": 0.0, "discharging_mw": 0.0
    }
  },
  "clusters": [{"id": "South:0", "zone": "South", "lng": -98.475, "lat": 29.45}]
}
```

The engine writes the rollup with `orchestration.cycle_rollups(homes, cycle, policy)`, from the confirmed books, not the plan. `discharging` counts homes with confirmed kW booked this tick, and `discharging_mw` is that booked kW, so it adds up to `zone_delivered_mw`. A live home that was sent work but never heard back from goes in `silent`, not `live`. The wall reads `silent - stale` as unconfirmed, and these are the same homes `zone_acks` calls unconfirmed. So silent is stale plus unconfirmed. `fleet_rollups(homes, alloc, policy)` without `confirmed_kw` still counts the plan (used by `current_rollups` and tests). Reserved is every live home that is not discharging when `risk_level` is HIGH, same as the wall. `clusters` are the metro box centers from `homeNodes.ts`. `GET /v1/homes` stays on the small console fixtures. Do not point it at `var/fleet/homes.json`.

## Persist

- `new_fleet(n, persist=True)` writes `var/fleet/homes.json`.
- Only a live run (`loop.run(..., live=True)`: `--live` and `scripts/live_cycle.py`) carries SOC between runs. It loads that file (`<runs_dir>/../fleet/homes.json`) when `len(homes) == FLEET_SIZE` (a size mismatch reseeds) and writes it after every tick with current `soc_kwh`, `status`, `zone`, and `updated_at`. Demo stays 100 homes when `FLEET_SIZE` is 100.
- A `--tape` or synthetic run (`live=False`) starts from `new_fleet(settings)` and never reads or writes `homes.json`, so replaying the same tape twice in one folder gives the same totals (decided 2026-09-26, after PR #22 made replays start drained).
- Each engine tick writes `var/fleet/rollups.json` next to `var/runs/` (`<runs_dir>/../fleet/rollups.json`).
- The route prefers `rollups.json`, else computes from `homes.json`, else seeds `FLEET_SIZE` in memory.

`FLEET_SIZE` (default 100) is the one demo fleet for Demo, Live and archive ([demo-fleet.md](demo-fleet.md), 2026-09-27); the live worker no longer forces 10k. Live/archive allocate against `FLEET_SIZE * HOME_MAX_KW / 1000` as the fleet cap (1.14 MW at 100 × 11.4 kW; 114 MW only if `FLEET_SIZE=10000`) and a separate call target (`CALL_TARGET_MW` or `GET /v1/meta.call_target_mw`). Unset, the call is the 0.40 demo peak scaled by `FLEET_SIZE / 100` (0.40 MW at 100), never the fixture 0.40. Rollups ignore a saved `n` that does not match `FLEET_SIZE` and seed in memory. Do not persist a `homes` table.
