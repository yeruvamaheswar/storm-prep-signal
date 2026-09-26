# Fleet counts, not 10,000 homes

The wall reads zone totals. It does not load one row per home.

`GET /v1/fleet/rollups` is that list: how many homes in South, North, West, and Houston are live, reserved, discharging, stale, dead, or silent, plus megawatts reserved versus discharging. The map, zone lens, and ack bars paint from that list. If the fetch is down they keep the old even split. The header tiles still follow the live tick, so a 100-home run still shows 0.40 MW even when the map reads 10,000.

Seeding a large fleet is optional and stays on disk under `var/fleet/`. After each tick the engine also writes that file so the next run keeps the charge that already left, instead of reseeding 45–75%. The demo tape still uses 100 homes and a 0.40 MW call. Live and archive use the real fleet size: 10,000 homes cap at 50 MW, and the call is a separate setting, not 0.40. Detail: `docs/agents/fleet-rollups.md`.
