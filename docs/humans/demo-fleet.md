# One demo fleet of 100 homes

Replay, Live and Fleet all show the same demo fleet. Its size is the `FLEET_SIZE` setting, 100 by default.

Supabase still holds 10,000 seeded homes. We do not delete them. The app only reads the first 100 by home number (home-001 to home-100).

The Fleet page says where its homes come from. "Live fleet from Supabase: 100 of 100 homes" is the real table. "3 sample rows (no Supabase connection), not live data" means the app could not reach Supabase.

Each region has a "Split by county" button that groups its batteries by county.

Detail: `docs/agents/demo-fleet.md`.
