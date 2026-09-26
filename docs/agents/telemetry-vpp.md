# Telemetry feed and Base-like battery model (Rajat's lane)

Open this file when a task touches the battery telemetry feed, per-home state, the zone or plant rollups, grid-down backup, or charge planning. The visual version is the "ReserveGate Telemetry Model" artifact. The research behind every number here is in Rajat's report `ReserveGate_Telemetry_Research_20260926` (38 sources). Ask Rajat for it; it is not in the repo.

## Decisions

1. **VPP control logic (simulated batteries and network).** Two things are simulated: the battery packs and the network. Everything else is the virtual power plant (VPP) we are building. With real Base hardware, only the simulated side is replaced.
2. **The controller sees only what batteries report.** It plans from `HomeState` (the latest trusted reading per battery), never from a battery's true charge.
3. **Every reading uses the OpenTelemetry metrics layout** (metric names, units, resource attributes), built from plain Python dicts. No new dependency. Pitch line: "follows the OpenTelemetry metrics data model; a real OTel exporter is a transport change."
4. **Mirror Base's published behavior** where it exists: one resource per load zone, a 5-minute dispatch interval, stale after 180 s, a reserve for home backup, and batteries kept fuller when outage risk is high.
5. **Our lane reads no network or database.** Uma's engine turns ERCOT data (live or from Supabase) into `Policy` and `TapeFrame`. We read only those two. `price_usd_mwh` and the floors arrive through them.
6. **Frozen contracts stay frozen.** `allocate` and `discharge` keep their signatures. New data travels in new records and in optional arguments. We rename nothing in `contracts.py`.
7. **Cut order, bottom first:** (1) feed, intake, HomeState and rollups; (2) grid-down backup with household load; (3) charge planner.
8. **Two views of every battery, never mixed.** The simulator's `Home` objects hold the truth. `HomeWorker`, `discharge` and the breach count use only those. `HomeState` holds what was reported. `allocate` and the rollups use only that. `reported_homes` returns new objects, never the simulator's own.
9. **Energy truthing is checked per tick, not per reading, tonight.** Orders move a battery's charge all at once when they execute, so a 10-second check would flag honest homes. The per-reading check is P2.

Reviewed by Codex on 2026-09-26 (`.claude/council-cache/council-1790445304.md`). Decisions 8 and 9 and the changes to R1–R8 come from that review.

## Problem

ReserveGate has no real batteries. Today a home's charge is exact and known to the controller, and whether it is live, stale or dead is written into the tape. A real fleet reports over an unreliable network: readings arrive late, repeated or not at all, and some are wrong. The Orchestration track is judged on how the system holds up when pieces fail. Without a feed, we cannot show the controller coping with the thing that fails most in a real VPP, the data itself. Australia's VPP trials lost 5–8% of fleet telemetry at any moment [assumed (unsourced)], and 1.4–7.7% of batteries ignored a given order in a PG&E pilot [assumed (unsourced)].

## Goals

1. Every battery reports continuously: each home every 10 virtual seconds, which is 3,000 readings per 5-minute tick across 100 homes. That is a demo rate, slower than the sub-second telemetry Base says it runs.
2. A home that goes silent is marked stale within 190 virtual seconds (the 180 s stale rule plus one reading interval), and gets no work from the next plan.
3. A battery whose numbers do not add up is flagged `suspect` at the end of the tick in which it lied, and gets 0 kW from the next tick on.
4. 0 floor breaches across the fuzzer (30 seeds by default, more on request with `TELEMETRY_FUZZ_SEEDS`, e.g. `TELEMETRY_FUZZ_SEEDS=50`) with the feed and all faults switched on.
5. The operator gets one plant view (per zone and in total), and the backend keeps every battery's state and reading counters.

## Non-goals

- **A real MQTT or OTLP transport, or a collector.** It adds nothing visible in a 5-minute video, and the data is synthetic either way.
- **Any Supabase or ERCOT call from our code.** That is the engine's job (Uma), and it keeps our code pure and replayable.
- **Market bidding, settlement or payments.** Out of our lane and our time.
- **Modeling ERCOT's 2-second ICCP telemetry.** We say so out loud.
- **Screen or API changes.** `web/` and `server/api/` belong to Sunny.

## Data model

Units: kWh, kW (+ = discharging), virtual seconds. Each OTel name is shown next to its field.

**BatteryResource** is fixed for a battery's life (the OTel Resource). It comes from the existing `Home`, plus defaults.

| Field | Source | OTel |
|---|---|---|
| `home_id`, `zone`, `capacity_kwh`, `max_kw` | `Home` | `hw.id`, `ercot.load_zone`, `hw.battery.capacity` |
| `chemistry="LFP"`, `vendor="synthetic"`, `data_label="synthetic"` | constants | `hw.battery.chemistry`, `hw.vendor` |

**Reading** is one sample every 10 virtual seconds.

| Field | Meaning | OTel or standard |
|---|---|---|
| `home_id`, `boot_id`, `seq` | dedup key; `seq` increases by 1 per reading and restarts on reboot | idempotent ingestion |
| `device_ts` | the battery's clock, which can be skewed | `time_unix_nano`, IEEE 2030.5 `readingTime` |
| `ingest_ts` | our clock, set by the intake | — |
| `soc_kwh` | reported charge | `hw.battery.charge` = `soc_kwh / capacity_kwh` {1} |
| `power_kw` | + discharging, − charging | `hw.power` (W) |
| `charge_state` | `CHARGING`, `DISCHARGING`, `HOLDING`, `FULL` or `EMPTY` | SunSpec `ChaSt` |
| `grid` | `connected` or `down` | Tesla `grid_status` |
| `health` | `ok`, `degraded` or `failed` | `hw.state` |

**HomeState** is the backend's view of one battery. It persists across ticks. It holds `last` (the latest accepted Reading), `last_seen` (its `ingest_ts`), `boot_id`, `last_seq`, `suspect`, `pre_tick` (the reading held when this tick's plan was made), and counters `dups`, `late` and `rejected`. Status is not stored: it is computed by `data_status()` from data age each time it is needed.

The **data status** is derived from data age: 180 s or less is `live`, over 180 s is `stale`, over 600 s is `dead`, and a failed energy check is `suspect` (sticky for the run). The data status is separate from the tape's status on the simulator `Home` (see R4).

**ZoneRollup** is one per zone per tick (the "ADER partition"). It holds `homes` (total, live, stale, dead, suspect), `soc_mwh`, `floor_mwh`, `available_mw` (the sum of safe caps over live homes, from reported data), `delivering_mw`, `grid_down` (bool), `coverage` (share of homes live), `max_data_age_s` and `data_label`.

**PlantRollup** is the sum of the zones, the same fields plus `zones: {name: ZoneRollup}`.

**FeedStats** holds the per-tick counts `received`, `accepted`, `duplicates`, `late`, `rejected`, `dropped` and `cut_at_tick_end`.

## Requirements

### P0: feed, intake, HomeState, rollups (cut line 1)

**R1. Feed on the virtual clock.** Each home sends a Reading every `telemetry_every_s` (default 10) through `channel.py`, on the same `Scheduler` as the orders. The first reading is offset by a seeded amount, so homes do not all report at once. `Channel.send` requires a `command_id`, so each reading message carries `command_id = "telemetry:{home_id}:{boot_id}:{seq}"`. That id is for channel logging only; `channel.py` does not change.

Before the first tick, every battery registers with one reading, so tick 1 plans from a report.
- [ ] Given seed S, two runs produce identical readings, faults and rollups.
- [ ] 100 homes produce about 3,000 readings per 300 s tick.

**R2. Fault injection.** The faults are seeded and each can be switched off. Each rate carries a `sourced` or `assumed` label in the run output.

| Fault | Default | Basis |
|---|---|---|
| outage (home silent for a window) | 5% of homes | assumed (unsourced): AEMO 5–8% |
| order ignored | 3% of orders | assumed (unsourced): PG&E 1.4–7.7% |
| duplicate | 1% | assumed |
| late or out-of-order, 10–120 s | 2% | assumed |
| clock skew | ±2 s per home | assumed |
| lying battery | 1 planted home, reported charge frozen | demo case |

Order ignored: covered by the existing command channel faults and by offline homes ignoring orders. No separate 3% fault tonight. Late readings use `telemetry_late_extra_s` = 60 s. Test knobs: `telemetry_outages`, `telemetry_liar_ids`.

The reboot fault (a new `boot_id` with `seq` restarting) is cut for tonight and moved to P2. The intake still handles a new `boot_id` correctly (R3).

**R3. Intake.**
- [ ] Skips a reading whose `(home_id, boot_id, seq)` it has already seen, and counts it in `dups`.
- [ ] A reading with a lower `seq` than the one held, in the same boot, is `late`. It is counted and logged, and never replaces `last` or moves `last_seen`.
- [ ] Rejects impossible values (`soc_kwh < 0` or `> capacity_kwh`).
- [ ] A new `boot_id` resets `seq` tracking and is not treated as a duplicate.

**R4. Status from data age** (the thresholds from HomeState above).
- [ ] Given a home silent since `t`, at `t + 181` it is `stale`, and at `t + 601` it is `dead`.
- [ ] A stale, dead or suspect home gets 0 kW from `allocate`.
- [ ] **Data-age stale or dead revives:** a new accepted reading makes the home `live` again.
- [ ] **Tape-dead and suspect do not revive:** a home the tape marked `dead` or `stale`, or one flagged `suspect`, stays out of planning even if readings arrive. The planning status is the worse of the tape status and the data status.

**R5. Energy check (suspect), per tick.** For each home that confirmed an order this tick: expected charge = the charge in `pre_tick` (`pre_tick["soc_kwh"]`) − confirmed actual_kw × tick_minutes / 60. The expected charge is compared with the latest reported charge at the end of the tick (300 s). A difference of more than 0.1 kWh (setting `suspect_kwh`; 0.1 kWh over a 5-minute tick catches a lie of 1.2 kW or more, and honest simulated homes match exactly) marks the home `suspect`. Checked only when both readings were sent at least 5 s after a books close (this covers ±2 s clock skew). Homes with no fresh reading before and after the tick are skipped, not flagged. The continuous 10-second check is P2.
- [ ] The planted lying battery is flagged at the end of its first tick with a confirmed order of 1.2 kW or more.
- [ ] Across 30 seeds, no honest home is ever flagged.
- [ ] A home that was silent all tick is not flagged.

**R6. Plan from reported data, with the truth kept separate.** `reported_homes(state, homes) -> list[Home]` builds **new** `Home` objects, with `soc_kwh` taken from `last` and `status` mapped as follows: `live` becomes `live`, `stale` or `suspect` becomes `stale`, and `dead` becomes `dead`, combined with the tape status as in R4. `allocate` runs on these copies, unchanged. Who uses what:
  - `allocate` and the rollups use reported data only (`reported_homes`, `HomeState.last`).
  - `HomeWorker`, `discharge`, the floor clamp and the breach count use the simulator's true `Home` objects only.
  - A wrong report can therefore cause a missed target, but never a breach.

Reassignment at the 60 s deadline (`ZoneSupervisor.pick_home`) also reads the plan's reported copies (`rt.plan_view`), never the simulator's truth.
- [ ] No object returned by `reported_homes` is the same object as a simulator `Home` (an identity test).
- [ ] `allocate` is never called with the simulator's own `Home` objects when the feed is on.
- [ ] Mutating a reported copy never changes a simulator `Home`.

**R7. Rollups and FeedStats** are computed once per tick from `HomeState`. `CycleResult` gains three optional fields: `plant: dict`, `zones: dict` and `feed: dict`, each with `default_factory=dict`. They stay empty when the feed is off. Their keys are add-only.
- [ ] The plant totals equal the sum of the zone totals, within 1e-9.
- [ ] With no telemetry, `plant`, `zones` and `feed` are `{}`.

**R8. Continuity across ticks, and a feed that stops at the tick's end.** A `TelemetryState` object holds every HomeState, the fault schedule and the running counters. It is passed into each cycle. Readings reschedule themselves, so an unbounded drain would never end. With the feed on, `orchestrate_tick` runs in three steps:
  1. `run_until(cycle_close_s)`, default 120 s: the command books close as today (`rt.closed = True`). After close, command reports are logged as late and never booked, as today.
  2. `run_until(tick_seconds)`, default 300 s: telemetry keeps sending and ingesting until the end of the tick. Then the feed is stopped: no new reading is scheduled, and a reading still in flight is discarded and counted in `FeedStats.cut_at_tick_end`.
  3. The existing `run_until(math.inf)` drain, unchanged. Only command events remain, so it ends. The tick-boundary energy check (R5) and the rollups (R7) run after this step.

  With no telemetry, only steps 1 and 3 run, exactly as today.
- [ ] With the feed on, the drain ends, and no reading is ingested after 300 s.
- [ ] `orchestrate_tick(...)` with no telemetry argument gives the same `CycleResult` as today, and every existing test passes unchanged.

### P1: grid-down backup with household load (cut line 2)

**R9. Grid down.** The tape event `"grid_down": ["Houston", ...]` (zone names) marks those zones' homes `grid="down"`. A grid-down home is not dispatchable: `allocate` sees it as `stale`, and its skip reason is recorded as `grid_down`.
- [ ] Given Houston grid down, Houston delivers 0 MW and the other zones carry the target, up to their caps.

**R10. Household load.** Each home draws a seeded daily curve of about 0.5–1.5 kW. It is labeled assumed. With the grid up, the home draws from the grid and the battery is unaffected. With the grid down, the battery serves the home. **The backup reserve exists for this**, so charge below the floor while powering its own home is **not** a breach. A breach counts only energy the VPP sold below the floor.
- [ ] Energy balance per home: charge change = −(sold + home load served) + charged × 0.89, within 1e-6 kWh.

### P1: charge planner (cut line 3)

**R11. `plan_charge(homes, frame, policy, settings) -> dict[home_id, kw]`**, a pure function in `controller.py` (no I/O, no clock, never mutates homes). Charging draws from the grid at `max_kw` or less, and at 89% round-trip efficiency (Powerwall 3 datasheet). It charges a live, grid-up home that is not dispatched this tick when either condition holds:
  - (a) **Storm prep:** the zone floor is raised (a storm, weather or signal-unavailable reason), and the home is below `storm_fill_pct` (default 95). This mirrors Base keeping batteries fuller when outage risk is high.
  - (b) **Cheap power:** `frame.price_label != "none"` and `frame.price_usd_mwh < charge_below_usd_mwh` (default 25, labeled example).
- [ ] With no price and no storm, it charges nobody.
- [ ] A home never charges and discharges in the same tick.
- [ ] 0 breaches is unchanged, because charging only raises charge.

### P2: future, designed for but not built

A real OTLP exporter; the continuous 10-second energy check (it needs orders to move a battery's charge over time instead of all at once); the reboot fault; per-home temperature and derating; charge estimate drift; the 2-second aggregate telemetry; real load-zone prices (awaiting Uma's price ingest); state of health.

## How it plugs in (for Uma's agent)

- `orchestrate_tick(homes, frame, policy, mode, settings, seed, telemetry=None) -> CycleResult`. With a `TelemetryState` passed, the result's new fields `plant` (PlantRollup), `zones` and `feed` (FeedStats) are filled. Without one, they are `{}` and nothing else changes.
- The engine creates one `TelemetryState` per run with `telemetry.new_state(homes, settings, seed)` and passes it into every tick.
- The engine's run file can add `plant`, `zones` and `feed` to each tick (fields are add-only), and `totals.feed` at the end.
- The TEMP stand-ins in `loop.py` still need to be replaced with our `new_fleet`, `apply_events`, `allocate` and `discharge`. That is the biggest blocker for the demo.

## For Sunny's agent (screen and API)

- **The wall's top row is `plant`:** live over total, MWh stored (as reported), MW available, MW delivering, coverage, and oldest data age. Every value keeps `data_label: "synthetic"`.
- **Fleet squares:** color by HomeState `status` (`live`, `stale`, `dead`, `suspect`). `/v1/homes/{id}` can show `last_seen`, the last reading and the counters.
- **A feed-health strip:** `received`, `duplicates`, `late`, `rejected` per tick.
- **Tapes:** add `"grid_down": ["Houston"]` to a Beryl-window frame to show backup.

## Asks

| Who | Ask | Blocks |
|---|---|---|
| Uma | Approve `server/engine/telemetry.py` (new file, Rajat's), alongside `scheduler.py`, `channel.py` and `orchestration.py` | merge |
| Uma | Replace the TEMP stand-ins in `loop.py`, create one `TelemetryState` per run and pass it in | demo |
| Uma | Add settings to `.env.example`: `TELEMETRY_EVERY_S=10`, `STALE_AFTER_S=180`, `DEAD_AFTER_S=600`, `CHARGE_BELOW_USD_MWH=25`, `STORM_FILL_PCT=95`. Until then these are defaults in our code. | nothing |
| Uma | Optional: set `HOME_KWH=39.2` to match Base Core (an example setting, not a Base spec) | nothing |
| Sunny | Tape event key `grid_down` (a list of zone names) | the demo of R9 |
| Sunny | Show `plant`, `zones`, `feed` and the `suspect` status on the wall and in `/v1` | anything on screen |

## Success metrics

| Metric | Target | How measured |
|---|---|---|
| Floor breaches, feed and all faults on | 0 over 30 seeds (more with `TELEMETRY_FUZZ_SEEDS=50`) | `tests/test_telemetry.py::test_fuzz_with_feed_never_breaches_and_never_blames_an_honest_home` |
| Stale detection | at most 190 s after the last reading | test R4 |
| Lying battery caught | at the end of its first tick with a confirmed order of 1.2 kW or more | test R5 |
| False suspects | 0 over 30 seeds | `tests/test_telemetry.py::test_fuzz_with_feed_never_breaches_and_never_blames_an_honest_home`, with `TELEMETRY_FUZZ_SEEDS` (default 30) |
| Replayability | same seed, byte-identical run file | test R1 |
| Speed | 30-seed fuzz under 30 s on a laptop; measured 3.14 s | `pytest -q` timing |

## Open questions

- **Engineering (Rajat, non-blocking):** should a home that drops offline mid-tick keep executing its last order (the real-device behavior) or hold? Default: it keeps executing until the tick ends, and the floor guard still applies.
- **Uma (non-blocking):** should `suspect` become a contract status, or stay a HomeState-only status mapped to `stale`? Default: HomeState only.
- **Uma (blocks R11 with real prices only):** when will load-zone prices land in Supabase, and in which `TapeFrame` field (`price_usd_mwh` per zone, or one fleet price)?

## Timeline (CT)

- **Sat 9:00 PM feature freeze:** cut line 1 done and green. Cut lines 2 and 3 only if cut line 1 is green by about 5 PM.
- **Sun 9:30 AM code freeze:** fixes and docs only.
- **Work order:** merge `controller-rajat-dev` into `rajat/telemetry` (the lane code is not on `main` yet). Then use strict TDD (red, green, refactor), running `pytest -q` after each step, in this order:
  1. `telemetry.py` records and the intake (duplicates, late readings, rejects, new `boot_id`).
  2. `reported_homes` (the identity test) and `allocate` on reported copies.
  3. Status from data age (181 s, 601 s, revive, and no revive for tape-dead).
  4. The feed stopping at 300 s inside `orchestrate_tick` (the drain ends; with no feed, the result is identical to today's).
  5. The rollups and FeedStats (sum test).
  6. The tick-boundary lying-battery test.
  7. The existing tests unchanged, then the fuzzer with the feed on.

## Honest limits (say out loud)

- The batteries, the network, the household load, the fault rates marked assumed, and the price threshold are all synthetic or example values.
- Base figures (180 s stale, one resource per zone) come from Base's own blog. Say "Base says".
- We do not connect to ERCOT ICCP, and we do not model the 2-second aggregate telemetry.
- Say "OpenTelemetry-shaped metrics over a simulated transport". There is no exporter or collector.
- The zone and plant rollups are operator health views, not ERCOT settlement-grade telemetry. ADER does not require per-home telemetry at our cadence.
- Suspect detection is checked once per tick, not on every reading.
- The feed shares each tick's seeded random stream with the command channel, so the same seed with and without `--telemetry` sees different command faults; replay of either run is still exact.
