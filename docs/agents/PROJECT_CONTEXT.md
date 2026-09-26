# ReserveGate: project context for Cursor agents

Read this before changing anything. It explains why this repo exists, what "done" means this weekend, and the rules that are not negotiable.

## Why we are building this
- Built for the **Base Power x AITX Talent Hackathon** (Sep 25-27 2026, Base Power HQ, Austin). It is a hiring event: Base engineers judge the code and the demo.
- Base Power runs a fleet of home batteries that helps balance the Texas (ERCOT) grid. Its hard problem is using that fleet for the grid **without leaving homeowners short of power when a storm hits**.
- Our goal is to show **engineering judgment under failure**, not a flashy demo. The judges should see that the system stays safe when data is missing, late, or wrong.
- Tracks: **Open Grid Data** (real ERCOT data made useful) and **Orchestration** (coordinating many independent units, and staying resilient when parts fail).
- Guide wording: "real, working systems, not slide decks or simple API wrappers."

## What it does (one paragraph)
ReserveGate runs 5-minute ticks over a tape (synthetic or replayed). Each tick it splits a grid dispatch target across **100 simulated homes** (25 in each of ERCOT's 4 load zones) and **never discharges a home below its reserve floor**. A storm rule reads ERCOT report **NP3-233-CD** and compares it against a lead-matched baseline plus 15%. If risk is HIGH, **or the reading is missing**, the floor rises from 30% to 60%. Missing data is treated as risk, never as "all clear."

Team line: **"We may miss the target; we never break a reserve."**

## Design principles (do not violate)
1. **Rules decide battery actions.** No LLM chooses dispatch. An LLM may only write the human-readable receipt/explanation sentence from structured facts. Never describe this as an "AI VPP."
2. **Fail safe.** Missing, stale, or malformed input means a higher floor plus a logged reason, never a crash and never a lower floor.
3. **Every decision has a reason.** Each tick records the floor, why it was chosen, and the input it came from.
4. **The run file is the source of truth.** `var/runs/<id>.json` and `latest.json`. Everything else (Supabase, UI) is a copy or a view.
5. **Online is fine, never required.** The demo may use Wi-Fi (live ERCOT data, Supabase history). If the network or Supabase fails, `demo.sh` falls back to the local tape or replay and still finishes, logging why. Top teams present live on a laptop, on venue Wi-Fi.
6. **Tracer bullets.** Build a thin end-to-end slice first, then harden it. Research, then plan, then implement. Keep changes small and reviewable. Do not build past the 48-hour MVP.
7. **Beginner-readable.** The team must be able to explain every file. Prefer plain code over clever code, few dependencies, and clear names.

## Layout
- `server/engine/`: the core engine. `loop.py` (tick loop), `policy.py` (floor rules), `risk.py` (storm risk from NP3-233-CD), `signal.py`, `contracts.py` (data shapes), `cli.py`, `__main__.py`. Run with `python3 -m server.engine`.
- `server/api/`: FastAPI routes for the web UI. Sample data must be labeled "sample."
- `scripts/`: one-off tools, e.g. `replay_event.py` (Beryl/Heather replays), `load_ercot_archive.py` (loads the saved NP3-233-CD zips into Supabase), `load_ercot_reports.py` (pulls ERCOT reports from the public API into Supabase), `build_tape.py` (exports a storm replay tape from Supabase). How they connect: `docs/agents/code-flow.md`.
- `data/events/<event>/`: downloaded ERCOT archives (raw zips are gitignored).
- `tapes/`: tapes the engine replays (e.g. `demo.json`).
- `tests/`: pytest. Run with `python3 -m pytest -q`. All tests must stay green.

## Supabase (optional history, never required)
- Tables:
  - `ercot_postings`: one row per ERCOT posting, unique on report + posted_at. Holds NP3-233-CD (saved zips and API) plus the load forecast (NP3-565-CD) and wind and solar reports (NP4-732, 733, 737, 738-CD).
  - `ercot_prices`: NP6-905-CD load-zone prices, one row per zone per 15-minute interval, unique on settlement_point + interval_ending.
  - `runs`: a copy of each run's result. `scripts/persist_run.py` upserts it after `loop.run()` writes the local file. The table can still be empty. Empty is not a run: `GET /v1/runs/latest` keeps `var/runs/latest.json` (then `layout-run.json`). Do not treat PostgREST `[]` as source of truth. Write: `docs/agents/persist-run.md`. Read gate: `docs/agents/backend.md`.
- Demo/Synthetic reads `ercot_postings` and `ercot_prices` from `server/api/archive.py` (one posting and one interval at the tape clock). Live reads the newest `event=live` row after `scripts/live_cycle.py` upserts it; direct ERCOT is the fallback. `GET /v1/feeds` reads the latest posting per report for history chips and overlays `var/signal/` quality. `check_margin.py` still reads every posting for research. A missing Supabase config is fail-safe, not a live ERCOT pull. The engine **never** imports these tables. A tape reset must not truncate them. Detail: `docs/agents/live-ingest.md`, `docs/agents/archive-feeds.md` and `docs/agents/feeds-proxy.md`.
- `scripts/build_tape.py` reads NP3-233-CD postings and NP6-905-CD prices to write `tapes/heather.json`, `data/fixtures/heather/`, and the pre-storm baseline.
- The engine **never imports or waits on** Supabase during a run. Uploads are best effort: they print `..._skipped: <reason>` and exit 0 on failure.
- Keys live in `server/.env` or the process env (`SUPABASE_URL`, `SUPABASE_SECRET_KEY`). `server/env.py` loads that file, then leaves process env in place. Never print, log, commit, or hardcode keys. Keep `.env.example` updated with names only. Do not put them in Vite.

## Ownership
- **Uma:** engine, policy, contracts, and all merges into `main`.
- **Rajat:** fleet, controller, score (files go in `server/engine/`).
- **Sunny:** tape, brief, web, `server/api/`, `render.yaml`, `demo.sh`, README.
- **Only Uma merges into `main`. No direct pushes.** Work on a branch and open a PR.

## Rules for agents
- Stay inside the files the task names. Ask before touching another owner's area.
- Do not add dependencies without saying why. The only network calls in `server/engine/` are the ERCOT fetches in `signal.py` (`--live`): NP3-233-CD outages and NP6-905-CD LZ_NORTH price. Do not add others, and the engine never calls Supabase.
- Add or update a test for every behavior change, and run the full test suite before finishing.
- Update `docs/agents/progress.md` with what changed and why.
- Proven findings go in the README; do not invent numbers. Example: in the Hurricane Beryl replay, statewide outages peaked at 22,389 MW, 5% under the 23,653 MW grid-wide trigger, while Houston roughly doubled. That is why the storm rule works per zone.
- If a request conflicts with this file or `CONSTRAINTS.md`, stop and say so instead of guessing.

## Deadlines
- Sat 9 PM: feature freeze. Sun 9:30 AM: code freeze. Sun 10:30 AM: submit (the hard deadline is 11:00 AM CT).
- Judged on a ~4:30 demo video plus the codebase. Scoring: technical 30, track fit 30, value 20, innovation 20.
