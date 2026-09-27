# Grid flow page (`/flow`)

**Decision (2026-09-26).** `/flow` is an animated view of the real engine playing one archive scenario a tick at a time. A laptop session worker (`scripts/scenario_session.py`) is the only process that runs the engine for it. The `/v1/scenario*` routes only record operator requests and read the worker's output, as `CONSTRAINTS.md` "Backend" requires. Batteries start at a seeded random charge. The operator can send a real archived NWS alert, and the engine reacts on the next tick. The side panel names every archive row in use. JEV is a shadow reading and never dispatches. Charging refills a battery only when the zone price is cheap; there is no refill at any other price.

People page: `docs/humans/grid-flow.md`. Motion rule: `DESIGN.md` section 7, `/flow` paragraph. Allocation and fields: `CONSTRAINTS.md` allocation step 7 and "Zones".

## Run it (laptop)

```bash
.venv/bin/uvicorn server.app:app --reload --port 8000     # API
(cd web && npm run dev)                                   # wall on :5173
.venv/bin/python scripts/scenario_session.py              # session worker; open http://localhost:5173/flow
```

- `--scenario <id> --seed <n>` starts a scenario right away. `--steps N` plays N ticks and exits (tests and smoke checks).
- The worker reads only committed files (`tapes/scenarios/`, `data/fixtures/`), so it runs without wifi. Stop it with Ctrl-C.
- On Render there is no worker, so the page shows "session worker not running". This is expected.
- The worker rewrites `var/scenario/state.json`. Stop it before running `pytest -q`; one replay test reads the same folder.

## How one step flows

1. The page POSTs `start`, `reset`, `play`, `speed`, `alert`, or `grid-down` with `X-Operator-Id`. `server/api/scenario.py` appends it to `var/scenario/requests.json` and returns 202.
2. The worker reads new requests (by `seq`), applies them to its `Session` (`server/engine/scenario.py`), and when the time-lapse clock says so, plays one frame through `loop.play_frame` with the session's own fleet.
3. Active alert zones are added to that frame's `events["weather"]`; grid-down zones go to `events["grid_down"]`. The engine then decides the tick with the usual rules.
4. The worker writes `var/scenario/state.json`: the tick, each home's `{soc_pct, kw, state, zone}`, zone MW selling and charging, floors and reasons, that tick's provenance rows, active alerts with their JEV reading, overlays, the seed and starting-charge histogram, and a short history.
5. The page polls `GET /v1/scenario/state` every 500 ms. A state file older than 10 s reads as `worker_not_running`.

Requests left over from an earlier worker are not replayed; the page asks again.

## Order timelines

`state.json` carries `orders` at the top level for Replay. It is a compact per-tick map:
`{home_id: [[t, kind, extra], ...]}`. `t` is virtual seconds inside the engine cycle, rounded to
0.1. The first `sent` entry carries the signed planned kW as `extra` (negative means charge).
Confirmed and executed entries carry actual kW. Reassignments are logged on the original home
with the new home id as `extra`, and the new home has its own timeline starting with `sent`.

The only order kinds in this UI contract are `sent`, `drop`, `exec`, `rdrop`, `retry`,
`reassigned`, `reassign_failed`, `dup`, `conf`, `timeout`, `mismatch`, and `late`. Telemetry and
transport-only noise stay out of `orders`; the raw orchestration log still lives on the cycle.

## Batteries

- `SCENARIO_FLEET_SIZE = 100` (25 per zone), so every battery can be drawn.
- Every start or reset draws each home's starting charge from `random.Random(seed)`, uniform over 10–95% of 25 kWh. The same seed replays the same fleet and the same ticks. `new_fleet` is unchanged, so other replays stay byte-identical.
- Pack: 25 kWh, 11.4 kW (example settings, not Base specs). The page shows it in time-lapse and compares it with a Tesla Supercharger in a caption.
- States on the page: selling, charging, holding, reserved (floor raised by weather or risk), at floor (within 0.5% of it; nothing left to sell), below floor (never sells, refills when power is cheap), islanded (grid down), unconfirmed, stale, dead. Each below-floor battery says why: it started under the floor (random draw) or the floor rose above its charge.

## Charging (price-only refill)

- A battery never sells below its floor. It refills only when the zone price is at or below `CHARGE_BELOW_USD` ($25), the same rule as the wall. At other prices a below-floor battery waits. The user chose this on 2026-09-26; there is no "refill at any price".
- The worker clamps a charge order to `fleet.room_kw` = `min(max_kw, (capacity − soc) × 60 / tick_minutes)`, so a pack never fills past capacity. Charge is booked apart from delivery: `TickResult.charging_mw` and `zone_charging_mw`. It is never a breach.
- A charge order is sent once: never retried, never reassigned (kept from `main` #34 when this branch merged, chosen by the user on 2026-09-26). `CycleResult.charged_mw` (from #34) equals `charging_mw`. Telemetry reports `CHARGING` for negative power.
- Detail of the controller side: `docs/agents/policy-intent.md` and `docs/agents/epic-3-controller.md`.

## Weather alerts

- Four real archived NWS products, one file each under `data/fixtures/nws/<id>.json`, fetched from the Iowa Environmental Mesonet archive by `scripts/fetch_nws_alerts.py` (`--only <id>` for one). Every text field is verbatim; only zone codes were turned into county FIPS through the NWS zone-county correlation file. Each file carries its `source_url`.
- The worker maps county codes to load zones through `ZONES`. Codes that match no zone are logged and ignored. An alert applies from the tick after it was sent until its `expires`, in scenario time, and raises only its zones' floors to `storm_reserve_pct`.
- Which alerts a scenario offers is the `alerts` list in `tapes/scenarios/catalog.json`. `build_scenarios.py` keeps that list on a rebuild.
- The plan named a Beryl Hurricane Warning for Harris and a Heather Winter Storm Warning. Neither exists in the archive for these counties. Beryl uses the real Harris Tropical Storm Warning; Heather uses the real Dallas and Harris Hard Freeze Warnings. No text was invented.

## JEV shadow reading

- One recorded reading per alert: `data/fixtures/jev/<id>.json`, written by `scripts/jev_shadow.py --alert <id>` (needs `JEV_API_KEY` in `.env`). With no arguments the script still writes `data/fixtures/jev_harris.json` as before.
- The session attaches the reading to the alert when it is sent; the side panel shows it next to the rule's floor. A test proves the ticks are identical with and without the readings folder.

## Grid down

- An operator overlay, offered only when the catalog entry has `grid_down_overlay: true` (Beryl). The "Weather step" control sends none, alert, or alert plus grid down.
- Engine rule: `CONSTRAINTS.md` allocation step 7. The worker also runs 0 for any order reaching a down zone, telemetry marks those homes `grid: "down"`, and `TickResult.grid_down_zones` lists the zones.

## Scenarios

`tapes/scenarios/catalog.json` is the list (id, window, summary, label, tape, baseline, provenance sidecar, alerts, `grid_down_overlay`). Heather reuses `tapes/heather.json`; the rest are built by `scripts/build_scenarios.py [--only <id>]` from Supabase (`SUPABASE_URL`, `SUPABASE_SECRET_KEY` in the root `.env`). If Supabase fails it prints `build_scenarios_skipped: <reason>` and writes nothing.

- The grid ask on built tapes is `synthetic:price-shaped`: straight lines through $25 → 0.02 MW, $60 → 0.2 MW, $500 → 1.0 MW, flat beyond; 0.2 MW with no price. A cheap hour asks 0.02 MW, not 0, because `allocate` returns before its charge step on a zero target. Heather keeps its flat 0.2 MW `synthetic` target.
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

`tests/test_scenario_session.py`, `tests/test_scenario_alerts.py`, `tests/test_build_scenarios.py`, `tests/test_grid_down.py`, the charge tests in `tests/test_orchestration.py` and `tests/test_invariants.py`, and `web/tests/flow.test.ts`.
