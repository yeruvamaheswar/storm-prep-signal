Storm Prep signal notes (risk rule v2). Still current for the risk rule and event schema; the ReserveGate plan is docs/agents/plan-of-attack.md.

# Progress

## 2026-09-25: Slice 0, research and plan (no application code)

- Wrote `docs/research.md`. It covers NP3-233-CD access, auth (id_token as a Bearer token,
  plus the `Ocp-Apim-Subscription-Key` header), the endpoint and its parameters, the 15
  response fields, the hour to rate, the posted time, and a real trimmed sample.
- Verified with one read-only live call using the `.env` credentials. The token and data
  calls returned 200, and a request without a token returned 401. The call came from a
  throwaway script in `/tmp`, which was deleted. No secrets were printed.
- Key facts:
  - There is **no total field**. The total is the sum of 12 per-zone MW fields.
  - Today's total is about 19,500 MW, so `RISK_THRESHOLD_MW=5000` would always rate HIGH.
- Wrote `docs/plan.md`: slices 0–6 plus V, the function names, the event schema, and a
  mermaid data-flow diagram. Status: DRAFT, waiting for approval.
- `.gitignore` and `.env.example` were already correct from setup and were left unchanged.
- Not verified: the narrower single-hour query (not needed; the plan uses the verified query).
- Next: the owner answers the 5 open questions in `docs/plan.md` and approves the plan.
  Then Slice 1 (the fixture happy path) can start.

## 2026-09-25: Slice 0, owner decisions recorded (docs only)

- Decided:
  - The total is Resource + IRR + NewEquip across the 4 zones, and the driving zone is the
    zone with the largest sum.
  - We rate the current hour from the newest posting.
  - Python is 3.13 (`AGENTS.md` updated from 3.11).
  - `JEV_API_KEY` is optional and never required (marked in `.env.example`).
- Approved: the A/R/S rules (R = exactly one more fetch + validate; S = keep RESERVE and end;
  no answer = stay RESERVE, exit 2), the 90-minute staleness limit, and the fixture clock
  pinned to the posted time. The owner called the A/R/S section "Slice 3"; it is in
  plan Slice 2.
- Added to the plan: `RISK_THRESHOLD_MW` is always read from config and the code has no
  built-in value. If it is missing or not a number, the run fails safe.
- Still open: the threshold approach (on hold, the owner will send it).
- Next: wait for the threshold approach. Slice 1 has not started.

## 2026-09-25: Slice 1 decisions recorded, step 0 fixture check (no app code)

- Updated `docs/plan.md`, `AGENTS.md`, `docs/research.md` and `.env.example`:
  - The risk rule is now a relative trigger: `compute_risk(signal, margin_pct=20, lookahead_hours=6)`.
  - `RISK_MARGIN_PCT` and `LOOKAHEAD_HOURS` replace `RISK_THRESHOLD_MW` (removed).
  - Also recorded: the decision line, the validation reasons, auth, and the no-secrets-in-logs test.
- Saved the real response to `tests/fixtures/np3_233_cd.json`. It is one posting
  (`2026-09-25T12:00:47`) with 192 rows. It contains only the JSON body, and a self-check
  found no secret substrings.
- Branch A was chosen under both readings of "hours 1–168". Which 168 rows to use for the
  baseline is open for the owner. The numbers are in `docs/plan.md`.
- Fixture result: peak 22,194 MW at HE15, driving zone North, level LOW (margin about −400 MW).
- Next: the owner picks the baseline rows. Slice 1 has not started.

## 2026-09-25: Third-round decisions recorded (docs only)

- Baseline = the median `hour_total` from the current hour through the end of the posting.
  Validation needs at least 48 rows from the current hour on. On the real fixture that is
  179 rows: baseline 18,623 MW, trigger 22,347.6 MW, peak 22,194 MW at HE15, risk LOW.
- New slice order:
  - 1: fixture tracer bullet, plus the synthetic spike fixture that must rate HIGH.
  - 2: live fetch and auth, plus the no-secrets test.
  - 3: `validate`, `fail_safe`, A/R/S, and `--simulate`.
- Approved: the `current hour not in report` reason.
- Added `format_decision` to the `AGENTS.md` names.
- The agent proposed three things that the owner should confirm:
  - A small pure helper `to_signal`, because Slice 1 has no `validate`.
  - Pinning the clock for `--file` as well as `--fixture`.
  - A minimal `fail_safe` in Slice 2, so live errors go to RESERVE.
- Next: owner confirmation. Slice 1 has not started.

## 2026-09-25: Slice 1 done, fixture tracer bullet (not committed)

- Built the `storm_prep` package:
  - `signal.py`: `load_signal` and `to_signal`.
  - `risk.py`: `compute_risk`, `RiskResult` and a simple `decide_mode`.
  - `batteries.py`: `apply_to_batteries`.
  - `decision.py`: `format_decision`.
  - `events.py`: `log_event`, writing `var/logs/<run_id>.jsonl`.
  - `__main__.py`: the CLI, with `--fixture` and `--file`.
  - Also added `pytest.ini`.
- Added `tests/fixtures/np3_spike_synthetic.json`: the real fixture plus 500 MW on
  `totalResourceMWZoneHouston` at 2026-09-25 HE16 (2745 → 3245), labeled in `_note`.
- `pytest -q`: 6 passed. The tests cover:
  - The `>=` boundary (HIGH), 1 MW below (LOW), and a peak at hour 6 of the window.
  - The real fixture gives the same line on every run and gets one log file per run.
  - The synthetic spike gives HIGH and RESERVE.
  - Every stage is logged.
- A mutation check (`>` instead of `>=`) makes the boundary test fail, as it should.
- Real fixture line: `[NORMAL] risk LOW | peak outages 22,194 MW at HE15 ... (-154 MW; week median 18,623 MW +20%) | driving zone: North 9,429 MW | ... | clock: pinned to posting | quality: unchecked | source: fixture`.
- Synthetic line: `[RESERVE] risk HIGH | peak outages 22,539 MW at HE16 ... (+191 MW; ...) | driving zone: North 9,294 MW | ... | source: fixture (synthetic)`.
- Choices made during the slice:
  - The line says `quality: unchecked` until `validate()` exists (Slice 3), so it doesn't
    claim checks that never ran.
  - `run_id` now includes microseconds. Two runs in the same second had shared one log
    file; this was found and fixed during the slice.
  - `decide_mode(risk)` takes no state yet (Slice 5 adds it).
- Size: 273 lines of app code (including docstrings and comments) plus 86 lines of tests.
  That is slightly over the ~250 budget.
- Next: Slice 2 (live fetch, auth, minimal `fail_safe`, no-secrets test). Not started.

## 2026-09-25: Slice 1b done, risk rule v2 (not committed)

- Why: rule v1 compared the next 6 h with the median of the rest of the posting. Scheduled
  outages shrink with lead time, so that median was structurally low, and v1 rated HIGH on
  666 of 755 real postings (Aug 25-Sep 25 2026).
- Rule v2: each window hour is compared with the typical total at the same lead time across
  past postings. The hour with the largest ratio is the peak, and `peak_lead` was added to
  `RiskResult` (added, nothing renamed).
- New files:
  - `data/baseline_by_lead.json`: 755 postings, medians for leads 0-5. Committed on purpose.
  - `scripts/make_baseline.py <csv_folder>`: rebuilds that file from MIS CSVs (stdlib only).
  - `storm_prep/baseline.py`: `load_baseline` (named errors when the file is missing or too
    short) and `baseline_span`.
- `compute_risk(signal, baseline, margin_pct=15, lookahead_hours=6)`. `run()` logs a new
  `load_baseline` stage. The decision line now says `typical for +N h ahead ... over Aug 25-Sep 25 postings`.
- `RISK_MARGIN_PCT` default is now 15. The 15% was calibrated on Aug 25-Sep 25 2026 data
  (1.7% out-of-sample HIGH rate). It is **unvalidated against real stress events**: Winter
  Storm Uri (Feb 2021) and Elliott (Dec 2022) were not tested.
- The synthetic spike is now +1500 MW (2745 -> 4245 at Houston HE16), because +500 MW no
  longer crosses the v2 trigger.
- `pytest -q`: 9 passed. A mutation check (`>` instead of `>=`) failed both boundary tests.
  `make_baseline.py` was smoke-tested on three hand-made CSVs, not on the real 755 files.
- Real fixture line: `[NORMAL] risk LOW | peak outages 22,194 MW at HE15 (next 6 h) vs trigger 23,304 MW (-1,110 MW; typical for +2 h ahead 20,264 MW over Aug 25-Sep 25 postings +15%) | ...`.
- The owner's local `.env` still had `RISK_MARGIN_PCT=20`. The agent did not edit `.env`.
- Next: Slice 2 (live fetch). Not started.

## 2026-09-25: Slice 1b committed, `policy.py` added, sim settings loaded

- Slice 1b (risk rule v2) was committed as `489905f`.
- `storm_prep/policy.py`: `reserve_policy(risk, settings) -> Policy` (commit `f4b3420`).
  HIGH gives `storm_reserve_pct`, LOW gives `base_reserve_pct`, and None gives
  `storm_reserve_pct` with reason `signal_unavailable`. Pure function. `tests/test_policy.py`
  has 3 tests. `pytest -q`: 12 passed.
- `read_settings()` now also loads the 8 simulation settings from `.env.example` as lowercase
  keys (`fleet_size`, `home_kwh`, `home_max_kw`, `home_start_soc_min_pct`,
  `home_start_soc_max_pct`, `base_reserve_pct`, `storm_reserve_pct`, `tick_minutes`), with the
  `.env.example` values as defaults. `run()` passes only `margin_pct` and `lookahead_hours` to
  `compute_risk` and `format_decision`, because those functions reject extra keys.
- New test: `read_settings()` gives `base_reserve_pct` 30 and `storm_reserve_pct` 60 when `.env`
  doesn't set them. `pytest -q`: 13 passed.

## 2026-09-25: Per-zone reserve floors from weather alerts

- `reserve_policy(risk, settings, alerted=None)`. `alerted` maps zone name to the alert's
  event name. `reserve_pct`, `reason` and `risk_level` are unchanged.
- When `settings["zones"]` exists, every zone gets `zone_reserve_pct` and `zone_reasons`, in
  this order: risk None gives storm floor `signal_unavailable`; HIGH gives storm floor
  `storm_risk_high`; zone in `alerted` gives storm floor `weather_alert`; else base `normal`.
- `engine.py` still calls it without `alerted`, so zones follow the fleet floor until alerts
  are wired in. `CONSTRAINTS.md` still shows the old 2-argument signature.
- 4 new tests in `tests/test_policy.py`. `pytest -q`: 18 passed.

## 2026-09-25: Slice 2 done, live ERCOT fetch

- `signal.fetch_outages(settings, now)`: POST for an `id_token` (credentials in the form
  body), then GET NP3-233-CD with `postedDatetimeFrom=<now - 2 h>&size=400`, the Bearer token
  and `Ocp-Apim-Subscription-Key`. Timeout per call is `FETCH_TIMEOUT_S` (3 s; the owner
  chose 3 over the 10 s first asked for). Credentials are read from the environment, never
  put in `settings`. Every failure becomes `SignalUnavailable` with a short, secret-free reason.
- The raw body is saved to `var/signal/latest_np3.json` (git-ignored). Replay it with
  `python -m storm_prep --file var/signal/latest_np3.json`. The replay says `source: fixture`.
- `python -m storm_prep --live`. Any live failure (network, login, JSON, missing hour) logs
  `compute_risk`/`failed`, treats risk as None, sets batteries to RESERVE and prints
  `[RESERVE] risk unknown | <reason> | reserve floor 60% (signal_unavailable) | source: ERCOT NP3-233-CD`.
  Exit code stays 0. This replaces plan.md's "minimal fail_safe, exit 2" (fail_safe moved into
  `policy.py` per plan-of-attack). File modes are unchanged.
- `tests/test_signal.py` (network faked): good response gives 192 parsed rows and correct
  headers; live run rates LOW; timeout gives risk None and the 60% floor; no secret or token
  in logs, screen or saved file. `pytest -q`: 22 passed.
- One real run, 22:40 CT: `[NORMAL] risk LOW | peak outages 21,171 MW at HE23 (next 6 h) vs
  trigger 23,354 MW (-2,183 MW; ...) | driving zone: North 9,200 MW | data as of 22:00 CT
  (40 min old) | quality: unchecked | source: ERCOT NP3-233-CD`. Log and saved file checked
  for the three `.env` secrets: none found.
- Not done: staleness check (the line shows the age but nothing rejects old data).

## 2026-09-25: Stale live data rejected, baseline is a setup error

- New setting `STALE_AFTER_MIN=90` (`.env.example`, `read_settings()` as `stale_after_min`,
  `CONSTRAINTS.md` "Stale data"). `signal.reject_stale` runs on `--live` only, right after the
  fetch: a newest posting more than the limit old raises `SignalUnavailable("data is N min old
  (limit 90)")`, so risk is None and the floor is 60% (`signal_unavailable`). File modes never check age.
- `baseline.BaselineError` (a `ValueError`) for a missing or too-short baseline. `run()` re-raises
  it in live mode too, so it stops the run like the engine instead of reading as signal unavailable.
  A baseline with bad JSON inside is still treated as signal unavailable in live mode.
- 3 new tests in `tests/test_signal.py` (120 min old gives None and 60%; 40 min old is rated;
  live run with no baseline raises). `pytest -q`: 25 passed. Disabling either fix makes its test fail.

## 2026-09-25: Engine live mode

- A baseline file with broken JSON now raises `BaselineError` (stops the run in every mode), like
  a missing file. This replaces the previous entry's "bad JSON is still signal unavailable".
- `python -m storm_prep.engine --live [--tape PATH]`: fetches ERCOT once through `load_signal`
  (so `FETCH_TIMEOUT_S` and the stale check apply), rates once, and uses that risk on every tick;
  frame `risk_fixture`s are ignored. No tape gives 12 frames at a flat 0.2 MW `synthetic` target,
  no price. Any failure logs `compute_risk`/`failed` with the reason, prints `live: risk unknown
  | <reason>`, and every tick gets 60% `signal_unavailable`.
- Engine output adds `"source": "live" | "scenario"` (`CONSTRAINTS.md` Engine output, add only);
  `tape` is `"synthetic"` when no tape was given.
- Tests: broken-JSON baseline (`tests/test_risk.py`); faked login timeout gives one fetch, 12 ticks
  at 60% `signal_unavailable`, one failed event (`tests/test_engine.py`). `pytest -q`: 27 passed.
- One real run, 22:58 CT: `live: risk LOW`, 12 ticks at 30% `normal`. Delivered is 0 because
  `allocate` is still the TEMP stub. No `.env` secret in the log.

## 2026-09-25: Worker ack rail on the wall (web only)

- New organism `web/src/components/organisms/AckRail.tsx` under the map, with pure logic in
  `ackTicks.ts`. There are 100 ticks, 25 per zone. A tick's zone uses the same `index % 4` rule
  as `homeNodes`, so the rail and the map dots agree. `homeNodes.ts` is unchanged.
- This is staged, not real device acks: the tape has no per-home ack. Dead homes (from
  `fleetCells`) never answer. They go pending, then unconfirmed at 2 s (`ACK_TIMEOUT_MS`), then
  dead at 3.5 s. Every other home, stale included, acks before 1.2 s.
- Caption `ackCaption` in `format.ts`. The settled "15% dead" scene reads
  `15 silent · 85 acked · call still 0.34 MW`. Each scene click replays the round, and reduced
  motion jumps straight to the settled state.
- `web/tests/ackTicks.test.ts` (6 tests). `npx vitest run`: 59 passed. `tsc --noEmit` clean.
  No Python changed, so `pytest -q` was not run.

## 2026-09-26: Jev shadow recording

- New `scripts/jev_shadow.py` (standalone; no engine or policy change). Shadow only: nothing reads
  its output, so no LLM makes a dispatch decision.
- Input: `tests/fixtures/nws_alert_harris.json` if present (top-level or NWS `properties` with
  `headline`, `description`, `county`/`areaDesc`), else a built-in Harris sample labeled `sample`.
- One `POST https://api.typesafe.ai/v1/systemone` (TypeSafe API reference: `model`, `state`,
  `questions`), model `jev-latest`, one `noul` question: "Does this alert threaten power delivery
  to homes in this county in the next 6 hours?" `requests` timeout 5 s (per connect and per read,
  so not a hard total), no retries.
- Key: `JEV_API_KEY` from `.env`, sent only in the `Authorization: Bearer` header.
- Writes `data/fixtures/jev_harris.json`: `question`, `answer`, `probability`, `model`, `called_at`
  (UTC), `latency_ms`, `input_label`, `recorded: true`. `answer` is our reading ("yes" at P ≥ 0.5);
  Jev only returns the probability.
- Every failure goes through `fail(reason)`: one short line on stderr, exit 1, no secret, no
  file written.
- One real run, 09:58 CT: `jev-1.13.0`, sample input, yes, P(yes)=0.67, 292 ms. Key not in the
  output file (checked without printing it). A blank `JEV_API_KEY` exits 1 with
  "JEV_API_KEY is not set in .env". `pytest -q`: 30 passed. Not committed.

## 2026-09-26: FastAPI backend scaffold

- Uma approved `fastapi`, `uvicorn`, and `httpx2` (test client) in `requirements.txt`. Recorded in
  `CONSTRAINTS.md` ("Backend") and `working-rules.md`.
- New `server/` package (`app.py`, `v1.py`, `fixtures.py`): every `/v1` route from
  `plans/operator-console.md`, reading `web/src/fixtures/console/*.json` (new `zone.json`). Writes
  change in-memory state only; no write changes the mode. `/health` for Render.
- `render.yaml`: one Python web service, `uvicorn server.app:app --host 0.0.0.0 --port $PORT`.
- `tests/test_server.py` (13 tests). `pytest -q`: 43 passed. uvicorn smoke-tested locally with curl
  (health, zone, CORS preflight, 401 without operator). Not deployed to Render yet.
- Notes: `docs/agents/backend.md`, `docs/humans/backend.md`.

## 2026-09-26: Wall talks to the API (`GET /health`)

- Backend health route renamed `/healthz` to `/health` (`server/app.py`, `render.yaml`, tests).
- `web/src/api/health.ts` (`apiBaseUrl`, `checkHealth`, `healthText`, `useApiHealth`); the masthead
  line in `TopStrip` shows `api ok` / `api down · <reason>` / `api checking`. New `VITE_API_BASE_URL`.
- `web/vite.config.ts` proxies `/health` and `/v1` to `localhost:8000` (dev and preview).
- `web/tests/health.test.ts` (6 tests). `npx vitest run`: 71 passed. `tsc --noEmit` clean.
  `pytest -q`: 43 passed. Checked in the browser: `API OK` with uvicorn up, `api down · http 500`
  with it stopped.

## 2026-09-26: Backend merged under `server/`

- Moved the Storm Prep package into `server/engine/` (risk CLI is `cli.py`, tick loop is `loop.py`).
- HTTP routes live in `server/api/` (`v1.py`, `fixtures.py`). uvicorn is still `server.app:app`.
- `storm_prep/` was a short-lived alias and was then removed. Imports and commands use `server.engine`.
- Owner paths in `CONSTRAINTS.md` now point at `server/engine/` and `server/api/`.
- Details: `docs/agents/backend.md`.
- `pytest -q`: 43 passed.

## 2026-09-26: Next-build list replaces the unfinished tape plan

- The engine can read live NP3-233-CD, then the tick loop still assigns 0 kW. The wall still opens on a sample run. The 12-frame synthetic tape is no longer the thing to finish first.
- People pick from `docs/humans/improvements.md`. Copy-paste prompts are in `docs/agents/improvements.md`.
- No application code in this change. `pytest -q` was not run.

## 2026-09-26: Demo data is live ERCOT or a saved ERCOT replay

- Updated `docs/humans/improvements.md` and `docs/agents/improvements.md`. A run is `--live` or `--replay` of a file ERCOT published. Beryl (`data/events/beryl/`) is the saved week. That replay rated LOW on every posting. Sample console scenes, the layout fixture, and a hand-edited outage spike stay off the wall.
- No application code in this change. `pytest -q` was not run.

## 2026-09-26: Dropped the `storm_prep/` alias

- Tests and `scripts/replay_event.py` import `server.engine` only.
- Removed the compatibility package. Commands are `python -m server.engine.cli` and `python -m server.engine`.
- Details: `docs/agents/backend.md`.
- `pytest -q`: 43 passed.

## 2026-09-26: Controller lane (Rajat): fleet, allocator, scoreboard, orchestration runtime

- New under `server/engine/`: `fleet.py` (`new_fleet` with round-robin zones, `apply_events`,
  `discharge`, the shared floor math `floor_kwh`/`safe_kw`), `controller.py` (pure `allocate`),
  `score.py` (`new_board`, `update`), `scheduler.py` (seeded virtual clock), `channel.py` (lossy
  channel: drop, duplicate, delay, late), `orchestration.py` (`run_cycle -> CycleResult`: zone
  supervisors, one worker per home, 0/60/120 s deadlines, retry same id, reassignment new id).
- Runner: `python -m server.engine.orchestration --tape tests/fixtures/tape_tiny.json --seed 1`
  writes `var/orchestration/<seed>.json` and prints one line per tick.
- `loop.py` is untouched: it still holds the TEMP stand-ins. `tests/test_tracer.py` patches ours in
  and proves the tape delivers more than 0 MW on every tick, with delivered + missed = target and
  0 breaches (the stand-ins delivered 0). Next: Uma imports
  `new_fleet, apply_events, discharge` from `fleet`, `allocate` from `controller`, `new_board,
  update` from `score`, and deletes the stand-ins.
- Review fixes folded in: `safe_kw` caps at `max_kw` and gives 0 to a home whose zone has no floor
  in the policy; `discharge` leaves dead and stale homes alone; the 60 s deadline marks every late
  home suspect before any share is reassigned; a slow original and its reassignment both delivering
  is booked once and the rest reported as `over_delivery_mw` (never hidden, never credited).
- Tests: `tests/test_{fleet,controller,score,scheduler,channel,orchestration,failures,invariants,tracer}.py`.
  `pytest -q`: 177 passed. `FUZZ_SEEDS=50`: 50 seeds, 600 ticks, 0 floor breaches. Same seed twice
  gives an identical run.
- Not in the ownership table yet: `orchestration.py`, `scheduler.py`, `channel.py` and their tests
  (ask for Uma). Details: `docs/agents/epic-3-controller.md`.

## 2026-09-26: Telemetry feed spec (Rajat's lane, docs only)

- Wrote `docs/agents/telemetry-vpp.md`: simulated batteries and network, real VPP. Readings every 10 virtual s in the OpenTelemetry metrics shape, an intake, per-home state (stale at 180 s, dead at 600 s, suspect on an energy mismatch), and zone and plant rollups. The controller plans only from reported data.
- Reviewed by Codex; fixes applied (tick-level energy check, feed stops at 300 s, separate true and reported battery objects).
- Asks for Uma (approve `telemetry.py`, wire the engine, add settings) and Sunny (`grid_down` tape key, show the rollups) are listed in the spec.
- Added a line to `docs/agents/index.md`.
- No application code in this change. `pytest -q` was not run.
