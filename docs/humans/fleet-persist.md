# Persist 10k batteries

We will keep 10,000 simulated homes in Supabase, one row each, with a load zone so the wall can group them. Telemetry will update those same rows. The wall still shows zone totals, not 10,000 dots.

The engine still decides charge on the laptop. Supabase is the copy, like the saved runs table. If Supabase is down, the demo still runs from the local files.

Copy-paste prompts for parallel agents: `docs/agents/plans/fleet-persist-prompts.md`.
