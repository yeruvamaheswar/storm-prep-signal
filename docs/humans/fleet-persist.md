# Persist the batteries

Supabase keeps 10,000 simulated homes, one row each, with a load zone so the wall can group them. The app uses only the demo fleet: the first 100 of them (`FLEET_SIZE`). Telemetry updates those same rows. The wall shows zone totals, not one dot per home.

The engine still decides charge on the laptop. Supabase is the copy, like the saved runs table. If Supabase is down, the demo still runs from the local files.

Why 100: `docs/humans/demo-fleet.md`. Copy-paste prompts for parallel agents: `docs/agents/plans/fleet-persist-prompts.md`.
