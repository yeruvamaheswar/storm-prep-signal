# Fleet counts, not 10,000 homes

The wall reads zone totals. It does not load one row per home.

`GET /v1/fleet/rollups` is that list: how many homes in South, North, West, and Houston are live, reserved, discharging, stale, dead, or silent, plus megawatts reserved versus discharging.

Seeding a large fleet is optional and stays on disk under `var/fleet/`. The demo tape still uses 100 homes and a 0.40 MW call. Live and archive use the real fleet size: 10,000 homes cap at 50 MW, and the call is a separate setting, not 0.40. Detail: `docs/agents/fleet-rollups.md`.
