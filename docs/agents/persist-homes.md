# Persist fleet snapshot into `public.homes`

**Decision (2026-09-26).** After `save_fleet` writes `var/fleet/homes.json`, `scripts/persist_homes.py` batch-upserts that snapshot into `public.homes` on `home_id`. The engine never imports this module. A missing config or a failed POST prints `homes_skipped: <reason>` and exits 0.

## Why

`discharge` lowers `soc_kwh` on live homes. Local `var/fleet/homes.json` is the snapshot (`docs/agents/fleet-rollups.md`). Supabase is the copy, same pattern as `public.runs` (`docs/agents/persist-run.md`). Table columns: `docs/agents/plans/fleet-persist-prompts.md`. Telemetry columns stay for `persist_telemetry.py`.

## Writers

- `server/engine/fleet.py` `save_fleet` writes a JSON list of `asdict(Home)`.
- `scripts/persist_homes.py` reads that list, or a wrapper `{homes, assigned_kw, run_id, tick}`.
- Upsert: `POST /rest/v1/homes?on_conflict=home_id` with `Prefer: resolution=merge-duplicates`, same `send()` as `scripts/load_ercot_archive.py`. Batches are 400 rows (200–500 band; home rows are tiny vs 93 KB postings).

## Commands

```bash
python scripts/persist_homes.py                      # var/fleet/homes.json
python scripts/persist_homes.py var/fleet/homes.json
python scripts/persist_homes.py --dry-run            # build only
```

Needs `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in `server/.env`. Missing keys print `homes_skipped: no_config` and exit 0.
