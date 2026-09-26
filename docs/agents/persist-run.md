# Persist engine runs into `public.runs`

**Decision (2026-09-26, later).** `python -m server.engine` copies the run to Supabase only when you pass `--persist`. Without it, a `--tape` run makes zero network calls. `scripts/live_cycle.py` still persists every cycle.

**Decision (2026-09-26).** After `loop.run()` writes `var/runs/<id>.json` (and `latest.json`), a best-effort script upserts that payload into `public.runs`. The wall still reads FastAPI / `latest.json` this pass. The engine never imports or waits on Supabase during a tick.

## Why

`public.runs` already exists and can still have 0 rows. The local run file stays the source of truth (`CONSTRAINTS.md`, "Engine output"). Supabase is a copy. A GET that returns `[]` is not a run; `load_latest_run` / `runFromTableRows` fall back to the snapshot file. Read gate: `docs/agents/backend.md`.

## Writers (research)

- `server/engine/loop.py` `write_run_files()` writes `{ run_id, tape, source, settings, ticks, totals }` after every tick (so live stays aligned) and once more if there are no ticks. `source` on that file is `live` or `scenario`.
- `server/engine/events.py` writes `var/logs/<run_id>.jsonl`. It is not the `runs` table.
- `python -m server.engine` is `server/engine/__main__.py`. `run_then_persist()` strips `--persist` with `parse_known_args`, calls `loop.main()` with the rest, then `persist_after_run()` only if the flag was given. A persist failure prints `runs_skipped: <reason>` and leaves the engine exit code at 0.
- Direct `run()` in tests does not upload.

## OpenAPI row

PostgREST `/runs` requires `run_id`, `created_at`, `source`, `result`. `created_at` has `now()`; we omit it so an upsert does not reset it. `result` is the ticks JSON. Other columns we fill:

| Column | Value |
|---|---|
| `source` | `live` \| `scenario` \| `fixture` (missing or unknown source → `fixture`) |
| `tape_label` | tape JSON `label`, or `synthetic`, or the run id for the layout file |
| `git_sha` | `git rev-parse HEAD`, omitted when git is missing |
| `ercot_posting_ids` | `ercot_postings.id` for NP3-233-CD postings the run used (tape `risk_fixture`s, or `var/signal/latest_np3.json` when `source` is `live`). Misses stay off the list. |
| `summary` | last-tick header metrics plus `tick_count` |
| `result` | `ticks` |

Upsert: `POST /rest/v1/runs?on_conflict=run_id` with `Prefer: resolution=merge-duplicates`, same helper as `scripts/load_ercot_archive.py` `send()`.

## Commands

```bash
python -m server.engine --tape tests/fixtures/tape_tiny.json             # local only, no network
python -m server.engine --tape tests/fixtures/tape_tiny.json --persist   # then upsert to runs
python scripts/persist_run.py                      # latest.json
python scripts/persist_run.py var/runs/<id>.json
python scripts/persist_run.py --dry-run            # build only
```

Needs `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in `server/.env`. Missing config prints `runs_skipped: no_config` and exits 0.
