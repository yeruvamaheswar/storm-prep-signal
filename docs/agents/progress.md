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

## 2026-09-26: Quality cell uses an operator status

- The Storm Prep Quality cell was printing the raw live-stamp code (`auth`) in Dead red with
  the caption "named fail". That code is a fetch failure laid over the pinned layout tape.
- `web/src/qualityStatus.ts` maps the code to Live, Degraded, Stale, Auth error, Unchecked, or
  Demo data, with a short reason, a tooltip, and an existing wall color token. Synthetic tape
  with a pinned clock shows Demo data for `auth` and the other live-overlay failures. A staged
  timeout whose clock is not pinned stays Degraded.
- `web/tests/qualityStatus.test.ts`. The raw code on the tick is unchanged.
  `npx vitest run`: 76 passed. `tsc --noEmit` clean. `pytest -q`: 30 passed.

## 2026-09-26: Floor and Risk captions hide reason codes

- Floor and Risk were printing `policy_reason` as the subtitle, so a high tick read `storm_risk_high`.
- `headerReason` in `web/src/format.ts` maps `normal`, `storm_risk_high`, `signal_unavailable`, and
  `weather_alert` to a sentence-case label and a tooltip for why the floor moved. Calm sentences
  such as "1 more calm reading" pass through. `riskCaption` still returns the engine code.
- `Metric` takes an optional `title` on the caption. `web/tests/format.test.ts` and
  `web/tests/topStrip.test.ts`.

## 2026-09-26: Calm is a 0–2 meter

- The Calm cell was two empty squares and "calm 0/2", which did not say what the count is.
- It now uses the header metric number, a filled track, and the line "clean LOW readings in a row".
  Zero keeps the ruled track and a muted 0. The streak rule in `calmStreak.ts` is unchanged.
- `web/tests/calmMeter.test.ts`.

## 2026-09-26: Worker ack marks follow the selected tick

- The rail was painting every non-dead home green, so tick 05 read `25/25` and
  `0 silent · 100 acked` while the map showed 50 reserved and 50 discharging.
- `ackMark` in `web/src/components/organisms/ackTicks.ts` keeps the old timer
  (`ackState`: dead homes still go pending, unconfirmed, then dead). The paint is
  separate: discharging and idle homes are acked, reserved homes are held, stale
  and unconfirmed homes are silent, and a missing signal (`risk_level` null or
  `signal_unavailable`) is fail-safe. Zone numerators count only acked homes.
- Settled tick 05: `0 silent · 50 acked · 50 held · call 0.31 MW`, zones 12/25,
  12/25, 13/25, 13/25. Tick 06: 10/25 and 20 dead. `ackCaption` is unchanged.
- `web/tests/ackTicks.test.ts`. `npx vitest run tests/ackTicks.test.ts`: 9 passed.
  `pytest -q`: 30 passed.

## 2026-09-26: Fixture labels sit behind a Demo badge

- The mast was printing `layout-fixture` and the brief footer was the tape disclaimer
  "Layout fixture for the 12-tick demo tape. Not an engine run."
- `headerIdentity` in `web/src/format.ts` treats a fixture run id (`layout-fixture`, `demo-…`)
  and that disclaimer as tape chrome. The wall shows a compact Demo badge; the labels stay
  on its title. SYNTHETIC stays in the mast, with tighter padding. A timestamp run id and a
  real decision line still print. `briefDecision` drops the disclaimer, so the brief is the
  tick's decision text.
- `npx vitest run`: 91 passed. `tsc --noEmit` clean. `pytest -q`: 30 passed.

## 2026-09-26: Zone drill-in from the map and the ack row

- There was no selected zone. The header Zone cell is the driving zone (North on this tape). Outage MW is the only grid series keyed by load zone. Price is one number, and a live read is LZ_NORTH. The floor on the tick is the fleet floor.
- Clicking a zone on the map or its ack row filters the brief, the map callout, and the chart to that zone: outage MW, price, floor, and homes discharging versus reserved. **All zones** clears the filter. The header Zone cell stays the driving zone.
- Noted in `docs/agents/zone-lens.md`. `npx vitest run`: 107 passed. `tsc --noEmit` clean. `pytest -q`: 30 passed.

## 2026-09-26: Banner and margin name two different lines

- The reserve banner said outage MW was "over the line" while Margin said "+191 MW above the line".
  Both were outage 22,539 minus threshold 22,348. "Above the line" also reads as spare energy
  above a home's floor.
- `web/src/wallLines.ts` is the one model. Margin is that subtraction, captioned "past the reserve
  threshold" or "under the reserve threshold". The banner states the action and the same trigger:
  "Raise the reserve floor. Outage 22,539 MW vs 22,348 MW threshold." A bad report says
  "Hold the reserve floor. The outage report cannot be trusted." Delivered MW is captioned
  "above the {floor}% floor".
- `docs/agents/stress-strip.md`. `npx vitest run`: 92 passed. `tsc --noEmit` clean. `pytest -q`: 30 passed.

## 2026-09-26: Mode controls are two groups

- The bottom row mixed Hold, Auto, a debug status line (`AUTO · default`), and scenario chips
  in one strip. Hold and Auto only logged the click.
- Mode is one pair. The filled control is the tick's mode. Hold is the reserved stop.
  The buttons do not call the engine. They open the tape tick that already carries that mode:
  Hold is tick 08 (`operator_hold`, delivered 0), Auto after that is tick 09.
- Scenarios are a second group: Fail-safe, High risk, Radar, 15% offline. The devices scene
  label is `15% offline`. Radar stays a map overlay.
- `web/src/components/organisms/modeTicks.ts`. `web/tests/controlBar.test.ts`.
  `npx vitest run`: 100 passed. `tsc --noEmit` clean. `pytest -q`: 30 passed.

## 2026-09-26: Map labels clear the clusters

- Zone captions were pinned to each polygon’s center, so Houston, West, and South sat on the metro dots. Only the driving zone was filled. The ERCOT callout was centered on top of Texas.
- Labels now pick a spot that clears every home dot, and step into open water when the zone is too small. The selected zone keeps the posting fill; the other zones are muted. No selection still fills the driving zone. A cluster hover reads homes, reserved, discharging, supplying MW, and zone outage MW. The callout is a row above the map.
- `web/src/zoneLabels.ts`. `docs/agents/zone-lens.md`. `npx vitest run`: 111 passed. `tsc --noEmit` clean. `pytest -q`: 30 passed.

## 2026-09-26: Fleet UI at 10k homes, research and plan (no app code)

- Timed the per-home paths at 100 and 10k homes. The label picker costs 464 ms per tick at 10k. Home coordinates are recomputed twice per tick. The map rebuilds one SVG marker per home, and the ack rail re-renders one span per home every 100 ms.
- Five web-only slices proposed, plus two asks for other owners (per-zone fleet counts on the tick, and paged `/v1/homes`). Status: DRAFT, waiting for approval.
- `docs/agents/fleet-scale.md`. No code changed, so `pytest -q` was not run.
- Approved: bars at every fleet size, 500-dot cap, one slice at a time.

## 2026-09-26: Live and Demo run modes

- The wall assumed the 12-tick tape: tick 05/12, a pinned 12:00 CT clock, buttons 01–12, and sparkline marks on ticks 05 and 06.
- Run is now Live or Demo. Demo keeps that tape. Live uses the current 15-minute ERCOT interval, sets As of from the last good pull, and hides the tick scrubber. The live chart is the interval strip, which stays empty until a series exists. Quality in Live is feed health, not "Demo data".
- Live is the default when ERCOT credentials are set and the first pull has not failed. No credentials, or a failed first pull, falls back to Demo. Live cannot be selected in that fallback.
- Noted in `docs/agents/runtime-mode.md`. `npx vitest run`: 174 passed. `tsc --noEmit` clean. `pytest -q`: 30 passed.

## 2026-09-26: Fleet slice 1, zone counts without one entry per home

- `fleetCounts(tick)` holds the per-state math. `web/src/fleetAggregate.ts` `zoneAggregates(tick)` gives each load zone's homes by state with the same `index % 4` rule, in O(zones). The zone lens, the fleet legend, and the call caption read counts. The zone chart reads outage MW directly. No visual change: tick 05 still reads 50 reserved, 12/12/13/13 discharging.
- `web/tests/fleetAggregate.test.ts` (18 tests). `npx vitest run`: 142 passed, 2 failed in `tests/topStrip.test.ts` (`SideRail` now needs `feeds`, from the parallel Reports drawer work, not this slice). `tsc --noEmit`: errors only in `ReportsDrawer.tsx` and `topStrip.test.ts`. `.venv/bin/python -m pytest -q`: 30 passed.

## 2026-09-26: One fleet intent line on the banner

- Charge, discharge, and backup were not three controllers. Backup is `reserve_policy`. Discharge is the 0 kW stub in `engine.py`. Charge is starting state of charge. The wall was saying the floor in a fail banner and again in the brief.
- The banner now reads the tick: discharge or hold. An untrusted report outranks operator Hold. A HIGH tick that is still selling leads with discharge and keeps the outage trigger. Charging stays out of the frozen plan.
- `web/src/fleetIntent.ts`. `docs/agents/fleet-intent.md`. `npx vitest run`: 144 passed. `tsc --noEmit` clean. `pytest -q`: 30 passed.

## 2026-09-26: Feeds freshness list on Quality

- Quality and the side rail now list the two ERCOT products: NP3-233-CD outage and NP6-905-CD price at LZ_NORTH. Each row is product, LZ, as-of, last success, and state (live / stale / hold / auth). No EMIL columns.
- Demo fills those rows from the fixture posting. Live copies ingest health. A later engine list in the same `FeedRow` shape is used as written.
- Late, missing, or auth-fail sets Quality, holds the reserve banner, and adds "Holding spare energy" without opening a raw report.
- `web/src/reportFeeds.ts`. `docs/agents/reports-drawer.md`.

## 2026-09-26: Reports panel instead of an EMIL dump

- A bad pull opens Reports in the side rail. The purpose line is "View grid data reports". The rows are product, load zone, as-of, last success, next pull, and hold-on-fail. No EMIL columns.
- The two wall fetchers stay NP3-233-CD outage and NP6-905-CD price at LZ_NORTH. Quality already turns `auth` into Auth error. A pinned synthetic overlay stays Demo data. Hold-on-fail uses the same untrusted-report sentence as the banner.
- `web/src/reportFeeds.ts`. `docs/agents/reports-drawer.md`. `npx vitest run`: 144 passed. `tsc --noEmit` clean. `.venv/bin/pytest -q`: 30 passed.

## 2026-09-26: Header tiles bind to one snapshot

- TARGET through QUALITY were reading the tape tick and a stress reading, so Live still showed fixture QUALITY (Unchecked, Demo data) and a pinned clock.
- Both modes now fill `WallSnapshot` in `web/src/wallSnapshot.ts`. Demo maps the tape. Live maps the backend poll. TopStrip tiles read only that row.
- Live QUALITY is Live / Stale / Auth error / Degraded. AS OF is feed lag unless the operator pins.
- Noted in `docs/agents/wall-snapshot.md`. `npx vitest run`: 174 passed. `tsc --noEmit` clean. `.venv/bin/pytest -q`: 30 passed.

## 2026-09-26: Live interval strip, no 01–12 fallback

- The bottom chart was one 12-tick tape. Demo still uses that: tick buttons, "05 missed on purpose", "06 homes died". Live is a rolling interval strip for target, delivered, and reserved. An empty series shows a skeleton and "Waiting for intervals". It does not paint ticks 01–12.
- Chart math is in `web/src/chartPlot.ts`. Tape playback is `tapeSpark.ts` + `TapeScrubber.tsx`. The live series is `intervalSeries.ts` + `IntervalStrip.tsx`. Event marks on the live strip are risk HIGH, floor raised, homes offline, and hold.
- `OperatorWall` passes `intervals={[]}` until a backend series exists. Scenario chips stay Demo. Radar stays on both.
- `docs/agents/interval-strip.md`. `npx vitest run tests/intervalSeries.test.ts tests/controlBar.test.ts tests/tapeSpark.test.ts`: 16 passed. Full `npx vitest run`: 169 passed, 2 failed in `reportFeeds.test.ts` and `topStrip.test.ts` (parallel Live chrome, not this strip). `tsc --noEmit`: errors only in `tests/reportFeeds.test.ts`. `.venv/bin/pytest -q`: 30 passed.

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

## 2026-09-26: Load the saved NP3-233-CD archive into Supabase

- Added `scripts/load_ercot_archive.py`. Each zip in `data/events/<event>/raw/` becomes one row in `public.ercot_postings`: `report`, `posted_at` (Central, from the file name), `event` (folder name), `file_name` (the CSV inside the zip), and `payload` (the rows, renamed to the live API fields by `read_posting`). Upserts on `(report, posted_at)` in batches of 25. A posting is about 93 KB of JSON, and batches of 100 (9 MB) sometimes missed the 10 s timeout.
- `event` is the folder name, so each event's rows include its 30-day pre-storm baseline window (beryl 888, heather 864), not only the replay week.
- Tests: `tests/test_load_ercot_archive.py`. `--dry-run` built 1752 rows. No live send was run in this change.
- `pytest -q`: 45 passed.

## 2026-09-26: PROJECT_CONTEXT.md matches the code

- Principle 5 is now "online is fine, never required." The agent rule on network calls now names the one ERCOT fetch in `server/engine/signal.py` instead of saying the engine has none.
- The Supabase section lists all three tables (`ercot_postings`, `ercot_prices`, `runs`), says `runs` is not written yet, and says nothing reads the tables yet.
- Layout lists `scripts/load_ercot_reports.py`. `PROJECT_CONTEXT.md` is now in `docs/agents/index.md`.
- Open: `demo.sh` (Sunny) does not exist yet, so the fallback in principle 5 is not built. What the forecast, price, and tuning-month data are for is not decided.
- `pytest -q`: 49 passed. Docs only, no code changed.

## 2026-09-26: Margin check against the Supabase postings

- Supabase holds (counted 2026-09-26): NP3-233-CD beryl 888, heather 864, tuning-2026 765; beryl and tuning-2026 also have the load, wind, and solar reports and `ercot_prices` (beryl 5,376, tuning-2026 24,552 rows). Heather has only NP3-233-CD. There is no `runs` table.
- Added `scripts/check_margin.py`. It reads NP3-233-CD from `ercot_postings`, builds the lead-matched baseline, rates each posting with `rate_posting` at 10, 15, and 20%, and writes `data/margin_check.json`. The engine does not read that file or Supabase.
- Results (statewide NP3-233-CD rule alone, 6-hour lookahead):

| Window | Baseline | Rated | HIGH at +10% | +15% | +20% |
|---|---|---|---|---|---|
| Beryl, Jul 5-11 2024 | 30 days before | 168 | 0 | 0 | 0 |
| Heather, Jan 12-17 2024 | 30 days before | 144 | 7 | 1 (Jan 15 13:03) | 0 |
| Last 30 days, Aug 25-Sep 25 2026 | same month | 765 | 92 | 22 (Sep 16-25) | 0 |

- Reading: no margin in this range both catches Beryl and stays quiet on the last 30 days. Beryl's statewide peak sits under even +10%, which matches the earlier replay (5% under +15%). For a storm like Beryl the ERCOT margin alone does not raise the floor; the per-zone weather alerts in `server/engine/policy.py` are the other path (not re-checked against Beryl here). The last-30-days baseline is the same month, so its count is how often normal swings cross the margin, not a forecast. Why its HIGHs cluster in Sep 16-25 is not checked.
- The 15% margin is unchanged. Changing it is an engine decision (Uma).
- Tests: `tests/test_check_margin.py`, no network. `pytest -q`: 55 passed.

## 2026-09-26: FastAPI live snapshot for the wall

- Snapshot now rates the posting. See "Floor and risk from the v2 trigger" below.
- `GET /v1/runs/latest` serves `var/runs/latest.json`, or `layout-run.json` when that file is missing.
- The wall's `useLiveStamp()` polls `/v1/snapshot`. Vite ERCOT keys are unused.

## 2026-09-26: Floor and risk from the v2 trigger

- Live risk is `compute_risk` (6-hour lookahead, peak vs lead-matched baseline × 1.15). `reserve_policy` turns HIGH into 60% `storm_risk_high`. The wall no longer invents `THRESHOLD_MW = 22348` or tick-5 zone sums for a live posting.
- `GET /v1/snapshot` sends `trigger_mw`, `peak_mw`, `outage_mw` (the peak hour), the twelve NP3 zone columns, and `margin_mw = outage − trigger`. A stale or missing report is risk None, 60%, `signal_unavailable`. QUALITY and the banner show that in Live. They do not become Demo data.
- Demo tape ticks carry `trigger_mw` so the 12-tick story still has a threshold. Live never borrows that number.
- Noted in `docs/agents/stress-strip.md` and `docs/agents/wall-snapshot.md`. People page: `docs/humans/floor-and-risk.md`.
- `pytest -q`: 169 passed. `npx vitest run`: 198 passed. `tsc --noEmit` clean.

## 2026-09-26: Allocator and fleet off the stub

- Copied `allocate`, `home_caps`, `split_target` (`server/engine/controller.py`) and `new_fleet`, `assign_zone`, `apply_events`, `discharge` (`server/engine/fleet.py`) from `origin/controller-rajat-dev`. They sit under `server/engine/`, not `storm_prep/`: this branch already dropped that package.
- Left Rajat's `loop.py` TEMP block behind (it was the same 0 kW stub). Also left `score.py`, `scheduler.py`, `channel.py`, and `orchestration.py`. No charge controller.
- `server/engine/loop.py` now imports those functions. Each tick is still apply_events → compute_risk → reserve_policy → allocate → discharge → TickResult. `load_tape` and `write_brief` stay TEMP.
- Tiny tape now delivers: tick 1 0.200 of 0.200 MW, tick 2 0.219 of 0.400 (`storm_reserve`), tick 3 0.185 of 0.400 (`storm_reserve`). `breaches == 0`. HOLD is still 0 kW.
- Tests: `tests/test_controller.py`, `tests/test_fleet.py`. Noted in `docs/agents/fleet-intent.md`.
- `pytest -q`: 105 passed.

## 2026-09-26: Zone supervisor acks as a rollup

- There is no per-home device command API. After `allocate`, `simulate_zone_acks` rolls `{acked, held, silent, dead, unconfirmed}` per zone. `command_id` is `{home_id}:{tick}`. Optional `channel_drop_rate` can drop the send and the one 60 s retry; books close at 120 s (virtual). `HomeWorker.seen` ignores a repeat. Hardware is not faked.
- `TickResult.zone_acks` is add-only. `GET /v1/snapshot` passes it through. AckRail binds those counts as four stacked bars. A tape without the field still uses zone aggregates, not 100 spans.
- `server/engine/supervisor.py`. Notes: `docs/agents/zone-acks.md`, `docs/humans/zone-acks.md`.

## 2026-09-26: 10k seed with zones, rollups only

- `new_fleet` still takes the settings dict. `new_fleet(n)` seeds n homes at 20 kWh / 5 kW, 45–75% SOC, status live, zones South/North/West/Houston. Persist is opt-in under `var/fleet/`.
- `GET /v1/fleet/rollups` returns per-zone live/reserved/discharging/stale/dead/silent counts, reserved vs discharging MW, and metro centroids. No home list. `GET /v1/homes` stays on the small fixtures.
- Each tick fills `TickResult.zone_delivered_mw` and writes `var/fleet/rollups.json`.
- Noted in `docs/agents/fleet-rollups.md` and `docs/humans/fleet-rollups.md`.
- `FLEET_SIZE` stays 100 for the demo tape.
- `pytest -q` (ignoring two tests that import missing `fleet_state` / `supervisor` modules): 144 passed. Four remaining failures are those same missing-module writes (`state_path`, `fleet_state`), not this slice.

## 2026-09-26: ERCOT auth and fetches behind a Python proxy

- `GET /v1/feeds/outage` and `GET /v1/feeds/price` reuse `fetch_outages()` plus a new NP6-905-CD fetch. Username, password, subscription key, and the B2C token stay on the server. Last good bodies go to `var/signal/`.
- 401/403 → quality `auth`. 429/5xx or timeout → last good body if it is still inside 90 min (outage) or 30 min (price); else `unavailable` or `stale`.
- `GET /v1/snapshot` now reads those feeds instead of calling ERCOT itself. The wall has no `VITE_ERCOT_*` keys.
- Notes: `docs/agents/feeds-proxy.md`, `docs/humans/feeds-proxy.md`.
- `.venv/bin/python -m pytest -q tests/test_feeds.py tests/test_snapshot.py`: 13 passed. `npx vitest run tests/liveStamp.test.ts tests/runtimeMode.test.ts`: 12 passed. Full `pytest -q` also collected unfinished tests for `fleet_state` / `supervisor` from other branches.

## 2026-09-26: Live interval stream, no browser ERCOT poll

- Live polls `GET /v1/snapshot` every 20 s. The browser no longer calls `api.ercot.com` or `/v1/feeds`.
- `GET /v1/live/stream` sends `tick`, `feeds`, `attention`, and `home` (fleet rollup, not 10k rows). The wall uses the snapshot poll; `createClient().liveStream` reads the named events.
- Live follows the snapshot tick, not the selected Demo tape index. Interval-strip points accumulate from those polls.
- `engine.run(live=True)` writes `var/runs/latest.json` after each tick so `/v1/snapshot` stays aligned (`write_run_files` in `server/engine/loop.py`; Uma owns that file).
- Notes: `docs/agents/backend.md`, `runtime-mode.md`, `interval-strip.md`, `wall-snapshot.md`, `docs/humans/backend.md`.
- `.venv/bin/python -m pytest -q`: 162 passed, 4 failed in `test_feeds.py` / `test_snapshot_brief.py` (http_status extra field and brief wording; not this slice). New stream tests passed.
- `npx vitest run`: 196 passed, 1 failed in `reportFeeds.test.ts` (`readSuppliedFeeds` shape; not this slice). `npx tsc --noEmit` clean.

## 2026-09-26: Live NP6-905-CD price in Python, stamped on the tick

- `fetch_price()` sits next to `fetch_outages()` and uses `get_id_token`. Query is `settlementPoint=LZ_NORTH` only. DAM NP4-190 and other LZs are out.
- `read_price()` is the one parser (`rows_by_name`, newest `settlementPointPrice` + deliveryDate/Hour/Interval, 30 min stale). `stamp_price()` sets `price_usd_mwh`, `price_label="ercot"`, `price_as_of` on success. On failure the live tick is none, never tape 185.
- `--live` fetches price once after a good outage login and stamps every tick. `/v1/feeds/price` and `/v1/snapshot` call the same reader.
- `TickResult.price_as_of` added (optional). Notes: `docs/agents/price-live.md`, `docs/humans/price-live.md`.
- Tests: `tests/test_price.py`, live cases in `tests/test_engine.py`.

## 2026-09-26: Hold/Auto write engine mode, not tape ticks 08/09

- `var/state.json` stores `AUTO` or `HOLD`. `POST /v1/fleet/mode` writes it. `engine.run()` seeds mode from that file; tape `events.operator` still sticks. `allocate()` delivers 0 on HOLD.
- `GET /v1/snapshot` overlays `mode` from the same file. Live Hold/Auto call the API. Demo may still jump to the tape ticks that already carry that mode.
- Notes: `docs/agents/backend.md`, `fleet-intent.md`, `runtime-mode.md`, `docs/humans/backend.md`.
- Tests: `tests/test_fleet_state.py`, `tests/test_snapshot_mode.py`, engine hold/sticky cases, `web/tests/wallMode.test.ts`.
- `pytest -q`: 165 passed, 1 failed in `tests/test_snapshot_brief.py` (brief copy, not this slice). `npx vitest run tests/wallMode.test.ts tests/controlBar.test.ts`: 12 passed. `tsc --noEmit` clean.

## 2026-09-26: Live and Demo no longer share tape numbers

- `GET /v1/meta` returns `{ mode, fleet_size, source }`. The wall honors `?mode=`, then `VITE_DEFAULT_MODE`, then that meta.
- Demo is `layout-run.json` only. `loadRun()` does not fetch `/v1/runs/latest`. Scenes and the 12-tick scrubber stay. No ERCOT overlay.
- Live polls `GET /v1/snapshot` only. `useLiveStamp` is off in Demo. Price shows only when the label is `ercot` (no tape 185). The outage line uses `trigger_mw` only when it arrived (no tape 22348).
- A failed first live pull falls back to Demo and Quality names the failed pull (`fallbackQuality`).
- Notes: `docs/agents/runtime-mode.md`, `wall-snapshot.md`, `docs/humans/runtime-mode.md`.
- `.venv/bin/python -m pytest -q`: 169 passed. `npx vitest run`: 198 passed. `npx tsc --noEmit` clean.

## 2026-09-26: Snapshot feeds[] for the Quality drawer

- `GET /v1/snapshot` always returns `feeds[]` for NP3-233-CD and NP6-905-CD: `{ product, path, as_of, age_min, quality, hold_on_fail, http_status }`.
- An outage `LiveFailure` (`auth|timeout|stale|malformed|unavailable`) sets `hold_on_fail` true and `policy_reason` `signal_unavailable`. A price fail is named and does not hold.
- `/v1/feeds/*` now includes last HTTP status with no secrets. The wall maps that list in `readSuppliedFeeds`.
- Notes: `docs/agents/backend.md`, `wall-snapshot.md`, `reports-drawer.md`, `feeds-proxy.md`, `docs/humans/backend.md`.
- `.venv/bin/python -m pytest -q`: 166 passed. `npx vitest run tests/reportFeeds.test.ts tests/liveStamp.test.ts`: 21 passed.

## 2026-09-26: Brief and reasons from TickResult codes

- `write_brief` lived as a TEMP stub that returned `""`. The wall brief was layout-run fixture prose, so Live could still say "missed on purpose" or "tape tick 5/12".
- `server/engine/brief.py` builds one or two sentences from delivered MW and the codes already in `reasonText` / `reason_codes`: `storm_reserve`, `fleet_headroom_short`, `homes_dead:n`, `homes_stale:n`, `signal_unavailable`. `loop.py` imports that function (Uma owns the file; this replaced the TEMP stub).
- `GET /v1/snapshot` applies `apply_tick_brief`. `GET /v1/runs/latest` keeps layout-run.json text for the Demo tape.
- `WallSnapshot.brief` is the tape sentence in Demo and `tickBrief` in Live. The rail stamp in Live still uses `liveRailStamp`.
- Notes: `docs/agents/wall-snapshot.md`, `runtime-mode.md`, `backend.md`, `docs/humans/backend.md`.
- Tests: `tests/test_brief.py`, `tests/test_snapshot_brief.py`, `web/tests/format.test.ts`, `runtimeMode.test.ts`, `wallSnapshot.test.ts`.

## 2026-09-26: Feeds panel rows from postings plus live health

- `GET /v1/feeds?event=` lists the latest `ercot_postings` row per report for beryl, heather, or tuning-2026 (posted_at, row_count, event, file_name zip vs API) and overlays `var/signal/` quality on NP3-233-CD and NP6-905-CD. It does not call ERCOT.
- History chips on the Feeds panel: NP3-233-CD plus loaded NP3-565-CD and NP4-732/733/737/738-CD. Only NP3-233-CD and NP6-905-CD still drive floor and price on `/v1/snapshot`.
- Notes: `docs/agents/feeds-proxy.md`, `docs/agents/reports-drawer.md`, `docs/humans/feeds-proxy.md`.

## 2026-09-26: Mast names LIVE, ARCHIVE, or Demo fixture

- The wall still polls `GET /v1/snapshot` every 20 s. No `@supabase/supabase-js` and no anon key.
- `GET /v1/meta` and the snapshot tick carry `source`, `event`, and `clock`. The mast chip is LIVE, ARCHIVE plus the event, or the existing Demo fixture badge.
- The 01–12 scrubber stays on `layout-fixture` only. Live and archive-clocked show the interval strip. Demo does not default to Beryl; `?event=beryl` is the archive path.
- `web/src/wallOrigin.ts` is the one home for that chrome. `useLiveStamp()`, `feedChip()`, and `headerIdentity()` stay as they were for poll, target/price labels, and the Demo title.
- Notes: `docs/agents/runtime-mode.md`, `wall-snapshot.md`, `docs/humans/runtime-mode.md`.

## 2026-09-26: Live/archive tape targets follow FLEET_SIZE

- 10k × 5 kW = 50 MW fleet cap. Layout 0.40 MW is only the Demo tape (100 homes).
- Live/archive `scale_target_mw` maps the 100-home tape onto `min(call_target, fleet_cap)`. Unset `CALL_TARGET_MW` scales 0.40 × FLEET_SIZE/100 (40 MW at 10k).
- `GET /v1/meta` adds `fleet_cap_mw` and `call_target_mw`. Snapshot home counts and MW follow `FLEET_SIZE`. Rollups ignore a saved `n` that does not match.
- No `homes` table. `new_fleet(n)` stays in memory unless persist is asked.
- Notes: `docs/agents/fleet-rollups.md`, `docs/humans/fleet-rollups.md`.
- Tests: `tests/test_fleet_scale.py`.

## 2026-09-26: Missing decision_line no longer crashes the wall

- Engine `var/runs/latest.json` has `run_id` and ticks, not `decision_line`. `briefDecision` only guarded `null`, so `undefined` threw on `.trim()` and the SideRail took the wall down.
- `briefDecision` now treats missing or blank the same way `headerIdentity` already did: no footer. SideRail defaults the prop to `null`, matching TopStrip.
- `npx vitest run tests/format.test.ts`: 11 passed.

## 2026-09-26: One env loader for server/.env then process env

- Scripts hardcoded repo-root `.env` (`ENV_PATH = ROOT / ".env"`), so they printed `skipped: no_config` while `SUPABASE_URL` and `SUPABASE_SECRET_KEY` lived in `server/.env`. FastAPI only called bare `load_dotenv()` on feed routes. Render listed no Supabase names.
- `server/env.py` `load_env()` reads `server/.env`, then leaves process env in place. `create_app()`, `feeds.fetch_settings()`, `scripts/load_ercot_archive.py`, `scripts/load_ercot_reports.py`, and `scripts/check_margin.py` share it. Tests still patch each script's `ENV_PATH`.
- `.env.example` lists the two Supabase names only. `render.yaml` adds them as `sync: false`. Not in Vite.
- Notes: `docs/agents/backend.md`, `PROJECT_CONTEXT.md`, `docs/humans/backend.md`.
- Tests: `tests/test_env.py`, existing `no_config` cases. `pytest -q`: 176 passed.

## 2026-09-26: Archive price and outage for Demo/Synthetic

- `GET /v1/snapshot` and `serve_price()` / `serve_outage()` read `ercot_postings` and `ercot_prices` when the last run is not Live. Given `event` + clock, the reader takes the newest NP3-233-CD `payload` and NP6-905-CD `LZ_NORTH` rows with `posted_at` / `interval_ending` ≤ clock. Live still uses `signal.py` and `var/signal/`.
- Upsert keys stay `(report, posted_at)` and `(settlement_point, interval_ending)`. `payload` does not repeat `postedDatetime`. Those two tables are never truncated on a tape reset.
- Notes: `docs/agents/archive-feeds.md`, `docs/humans/archive-feeds.md`.
- Tests: `tests/test_archive.py`.

## 2026-09-26: Persist each engine run into public.runs

- `public.runs` existed with 0 rows. After `loop.run()` writes `var/runs/<id>.json`, `scripts/persist_run.py` upserts the same payload on `run_id`. `source` is `live|scenario|fixture`. `result` is the ticks JSON (OpenAPI requires it). `summary` is last-tick header metrics. `ercot_posting_ids` are `ercot_postings.id` for the NP3 postings the run used.
- The engine does not import Supabase during a tick. `python -m server.engine` calls persist after `main()` returns. Missing keys or a failed POST print `runs_skipped: <reason>` and exit 0. The wall still reads FastAPI / `latest.json`.
- Notes: `docs/agents/persist-run.md`, `docs/humans/persist-run.md`.
- Tests: `tests/test_persist_run.py`.

## 2026-09-26: Empty public.runs is not source of truth

- `public.runs` can still be 0 rows. A GET to PostgREST `/runs` that returns `[]` is not a run and must not blank the wall.
- `GET /v1/runs/latest` keeps `var/runs/latest.json` first. `run_from_table_rows` / `runFromTableRows` only accept a row that already holds a run file. Empty rows, `result: []`, or a path pointer fall back to that snapshot file, then `layout-run.json`. Vite does not call PostgREST.
- Notes: `docs/agents/PROJECT_CONTEXT.md`, `docs/agents/backend.md`, `docs/agents/persist-run.md`, `docs/humans/backend.md`.
- Tests: `tests/test_runs_table.py` 8 passed. `npx vitest run tests/loadRun.test.ts` 7 passed. Full `pytest -q` still collects unfinished parallel files (`test_snapshot_prices.py`, `_iso_clock` in `snapshot.py`).

## 2026-09-26: Archive risk uses compute_risk, not tape 22348

- `source=archive` snapshot now GETs `ercot_postings` (same payload `check_margin.py` already reads), wraps it as an NP3 body, and rates it with `compute_risk` → `reserve_policy`.
- The tick gets `trigger_mw`, `peak_mw`, zone hour totals, and `policy_reason` from that v2 rating. It does not copy tape `22348`.
- Stale windows stay in Python: 90 minutes for the posting vs the archive clock, 30 minutes for price. A missing posting is `signal_unavailable` and floor 60%.
- Notes: `docs/agents/archive-feeds.md`, `docs/agents/wall-snapshot.md`, `docs/humans/floor-and-risk.md`.

## 2026-09-26: Bind zone prices from ercot_prices, not LZ_NORTH only

- Snapshot and zone drill-in use the selected zone's `price_usd_mwh` when an archive or live row exists for that interval. PK is `(settlement_point, interval_ending)`.
- The four load zones are `LZ_HOUSTON`, `LZ_NORTH`, `LZ_SOUTH`, `LZ_WEST`. `LZ_AEN|CPS|LCRA|RAYBN` are ignored. `price_label` is `ercot` only when the number came from a row.
- Live `fetch_price()` stays LZ_NORTH. Archive `read_prices()` now loads the other three LZs at the same interval. The tick carries `zone_prices`.
- Notes: `docs/agents/price-live.md`, `docs/agents/zone-lens.md`, `docs/agents/archive-feeds.md`, `docs/humans/price-live.md`.
- Tests: `tests/test_snapshot_prices.py`, `web/tests/zoneLens.test.ts`, `web/tests/wallSnapshot.test.ts`.
- `pytest -q`: 227 passed.

## 2026-09-26: Runtime event clock for weekend replay

- Live outages may be quiet. `GET /v1/meta` and `GET /v1/snapshot` now carry `source=live|archive|fixture`, `event=beryl|heather|tuning-2026|null`, and `clock=wall|archive|fixture`.
- Demo with an event (`?event=beryl`, or Demo click defaulting to beryl) pins the posting clock. Risk, floor, and price come from `data/events/<event>/replay.csv` (or Supabase archive) instead of the 12-tick layout numbers. `?event=none` keeps the tape. Archive ingest uses that pinned posting time so a 2024 week is not treated as stale.
- Discovery uses that replay.csv. `web/src/fixtures/layout-run.json` is the copy/fallback path when no archive is present.
- Notes: `docs/agents/runtime-mode.md`, `docs/agents/backend.md`, `docs/humans/runtime-mode.md`.
- Tests: `tests/test_runtime_clock.py`, `web/tests/loadRun.test.ts`, `web/tests/wallOrigin.test.ts`.

## 2026-09-26: Archive inject does not need Supabase env

- CI has no `server/.env`. `test_serve_archive_skips_live_fetch` injects `archive_get` but `fetch_rows` still required `SUPABASE_URL` / `SUPABASE_SECRET_KEY`, so quality was `unavailable` on GitHub and `ok` on a laptop with keys.
- An injected getter is the I/O. Missing keys still fail when `http_get` is unset (`test_missing_config_is_unavailable`).
- `pytest -q`: 228 passed.

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

## 2026-09-26: Live worker upserts ERCOT and runs one allocate tick

- `scripts/live_cycle.py` fetches NP3-233-CD and NP6-905-CD, upserts `event=live` into
  `ercot_postings` / `ercot_prices`, rates that same posting, and calls `loop.run` with one
  0.40 MW frame. `loop.run` now accepts `frames`, `live_risk`, and `live_price` so the worker
  does not log in twice. `--loop` sleeps `tick_minutes` on a laptop. No Render worker.
- `GET /v1/snapshot` on `source=live` reads `event=live` first; direct ERCOT is the fallback.
  Auto then shows the allocated `latest.json`, not the 2026-09-25 `temp_stub` file.
- No `ercot_postings` column change. `event` is already text. Archive weeks are not deleted.
- Notes: `docs/agents/live-ingest.md`, `docs/humans/live-worker.md`.
- Tests: `tests/test_live_cycle.py`.

## 2026-09-26: Extend contracts for intent (add-only)

- `Policy` and `TickResult` now have `intent` (`charge` \| `discharge` \| `hold`) and `intent_reason`.
  Defaults are hold / empty so old constructors stay valid. Floor-only callers stay hold.
- `Home.updated_at` added (`""` until stamped). `Home.zone` was already there.
- `Allocation.per_home_kw` stays one field and is signed (`>0` discharge, `<0` charge). No
  `per_home_charge_kw` / `per_home_discharge_kw`.
- `CONSTRAINTS.md` allocation rule step 6: charge raises soc; discharge never crosses the floor;
  `breaches == 0`. Rajat implements signed charge later; current `discharge` still skips `kw <= 0`.
- `loop.py` copies `intent` and `intent_reason` onto the tick. HOLD sets `operator_hold`.
- Notes: `docs/agents/policy-intent.md`, `docs/humans/policy-intent.md`.
- Uma-only. Did not edit Rajat (`controller.py`, `fleet.py`) or Sunny (`web/src/contracts.ts`).

## 2026-09-26: Charge / hold / discharge intent from price and floor

- `reserve_policy` now takes optional `mode`, `price_usd_mwh`, and `price_label` and sets `Policy.intent`.
  HOLD → hold. `price_label` none → hold, `intent_reason` `price_unavailable`. HIGH or a missing
  signal may charge when cheap and never discharge. LOW + AUTO uses `CHARGE_BELOW_USD=25` /
  `DISCHARGE_ABOVE_USD=60` (simulation, not Base specs).
- `TickResult.intent` is add-only. `price_usd_mwh` was already on the tick. `loop.py` stamps price,
  then policy, then allocate. Allocate still only discharges.
- Floor-only callers (snapshot, CLI) omit `price_label` and stay hold.
- Notes: `docs/agents/policy-intent.md`, `docs/humans/policy-intent.md`.
- Tests: five intent branches in `tests/test_policy.py`. No Supabase import.
- `pytest -q`: 332 passed.

## 2026-09-26: Charge-drop consistency check (Rajat)

- `server/engine/orchestration.py`: each worker records how much its home's charge really fell per
  command (`rt.dropped`). When a report arrives, the zone supervisor compares the reported kWh with
  that drop. More than `CHARGE_TOLERANCE_KWH` (1e-6) apart: log `charge_mismatch` (reported_kwh,
  dropped_kwh), count it, add reason `charge_mismatch:<n>`, and book the smaller of the two. A home
  is never credited above what its battery gave. Honest reports book unchanged.
- Test hook `_misreport` (home_id to factor) makes a worker lie; off by default, so the runner's
  output for a seed is byte-identical to before. Mismatching homes are not marked suspect.
- Tests: new cases in `tests/test_orchestration.py` and `tests/test_failures.py`; the fuzzer mixes
  in misreporting workers and checks no home is booked above its charge drop.
  `pytest -q`: 316 passed. `FUZZ_SEEDS=50`: 50 seeds, 600 ticks, 0 floor breaches.

## 2026-09-26: Fix false over-delivery after a caught overstatement (Rajat)

- A caught overstatement was booked as kWh converted back to kW, which drifted by a rounding speck
  (e.g. 1.999999999999993 for 2.0). Drifting up made `close` log a false `over_delivery` and add
  reason `over_delivery:1`, though nothing ran twice. Energy totals were right; the label was wrong.
- Fix in `server/engine/orchestration.py`: each worker keeps the exact kW it gave (`rt.ran_kw`), and
  a mismatch books `min(reported kW, ran kW)` with no conversion. Detection is unchanged.
- Test: `test_a_caught_overstatement_is_booked_exactly_and_is_never_over_delivery`.
  `pytest -q`: 317 passed. `FUZZ_SEEDS=50`: 50 seeds, 600 ticks, 0 floor breaches.

## 2026-09-26: Heather replay tape; code flow doc

- A "Supabase is build-time only" decision was drafted here and dropped on rebase onto main: main already reads Supabase from `server/api/archive.py` and writes `runs` via `scripts/persist_run.py`. `docs/agents/PROJECT_CONTEXT.md` keeps main's Supabase section.
- `scripts/load_ercot_reports.py`: `heather` window (2024-01-12 to 01-17), NP6-905-CD only. Loaded 4,608 price rows.
- New `scripts/build_tape.py`: writes `tapes/heather.json` (145 frames, Jan 15 07:00-19:00 CT, 5-minute ticks, price `recorded:ERCOT NP6-905-CD LZ_HOUSTON`, target 0.2 MW `synthetic`), 13 posting fixtures in `data/fixtures/heather/`, and `data/fixtures/heather/baseline.json` (720 postings, Dec 13 to Jan 11). Supabase failure prints `build_tape_skipped: <reason>` and exits 0.
- `server/engine/loop.py`: `run(..., baseline_path=)` and `--baseline PATH` (default `data/baseline_by_lead.json`); the run record adds `"baseline"`. A past storm must be rated against the month before it: without `--baseline`, Heather stays at 30% all day.
- Replay: `python -m server.engine --tape tapes/heather.json --baseline data/fixtures/heather/baseline.json`. 133 ticks at 30% `normal`, 12 at 60% `storm_risk_high` from 13:05 to 14:00 CT (the 13:03:35 posting, 21,809 MW vs 21,779.8 MW trigger), breaches 0.
- Code flow: `docs/agents/code-flow.md` (single home, traced from code, includes stubs and gaps), `docs/humans/code-flow.md`, a row in `docs/agents/index.md`, a line in `docs/agents/working-rules.md`, and `.cursor/rules/code-flow.mdc` (globs `server/**, scripts/**, web/src/**, tapes/**`). `tests/test_code_flow.py` fails naming any `server/**/*.py`, `scripts/*.py`, or `web/src/` folder missing from the doc; checked with a temporary `scripts/tmp_x.py`.
- Tests: `tests/test_build_tape.py` (5, no network), `test_heather_replay_raises_the_floor_only_after_the_high_posting` in `tests/test_engine.py`, `tests/test_code_flow.py`. `pytest -q`: 62 passed. Not committed.
- Diagrams are mandatory: `docs/agents/code-flow.md` has an "At a glance" section (overview flowchart and one-tick sequence). `.cursor/rules/code-flow.mdc` and `working-rules.md` say a flow change updates the Mermaid diagrams in the same PR, never prose instead. `tests/test_code_flow.py` fails if the agents doc has fewer than 3 Mermaid blocks or the humans doc fewer than 1. All 5 blocks rendered with `@mermaid-js/mermaid-cli`. `pytest -q`: 63 passed.
- Rebased onto main after PR #7 and PR #9: `docs/agents/code-flow.md` re-traced (real allocate, zone acks, discharge, rollups, `var/state.json`, per-tick run writes, `persist_run.py`, the `scripts/live_cycle.py` worker and its `event=live` rows, the `/v1/snapshot` path through `archive.py`, `feeds.py`, `runtime.py`, `prices.py`, and the separate `orchestration.py` runner). `run()` keeps both PR #9's `frames`/`live_risk`/`live_price` and `baseline_path`. `docs/humans/code-flow.md` diagram updated. All 5 Mermaid blocks rendered. After PR #8, `pytest -q`: 336 passed.
- Open for owners:
  - Sunny owns `tapes/*.json`: OK `tapes/heather.json` or commit it. The whole `tapes/` folder (including `demo.json`) is untracked in git.
  - `docs/agents/improvements.md` and `docs/humans/improvements.md` are cited above but are not in the repo. Not recreated.
  - `docs/agents/team-manifest.md` says 1.7% out-of-sample; `data/margin_check.json` says 22 of 765 in-sample (about 2.9%) at +15%. Different measurements; Uma to confirm which one is said out loud.
  - `docs/agents/code-flow.md` "Stubs and gaps" lists code that differs from `CONSTRAINTS.md`: no `decision_line` in the run record, `load_tape` does not check labels or offsets, weather alerts are not wired into the loop.

## 2026-09-26: Engine persists to Supabase only with `--persist` (Uma)

- `server/engine/__main__.py`: `split_persist()` pulls `--persist` out of argv with `parse_known_args` (`allow_abbrev=False`) before `loop.main()`. `persist_after_run()` runs only with the flag, still inside the try/except, so the exit code never changes.
- `python -m server.engine --tape <tape>` with no flag makes zero network calls. Checked with sockets blocked: 0 connect attempts without the flag, 2 with it (exit 0 both times).
- `tests/test_persist_run.py`: the old entry test asserted persist ran with no flag, which is the behavior this change removes; it now passes `--persist` and checks that `loop.main` gets argv without it. New `test_engine_entry_without_persist_makes_no_network_calls` plays a real tape from `tmp_path` with sockets blocked.
- Docs: `docs/agents/persist-run.md`, `docs/humans/persist-run.md`, `docs/agents/code-flow.md` (both diagrams and text). `loop.py`, `policy.py`, `controller.py`, `fleet.py` untouched. `pytest -q`: 337 passed.

## 2026-09-26: `orchestration.run_cycle` renamed to `orchestrate_tick` (Rajat)

- `scripts/live_cycle.py` has its own `run_cycle(settings)` (the live worker). To stop the two being
  confused, the orchestrator's entry point is now `orchestrate_tick(homes, frame, policy, mode,
  settings, seed) -> CycleResult`. Same arguments, same behavior. `run_cycle` now means only the
  live worker.
- Updated: `server/engine/orchestration.py`, `server/engine/fleet.py` (comment),
  `tests/test_{orchestration,failures,invariants}.py`, `docs/agents/epic-3-controller.md`.
- Still say `orchestration.run_cycle` (Sunny's files, not edited): `server/engine/supervisor.py`
  line 12 comment, `docs/agents/zone-acks.md` line 7. Uma's file: `docs/agents/code-flow.md`
  lines 232 and 370.
- `pytest -q`: 327 passed. Runner output unchanged.
