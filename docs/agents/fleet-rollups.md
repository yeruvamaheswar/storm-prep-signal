# 10k fleet seed and rollups

**Decision.** `new_fleet` still takes the settings dict. It also takes an int `n`. `new_fleet(n)` uses `HOME_KWH=20`, `HOME_MAX_KW=5`, a 45–75% charge spread, status `live`, and round-robin zones `South, North, West, Houston` (the wall `ZONE_ORDER`). Persist is opt-in under `var/fleet/` (git-ignored). The wall never receives one row per home. `GET /v1/fleet/rollups` returns per-zone counts and MW. Each tick fills `TickResult.zone_delivered_mw`.

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

Silent is stale (this fleet has no unconfirmed). Reserved is every live home that is not discharging when `risk_level` is HIGH, same as the wall. `clusters` are the metro box centers from `homeNodes.ts`. `GET /v1/homes` stays on the small console fixtures. Do not point it at `var/fleet/homes.json`.

## Persist

- `new_fleet(n, persist=True)` writes `var/fleet/homes.json`.
- Each engine tick writes `var/fleet/rollups.json` next to `var/runs/` (`<runs_dir>/../fleet/rollups.json`).
- The route prefers `rollups.json`, else computes from `homes.json`, else seeds `FLEET_SIZE` in memory.

`FLEET_SIZE` stays 100 for the Demo tape (0.40 MW peak). Live/archive allocate against `FLEET_SIZE * HOME_MAX_KW / 1000` as the fleet cap (10k × 5 kW = 50 MW) and a separate call target (`CALL_TARGET_MW` or `GET /v1/meta.call_target_mw`). Unset, the call is the 0.40 demo peak scaled by `FLEET_SIZE / 100` (40 MW at 10k), never the fixture 0.40. Rollups ignore a saved `n` that does not match `FLEET_SIZE` and seed in memory. Do not persist a `homes` table.
