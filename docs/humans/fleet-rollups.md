# Fleet counts, not one row per home

The wall reads zone totals. It does not load one row per home.

`GET /v1/fleet/rollups` is that list: how many homes in South, North, West, and Houston are live, reserved, discharging, stale, dead, or silent, plus megawatts reserved versus discharging. The map, zone lens, and ack bars paint from that list. If the fetch is down they keep the old even split. The header tiles follow the live tick. The map and the tiles count the same 100 fleet homes. Their per-zone discharge numbers can still differ: the map reads zone totals from Supabase when it can, and the tiles read the engine's tick.

Seeding a large fleet is optional and stays on disk under `var/fleet/`. A Live run saves that file once when it ends, so the next Live run keeps the charge that already left instead of reseeding 45–75%. A tape replay always starts fresh and never touches the file, so the same tape gives the same numbers every time. The demo tape and Live both use the 100-home demo fleet (`FLEET_SIZE`) and a 0.40 MW call unless `CALL_TARGET_MW` is set. See `docs/humans/demo-fleet.md`. Detail: `docs/agents/fleet-rollups.md`.
