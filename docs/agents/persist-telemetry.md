# Persist last telemetry onto `public.homes`

**Decision (2026-09-26).** After a tick (or `--telemetry` run) dumps last readings to `var/fleet/telemetry.json`, `scripts/persist_telemetry.py` merge-upserts only the telemetry columns onto the same `public.homes` rows. No history table. The engine never imports this module. A missing config or a failed POST prints `telemetry_skipped: <reason>` and exits 0.

## Why

`TelemetryState` holds `HomeState.last` in memory (`docs/agents/telemetry-vpp.md`). That lane reads no database. The local snapshot is the source; Supabase is the copy, same pattern as `persist_homes.py`. Table columns: `docs/agents/plans/fleet-persist-prompts.md`.

## Snapshot

Keyed by `home_id`. Each value is the last accepted reading: `last_seen` (ISO), `charge_state`, `power_kw`, `boot_id`, `last_seq`, and `soc_kwh` when reported. `write_snapshot(homes, path, as_of=, now_s=)` builds that file from `HomeState` objects and converts virtual-clock `last_seen` so data age is kept. Homes with no `last` are omitted.

## Writers

- `scripts/stream_telemetry.py` is the laptop writer for the 10k console fleet. It builds a synthetic last-reading snapshot (same `home_id`s as `seed_homes.py`), writes `var/fleet/telemetry.json`, and persist-upserts each pulse. The upsert stamps `zone` / `capacity_kwh` / `max_kw` / `status` from `new_fleet` so Postgres `NOT NULL` on the insert side of `ON CONFLICT` does not reject the row; `assigned_kw` is omitted. `--loop` repeats every 15 s. The mix is HOLDING-heavy, 5–8% silent, most live, some stale or dead; power sign is locked to `charge_state`. `orchestration.py` `--telemetry` still does not write this file.
- `scripts/persist_telemetry.py` `write_snapshot` is the other writer (from `HomeState`). The CLI reads the JSON and POSTs `home_id` plus telemetry columns only (`last_seen`, `charge_state`, `power_kw`, `boot_id`, `last_seq`, `soc_kwh` if present). Merge-duplicates leaves zone, capacity, status, and assigned_kw alone. `/fleet` reads `charge_state` and `power_kw` through `GET /v1/homes` (`docs/agents/fleet-telemetry.md`).
- Upsert: `POST /rest/v1/homes?on_conflict=home_id` with `Prefer: resolution=merge-duplicates`, same `send()` as `scripts/load_ercot_archive.py`. Batches are 400 rows.

## Commands

```bash
python scripts/stream_telemetry.py                            # one 10k pulse
python scripts/stream_telemetry.py --loop                     # every 15 s
python scripts/stream_telemetry.py --dry-run                  # count only
python scripts/persist_telemetry.py                           # var/fleet/telemetry.json
python scripts/persist_telemetry.py var/fleet/telemetry.json
python scripts/persist_telemetry.py --dry-run                 # build only
```

Needs `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in `server/.env`. Missing keys print `telemetry_skipped: no_config` and exit 0.
