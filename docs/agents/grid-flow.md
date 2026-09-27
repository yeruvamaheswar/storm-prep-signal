# Grid flow page (`/flow`)

**Decision (2026-09-26).** `/flow` is an animated view of the real engine playing one archive scenario a tick at a time. A session worker (`scripts/scenario_session.py`) is the only process that runs the engine for it. It runs on the laptop, or beside uvicorn in the Render instance (decided 2026-09-26, see "Run it on Render"). The `/v1/scenario*` routes only record operator requests and read the worker's output, as `CONSTRAINTS.md` "Backend" requires. Batteries start at a seeded random charge. The operator can send a real archived NWS alert, and the engine reacts on the next tick. The side panel names every archive row in use. JEV decides, county by county, whether an alert raises a floor (2026-09-26, later; see "JEV county gate"). Charging refills a battery only when the zone price is cheap; there is no refill at any other price.

People page: `docs/humans/grid-flow.md`. Motion rule: `DESIGN.md` section 7, `/flow` paragraph. Allocation and fields: `CONSTRAINTS.md` allocation step 7 and "Zones".

## Run it (laptop)

```bash
.venv/bin/uvicorn server.app:app --reload --port 8000     # API
(cd web && npm run dev)                                   # wall on :5173
.venv/bin/python scripts/scenario_session.py              # session worker; open http://localhost:5173/flow
```

- `--scenario <id> --seed <n>` starts a scenario right away. `--steps N` plays N ticks and exits (tests and smoke checks).
- The worker reads only committed files (`tapes/scenarios/`, `data/fixtures/`), so it runs without wifi. Stop it with Ctrl-C.
- The worker rewrites `var/scenario/state.json`. Stop it before running `pytest -q`; one replay test reads the same folder.

## Run it on Render

`render.yaml` starts the worker in the background, then `exec`s uvicorn, in the same instance: `python scripts/scenario_session.py & exec uvicorn ...`. The two talk through `var/scenario/`, so they must share a filesystem; a separate Render worker service would not. Deployed page: `https://storm-prep-signal.vercel.app/flow`.

- The service was not made from the Blueprint, so the start command is also set by hand in the Render dashboard (Settings, Start Command). Keep the two the same.
- Free plan: the instance sleeps after 15 minutes idle. That stops the worker too, and a wake starts from `idle` with no scenario. Press Start again.
- One instance means one shared session: everyone on the page sees and steers the same scenario.
- If the worker crashes, uvicorn keeps serving and the page shows "session worker not running" (state older than 10 s) until the next deploy or restart.
- Measured locally: about 30 MB each for the API and the worker, under the free plan's 512 MB.

## How one step flows

1. The page POSTs `start`, `reset`, `play`, `speed`, `step`, `alert`, or `grid-down` with `X-Operator-Id`. `server/api/scenario.py` appends it to `var/scenario/requests.json` and returns 202. `POST /v1/scenario/step` (Replay's Next tick) is recorded only while `state.json` reports `paused`: a missing or stale worker gets 409 `worker_not_running` first, any other status 409 `not_paused`.
2. The worker reads new requests (by `seq`), applies them to its `Session` (`server/engine/scenario.py`), and when the time-lapse clock says so, plays one frame through `loop.play_frame` with the session's own fleet. A `step` request plays exactly one frame and leaves the session paused (`Session.step_paused`; refused with no scenario, while playing, or after the last tick). Pace: see "Playback pace" below.
3. Each active alert adds its named roster counties, with their JEV P(yes) or null, to that frame's `events["weather_counties"]` (never whole zones to `events["weather"]`, so JEV gates each floor); grid-down zones go to `events["grid_down"]`. The engine then decides the tick with the usual rules.
4. The worker writes `var/scenario/state.json`: the tick (with `county_reserve_pct` and `county_reasons`), each home's `{id, name, zone, county, county_name, soc_pct, kw, state, floor_pct, floor_reason}` (`floor_reason` is the county's reason when it has one this tick, else the zone's), zone MW selling and charging, floors and reasons, that tick's provenance rows, active alerts with `jev` (the anchor county's reading) and `jev_by_county`, `counties` (the roster: `{zone, fips, name}`), overlays, the seed and starting-charge histogram, and a short history.
   - Each home row also carries `status` (the engine's own view) and `plan_status` (added 2026-09-26, Task 12): the status the planner used, taken at plan time (after the frame's status events, before orders go out), so a home that crashes mid-tick after its order reads `status "dead"` but `plan_status "live"`. With the telemetry feed on, the plan reads the batteries' reports (`telemetry.reported_homes`), so a home can be `status "live"` but `plan_status "stale"`; the planner gave it no order, and the tick's `homes_stale:N` counts it. Without the feed both are the same.
   - Each history point carries the tick's `intent` and `intent_reason` (added 2026-09-26, Task 12), copied from the tick, never re-derived. See `docs/agents/policy-intent.md` for the values.
5. The page polls `GET /v1/scenario/state` every 500 ms. A state file older than 10 s reads as `worker_not_running`.

Requests left over from an earlier worker are not replayed; the page asks again.

## Playback pace

Decision (Rajat): pause freezes the playhead where it is, and Play resumes the rest of that tick. Control follows the operator's orders; the clock never runs on behind a pause.

- One tick waits `tick_minutes*60 / speed` real seconds. `SPEEDS = (2.4, 4.8, 12, 15, 30, 60, 150, 300, 600)`, `DEFAULT_SPEED = 12` (25 s per 5-minute tick). 2.4 is real time: the 125 s order window plays at true speed. `POST /v1/scenario/speed` takes a float and returns 422 `bad_speed` for anything not in `SPEEDS`.
- Worker (`scripts/scenario_session.py`, `run`): a speed change mid-tick rescales only the time left (`rescale_next_step`), so the share already played is kept. Pause stores the time left in the tick; Play waits that remainder (rescaled if the speed changed while paused), so a pause never skips or shortens a tick and is never counted as play time. A `step` starts the stepped tick's full step at the step itself; Play during it waits only what is left of that step, and Play after it ran out goes straight on. This holds even when Next tick and Play land in the same worker poll: the stepped tick always gets a fresh step. A reset or new scenario forgets the remainder.
- `state.json` carries `tick_left_s` (add-only, written by the worker, not `Session.state()`): real seconds left in the tick while playing, the kept remainder while paused mid-tick, and null when no tick is running or frozen (idle, finished, after Next tick).
- Replay's playhead (`web/src/features/replay/tickClock.ts`, `advancePlayhead`) matches the worker: a speed change, a pause and a resume all re-anchor at the current position. Pause freezes the playhead (mode `frozen`); Play resumes from there. After Next tick the stepped tick's window plays once at the slider speed and holds at 2:00 (mode `step`); any forward move while paused counts as a step, so two quick steps in one poll do not jump to 2:00. The last tick of a finished scenario plays its window once the same way. A tick that lands just before a pause freezes where `tick_left_s` puts it; if `tick_left_s` is null (a Next tick pressed right after the pause) it plays as a step. A page opened mid-tick starts where `tick_left_s` puts it, and one resting at 2:00 follows it on Play, so the playhead can jump back from 2:00 to the worker's real position. `tick_left_s` is as of the state file's `updated_at`: while playing it can be up to 1 s old (the worker rewrites on a change or its 1 s heartbeat). With a worker that does not publish `tick_left_s`, those cases fall back to 0:00 and 2:00.
- Keys (`useReplayKeys.ts`): Space play/pause, `[` / `]` one stop slower/faster, `.` Next tick. They work with the speed slider focused (only text-entry fields block them), ignore key auto-repeat, and nudge from the speed just sent until the session reports it.

## Order timelines

`state.json` carries `orders` at the top level for Replay. It is a compact per-tick map:
`{home_id: [[t, kind, extra, key], ...]}`. `t` is virtual seconds inside the engine cycle,
rounded to 0.1. The first `sent` entry carries the signed planned kW as `extra` (negative means
charge). Confirmed and executed entries carry actual kW. A `mismatch` entry carries the
`reported_kwh` extra in kWh, not kW. Reassignments are logged on the original home with the new
home id as `extra`, and the new home has its own timeline starting with `sent`.

The fourth item, `key`, separates two command lifecycles that can belong to the same displayed
home in one tick. It is `"own"` for the home's own command id (`home:tick`) and `"r"` for a
reassigned-in command id (`home:tick:r`). Older readers may ignore it because the first three
items keep their original meaning.

The only order kinds in this UI contract are `sent`, `drop`, `exec`, `rdrop`, `retry`,
`reassigned`, `reassign_failed`, `dup`, `conf`, `timeout`, `mismatch`, and `late`. Telemetry and
transport-only noise stay out of `orders`; the raw orchestration log still lives on the cycle.

## Batteries

- `SCENARIO_FLEET_SIZE = 100` (25 per zone), so every battery can be drawn.
- Every start or reset draws each home's starting charge from `random.Random(seed)`, uniform over 10–95% of 25 kWh. The same seed replays the same fleet and the same ticks. `new_fleet` is unchanged, so other replays stay byte-identical.
- `seed_fleet` also gives each home a roster county, dealt in turn by its place within its zone (5 homes per Houston county, 6 or 7 per county elsewhere). The page names it `<Zone>-<County>-<NNN>`, e.g. `Houston-FortBend-005`; `home_id` stays `home-005`.
- Pack: 25 kWh, 11.4 kW (example settings, not Base specs). The page shows it in time-lapse and compares it with a Tesla Supercharger in a caption.
- States on the page: selling, charging, holding, reserved (floor raised by weather or risk), at floor (within 0.5% of it; nothing left to sell), below floor (never sells; refills from the grid at any price, so this state shows only when it cannot charge, e.g. operator HOLD), islanded (grid down), unconfirmed, stale, dead. Each below-floor battery says why: it started under the floor (random draw) or the floor rose above its charge.

## Charging

- A battery never sells below its floor. Under its floor it refills to the floor from the grid at any price (Rajat, 2026-09-26, latest; replaces the earlier price-only refill). Filling past the floor still happens only when the zone price is at or below `CHARGE_BELOW_USD` ($25). Rule: `docs/agents/policy-intent.md` "Refill to the floor". A refilling battery reads `charging` and keeps its `under_floor_why`.
- Each battery's kW comes from `tick_emit`, which counts both `confirmed` and `charge_confirmed` reports. Before 2026-09-26 (latest) it read only `confirmed`, so every charging battery showed 0 kW and "below floor" / HOLDING even while `charging_mw` said the fleet was charging.
- The worker clamps a charge order to `fleet.room_kw` = `min(max_kw, (capacity − soc) × 60 / tick_minutes)`, so a pack never fills past capacity. Charge is booked apart from delivery: `TickResult.charging_mw` and `zone_charging_mw`. It is never a breach.
- A charge order is sent once: never retried, never reassigned (kept from `main` #34 when this branch merged, chosen by the user on 2026-09-26). `CycleResult.charged_mw` (from #34) equals `charging_mw`. Telemetry reports `CHARGING` for negative power.
- Detail of the controller side: `docs/agents/policy-intent.md` and `docs/agents/epic-3-controller.md`.

## Weather alerts

- Four real archived NWS products, one file each under `data/fixtures/nws/<id>.json`, fetched from the Iowa Environmental Mesonet archive by `scripts/fetch_nws_alerts.py` (`--only <id>` for one). Every text field is verbatim; only zone codes were turned into county FIPS through the NWS zone-county correlation file. Each file carries its `source_url`.
- The worker maps county codes to roster counties (`fleet.ZONE_COUNTIES`), and so to load zones. Codes that match no roster county are logged and ignored. An alert applies from the tick after it was sent until its `expires`, in scenario time. Which of its counties' floors rise is the JEV county gate, below.
- Which alerts a scenario offers is the `alerts` list in `tapes/scenarios/catalog.json`. `build_scenarios.py` keeps that list on a rebuild.
- The plan named a Beryl Hurricane Warning for Harris and a Heather Winter Storm Warning. Neither exists in the archive for these counties. Beryl uses the real Harris Tropical Storm Warning; Heather uses the real Dallas and Harris Hard Freeze Warnings. No text was invented.

## JEV county gate

**Decision (2026-09-26, later; replaces "JEV shadow reading").** JEV decides which homes in an alerted zone keep more backup. When an alert names a home's county, JEV yes raises that county to the storm reserve, JEV no keeps it at base, and no reading fails safe to the storm reserve. A county in the same zone that the alert does not name keeps base. ERCOT HIGH and a missing outage signal still raise every county. Exact reasons and precedence: `CONSTRAINTS.md`, `reserve_policy` row and "Zones".

- **Roster.** `fleet.ZONE_COUNTIES` is a simulation roster, anchor county first: 5 Houston counties, 4 each in North, West and South. It is not ERCOT's county map. A zone missing from it gets one county, its `ZONES` anchor, named by its FIPS.
- **Readings.** One file per alert and county: `data/fixtures/jev/<alert_id>/<fips>.json`. The session reads them when the alert is sent (`scenario.load_jev`); `alerts[].jev_by_county[fips].decision` is `raise`, `keep_base` or `raise_no_reading`, from the reading alone. The engine only ever sees the numbers, through `events["weather_counties"]`.
- **Recording.** `scripts/jev_shadow.py` (needs `JEV_API_KEY` in `.env`):
  - `--alert <id>` records the anchor county of the alert's one zone.
  - `--alert <id> --county <fips>` records one roster county the alert names.
  - `--alert <id> --all-counties` records every named roster county with no file yet. A failure stops the run; run it again to retry the rest. A county with no file fails safe to the storm reserve.
  - The question sent carries that county's FIPS and name (`FIPS 48157 (Fort Bend)`) and its load zone; new files add `county_fips`. With no arguments the script still writes `data/fixtures/jev_harris.json`, which the session does not read.
- **Recorded answers** (`jev-1.13.0`; the four anchor readings are the earlier per-alert files, moved):

| Alert | County: P(yes) | Floor it gives |
|---|---|---|
| `beryl-harris-tropical-storm-warning` | Harris 48201: 0.74 | 60% (the only county Beryl names) |
| `heather-harris-hard-freeze-warning` | Harris 0.07, Fort Bend 0.06, Brazoria 0.07, Galveston 0.07, Montgomery 0.07 | 30% everywhere |
| `heather-dallas-hard-freeze-warning` | Dallas 0.12, Tarrant 0.14, Collin 0.14, Denton 0.15 | 30% everywhere |
| `tuning2026-midland-flash-flood-warning` | Midland 0.24, Ector 0.19 (Tom Green and Taylor not named) | 30% everywhere |

- **Limits.** The page prints the first one from `HONEST_LIMITS`.
  - Readings are recorded once per alert and county, not called live.
  - The roster and its county-to-zone mapping are approximate.
  - A partly alerted zone stops price selling for the whole zone (zone reason `weather_alert`), even in counties kept at base.
  - With these readings, the Heather and Midland alerts raise no floor, because JEV said no for every county. Beryl raises the 5 Harris homes only; the other 20 Houston homes stay at 30%.

## Grid down

- An operator overlay, offered only when the catalog entry has `grid_down_overlay: true` (Beryl). The "Weather step" control sends none, alert, or alert plus grid down.
- Engine rule: `CONSTRAINTS.md` allocation step 7. The worker also runs 0 for any order reaching a down zone, telemetry marks those homes `grid: "down"`, and `TickResult.grid_down_zones` lists the zones.

## Scenarios

`tapes/scenarios/catalog.json` is the list (id, window, summary, label, tape, baseline, provenance sidecar, alerts, `grid_down_overlay`). Heather reuses `tapes/heather.json`; the rest are built by `scripts/build_scenarios.py [--only <id>]` from Supabase (`SUPABASE_URL`, `SUPABASE_SECRET_KEY` in the root `.env`). If Supabase fails it prints `build_scenarios_skipped: <reason>` and writes nothing.

- The grid ask on built tapes is `synthetic:price-shaped`: straight lines through $25 → 0.02 MW, $60 → 0.2 MW, $500 → 1.0 MW, flat beyond; 0.2 MW with no price. A cheap hour asks 0.02 MW; a few homes serve it and the rest charge (`docs/agents/policy-intent.md`). Heather keeps its flat 0.2 MW `synthetic` target.
- Hand-placed events (withheld postings, faults, operator HOLD, grid down) are labeled as overlays in the sidecar, the catalog label, and the tape label.
- `price-spike` and `operator-hold` start at the price run-up on purpose. Starting earlier, the fleet sold into the $100–$400 run-up and reached its floor before the peak, because the rules do not look ahead.
- Real posting gaps never read as `signal_unavailable` (the builder uses the newest earlier posting), so `feed-failure` withholds postings by hand.
- With the random starting charge, the most the fleet can deliver is about 0.65 MW, not the 1.14 MW cap.

Each provenance sidecar lists, per tick: the posting row (`id`, `report`, `posted_at`, `file_name`, `event`), each zone's price row (`settlement_point`, `interval_ending`, `price_usd_mwh`; `ercot_prices` has no `id` column), and any overlay text.

## Verify against Supabase

`GET /v1/scenario/verify?event=&clock=` reads the posting and zone prices at the tick's clock with the tape's own rules: the newest posting at or before the clock, and the price interval holding the clock (newest `interval_ending ≤ clock + 15 min`). The page compares the exact `posted_at` and each zone price (within $0.005) and shows match or differs.

**Known setup gap.** `server/env.py` loads `server/.env`, which does not exist on this laptop; the Supabase keys live in the root `.env`. So the API's archive reads, including Verify, return 503 `archive_no_config` until the keys are in `server/.env` or the shell. The scripts read the root `.env` and are unaffected. No secret was moved.

## Honest limits

The page prints them from `HONEST_LIMITS` in `server/engine/scenario.py`. That tuple is their one home.

## Tests

`tests/test_scenario_session.py`, `tests/test_scenario_alerts.py`, `tests/test_jev_county_floor.py`, `tests/test_build_scenarios.py`, `tests/test_grid_down.py`, the charge tests in `tests/test_orchestration.py` and `tests/test_invariants.py`, and `web/tests/flow.test.ts`.
