# One demo fleet of 100 homes

Replay, Live and Fleet all show the same demo fleet. Its size is the `FLEET_SIZE` setting, 100 by default.

Supabase still holds 10,000 seeded homes. We do not delete them. The app only reads the first 100 by home number (home-001 to home-100).

The Fleet page says where its homes come from. "Live fleet from Supabase: 100 of 100 homes" is the real table. "3 sample rows (no Supabase connection), not live data" means the app could not reach Supabase.

Each region has a "Split by county" button that groups its batteries by county.

Each home has one name and one region everywhere: the engine's. The name is region, county and number, for example Houston-FortBend-005. Supabase's own region column is older and differs for most homes, so the app ignores it for the 100 demo homes. Supabase itself is not changed.

Detail: `docs/agents/demo-fleet.md`.
