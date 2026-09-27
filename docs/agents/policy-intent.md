# Charge / hold / discharge intent

**Decision (2026-09-27, user): above its floor, each load zone charges in its cheapest upcoming ERCOT day-ahead (DAM) hours, not whenever its price is at or below $25.** Selling, the storm cap and refill to the floor do not change. Since 2026-09-27 (later, user) the hours are chosen only before the next sell-band hour, so a zone never waits past a price spike. It is still not a net win in every replay: `heather-spike` nets $24 less than the old bands, `heather-thaw` about the same. See "Cheapest DAM hours" below.

**Decision (2026-09-26, latest): a battery under its reserve floor charges back to that floor from the grid, at any price.** Rajat chose this; it replaces "refill is price-only". The point is to have the reserve in place before a storm lands: a weather alert or HIGH risk raises the floor to `storm_reserve_pct`, and every live, grid-up home under it refills, even at $60+. See "Refill to the floor" below.

**Decision (2026-09-26, later): the tick's label shows what the fleet was ordered to do this tick.** It is the order, not the result: if every discharge order times out, the tick still says discharge and `delivered_mw` shows the shortfall. `TickResult.intent` / `intent_reason` come from `controller.acted_intent(alloc, policy, mode)`, which reads the planned `cycle.allocation`, not the price band. `Policy.intent` is still the price band below and is still what `allocate` reads; `policy.py` is unchanged. Before this, a HIGH-risk $80 call sold 0.2 MW while the wall said "hold", and a LOW $80 tick with no call said "discharge" while nothing moved.

| Tick | `intent` | `intent_reason` |
|---|---|---|
| Mode HOLD | hold | `operator_hold` |
| Charged kW > sold kW, something sold (mixed, charge-heavy) | charge | `grid_call_served` |
| Charged kW > 0, nothing sold, band said charge | charge | policy reason |
| Charged kW > 0, nothing sold, band not charge (only zone prices said charge, e.g. headline missing and Houston $10) | charge | `zone_price` |
| Charged kW > 0, nothing sold, only homes under their floor charged (`reserve_refill` code, no `charging` code) | charge | `reserve_refill` |
| Charged kW > 0, nothing sold, a `charge` zone was set by the DAM rule (checked after `reserve_refill`; wins over the policy-reason and `zone_price` rows) | charge | `dam_cheap_hour`, else `before_spike`, else `rt_dip` |
| Sold kW > 0 and sold kW >= charged kW | discharge | policy reason if the band said discharge, else `grid_call` |
| Nothing moved, band said hold | hold | policy reason (`""`, `price_unavailable`) |
| Nothing moved, band said charge/discharge, target 0 | hold | `no_grid_call` (for the charge band only when every home is full: idle charging otherwise makes it a charge tick) |
| Nothing moved, band said charge/discharge, target > 0 | hold | policy reason (a call nobody could serve; `reasons` says why) |

Net flow picks the label (sold and charged are the planned positive and negative kW, as sizes). On a cheap tick with a call, a few homes sell and most charge (e.g. 4 homes sell 0.02 MW while 96 charge 0.48 MW), so it reads charge / `grid_call_served`. An exact tie reads discharge, because the call was served. A discharge-winning mixed tick shows its charge through the `charging` code in `reasons`. A cheap tick with no call charges every home with room, so it reads charge. `/v1/snapshot`'s AUTO overlay still clears `operator_hold`. The wall's banner (`web/src/fleetIntent.ts`) reads `delivered_mw`, not `intent`; `/flow` prints `intent (intent_reason)` as text. Tests: `acted_intent` cases in `tests/test_controller.py`, paths 21 to 23 in `tests/test_tick_paths.py`.

**Decision (2026-09-26).** Fields were added, never renamed. `Policy` and `TickResult` carry `intent` (`charge` \| `discharge` \| `hold`) and `intent_reason`. `Allocation.per_home_kw` stays one dict and is signed: `>0` discharge, `<0` charge. Do not add `per_home_charge_kw` / `per_home_discharge_kw`. `Home.zone` was already present; `Home.updated_at` is the empty-string default until the fleet stamps a write. Charge raises `soc_kwh`. Discharge still never crosses the floor. `breaches == 0`. Since PR #31, `allocate` writes negative kW on `intent == charge` (and per zone with `zone_intent`); hold still serves the call from headroom. Since 2026-09-26, cheap power serves the call, then charges: see "How a charge tick runs" below. Since 2026-09-26 (later), zone prices set `zone_intent`: see "Each zone decides from its own price".

Open this file when you change the intent rule, the signed allocation contract, the charge/discharge price bands, or how intent is stamped on the tick.

## Rule (say it out loud): the price band on `Policy.intent`

1. Operator HOLD → hold.
2. `price_label` `none` (or a missing number) → hold, `intent_reason` `price_unavailable`.
3. Risk None or `signal_unavailable` → hold, or charge if the LZ price is present and at or below the charge band. Never discharge.
4. Risk HIGH → hold or charge only. Same cheap-price charge. Never discharge.
5. Risk LOW + AUTO: LZ price `<= charge_threshold_usd_mwh` → charge; `>= discharge_threshold_usd_mwh` → discharge; else hold.

Floor-only callers omit `price_label`. Intent stays `hold` and the floor reasons are unchanged.

## Each zone decides from its own price

**Decision (2026-09-26, later): per-zone bands, and the call is still always served.** Before this, the four load-zone prices reached the tick (`zone_prices`) but nothing set `Policy.zone_intent`, so every zone followed the North headline and `allocate_zoned` never ran in production. A $10 Houston and an $80 West were treated the same.

`reserve_policy(..., zone_prices=None)` (add-only; `loop.play_frame` passes the tick's map) sets `Policy.zone_intent[zone]` for every zone in `ZONES` with `price_band`, the same bands as the fleet:

- The zone's own price. A zone whose reason is `storm_risk_high`, `signal_unavailable` or `weather_alert` never gets `discharge` (charge when cheap, else hold).
- A zone with no price takes the fleet `Policy.intent` (the headline price), except a storm-reason zone gets `hold` where that is `discharge` (charge on a cheap headline is kept: charging never lowers backup).
- A missing headline price (`price_unavailable`) does not stop zones with their own price: those are real ERCOT numbers, charging never lowers backup, and selling only happens on a call. A tick that charges only because of zone prices is labelled charge / `zone_price`.
- HOLD mode, a floor-only call (no `price_label`), or no zone prices at all: `zone_intent` stays `{}` and the fleet path runs as before.

`Policy.intent` stays the headline band; `acted_intent` still labels the tick by net flow.

`allocate_zoned` (via `serve_then_charge`, shared with `allocate_charge`):

1. Every live home with headroom in a `discharge` or `hold` zone (a zone with no row counts as hold) shares the call in proportion to its cap (`split_target`, as `allocate_discharge`). Spreading keeps the most homes above their floors for the next call; picking the fewest homes only pays when it frees other homes to charge, and nobody charges in these zones.
   Only if those caps fall short do `charge`-zone homes sell the remainder, the fewest of them (`pick_sellers`), so the rest of the cheap zone still charges.
2. Every other live home in a `charge` zone charges at its room cap. Non-selling homes in hold and discharge zones do nothing: the fleet sells only on a call.
3. A home never sells and charges in one tick. Grid-down, dead, stale and unknown-zone homes get nothing.
4. Reasons: shortfall head code if missed, `charging` if any home charges, status suffixes; `grid_down:<zone>` appended by `allocate`.

`holding_spare_energy` is dropped from the zoned path: it meant "missed while hold zones sat on headroom", which cannot happen now that hold zones sell for a call. It stays only on the unknown-intent branch of `allocate`.

Tapes (origin/main -> this rule, 0 breaches): heather 24.4 -> 35.5%, heather-thaw 80.5 -> 92.8%, calm-charge 76.9 -> 80.8%; storm-rule-night 35.3 -> 29.2%, storm-rule-high 32.6 -> 32.5%; the rest unchanged within 0.2 points. Why storm-rule-night drops (correct, not a bug): at 16:00-16:25 North is $22-23 but Houston is $67-80 and South $158-303. origin/main charged every zone on the North price (237 kWh over the run); per-zone charges only the cheap zones (92 kWh). The 145 kWh not bought is the 0.143 MWh delivered less: both runs drain every home to the floor by 20:40, so delivery equals energy stored. Deliveries first differ at tick 43 (19:30). storm-rule-high: South at $25.49 (just above $25) at 08:45-08:55 does not charge; 30 kWh less stored, 0.002 MWh less delivered.

Tests: zone-band cases in `tests/test_policy.py`, `allocate_zoned` tier cases in `tests/test_controller.py`, path 24 in `tests/test_tick_paths.py`.

## Cheapest DAM hours

**Decision (2026-09-27, user): with DAM hours on the tick, a zone charges above its floor in its cheapest upcoming DAM hours, sized by how much charge it needs, and only when a later hour pays back the round-trip loss.** Before this nothing looked ahead: a zone charged at $24 with $5 two hours away, and waited at $26 when every later hour cost more. Only the charge test changes. The discharge band, the storm cap and refill to the floor (step 10) stay as they were. Contract: `CONSTRAINTS.md`, `reserve_policy` row. Where the hours come from and what the Live wall shows: [dam-forecast.md](dam-forecast.md).

Why arithmetic and not a model: these are published prices, so the rule is exact, repeatable and free of network calls in the tick. JEV was removed on 2026-09-27 for the same reason. Accuracy is measured by the backtest below instead.

The rule, per zone (`policy._set_zone_intent` calls `policy.dam_charge`):

1. **Window.** The DAM hours already published at the tick, from the current hour up to 24 hours ahead (`signal.dam_window`). A zone whose window lacks the current hour has no DAM hours.
2. **Hours needed.** `fleet.zone_hours_needed` = `ceil(Σ room_kwh / Σ max_kw)` over the zone's live homes whose grid is up, where `room_kwh` is capacity minus charge. It reads the planner's view (`telemetry.reported_homes` when the battery feed is on), never the simulator's truth. Example: 25 homes at 10% of 25 kWh, 11.4 kW each: 562.5 kWh / 285 kW = 1.97, so 2 hours. There is no fixed hours setting.
3. **Chosen hours.** The `hours_needed` cheapest hours in the window **before the first later hour at or above `discharge_threshold_usd_mwh`** (the $60 sell band `price_band` uses), ties to the earlier hour. `P_k` is the dearest of them. Hours after that spike cannot be chosen: the battery would sell into the spike first. With no such hour the whole window counts.
4. **Charge now** when both hold:
   - this hour is chosen, or the zone's real-time price now is at or below `P_k` (a dip the forecast missed);
   - payback: some later hour's DAM price × `ROUND_TRIP_PCT` / 100 is above the price now (real-time, or this hour's DAM when the zone has no real-time price). Every later hour in the full window counts, the spike included.
5. The price band runs first. A `discharge` band (at or above $60, not a storm zone) wins, and the chosen hours are still recorded. A storm-reason zone never gets `discharge`.
6. No DAM hours for a zone (no fixture, failed live fetch, current hour missing) keeps the $25/$60 bands. HOLD leaves `zone_intent`, `zone_charge_hours` and `zone_charge_why` empty.

Why the window stops at the spike, and the three choices made with it (2026-09-27, later; the user approved the direction, the choices are recorded here):

- **The current hour never ends the window.** The search for a spike starts at the next hour. When the zone's real-time price is in the sell band, step 5 decides as before (`sell_band`). A current DAM hour at $60+ with real-time below it is a live dip, not a spike ahead: in `heather-spike` every Houston DAM hour of the afternoon was $78 or more, so cutting at the current hour would have left no window at all during the real $21 dip.
- **Payback reads the whole window, spike included.** The spike is where charge bought before it gets sold. Limiting payback to the hours before the spike would say `no_payback` exactly when charging ahead of a spike pays most: $45 now, $46 next, $65 spike is a charge (65 × 0.89 = 57.85 > 45), not a skip (46 × 0.89 = 40.94). Test: `test_dam_payback_counts_the_spike_hour`.
- **Storm zones stop at the spike too.** They never sell on price, but they hold backup and still share a grid call (a hold zone serves the call), and the call is largest in the spike: `heather-spike` asks 1.0 MW at the $1,165 peak. Waiting past the spike for a cheaper hour would leave their backup short through the hardest hours; charging never lowers backup. Test: `test_dam_storm_zone_also_charges_before_a_spike`.
- **`before_spike` (add-only).** When the cut changed the chosen hours and this hour is one of them, the why is `before_spike`, not `dam_cheap_hour`, so the wall line does not say "N cheapest hours of the next 24" about hours that are only the cheapest before the spike. When the cut changes nothing, it stays `dam_cheap_hour`.

What the zone records (`Policy.zone_charge_why`, copied to `TickResult`):

| `zone_charge_why` | `zone_intent` | When |
|---|---|---|
| `dam_cheap_hour` | charge | This hour is chosen and a later hour pays back |
| `before_spike` | charge | As `dam_cheap_hour`, but the window was cut at a sell-band hour and that changed the chosen hours |
| `rt_dip` | charge | Not chosen, but real-time now is at or below `P_k`, and a later hour pays back |
| `cheaper_hour_later` | hold | Not chosen, and real-time is above `P_k` or missing |
| `no_payback` | hold | Would charge, but no later hour × round trip beats the price now |
| `full` | hold | Hours needed is 0 |
| `sell_band` | discharge | The price band said discharge; DAM never stops a sale |

A tick that charged because of this rule reads charge / `dam_cheap_hour` (or `before_spike`, or `rt_dip`) from `acted_intent` (table at the top). `ROUND_TRIP_PCT` (89) is an example setting: `CONSTRAINTS.md`, "Stale data". Honest limits (sized per zone, payback on DAM not the real-time that happens, one fetch a day, 89% example, fills up before a spike even when it already holds enough for the call): `HONEST_LIMITS` in `server/engine/scenario.py`.

### Backtest: is DAM a good forecast of the cheap real-time hours?

`scripts/backtest_dam.py` (commands: [dam-forecast.md](dam-forecast.md#scripts)). For each saved DAM day and load zone, it compares the k cheapest DAM hours with the k cheapest real-time hours (NP6-905-CD 15-minute prices from Supabase `ercot_prices`, averaged to hours). "Hit" is the share of DAM-chosen hours that really were among the k cheapest. The dollar columns are the average real-time $/MWh actually paid.

**Result (2026-09-27): DAM-chosen hours cost about $1.80 to $2.70/MWh more than perfect hindsight, and about $3.70 to $4.10/MWh less than the $25 band on the days both could charge.** DAM finds 60% to 67% of the cheapest hours from k = 2 up, but only 31% of the single cheapest hour.

All 18 scenario DAM days were fetched; ERCOT serves the 2024 dates. It rate-limits with HTTP 429, so the fetch was rerun after about 65 s. 17 days were scored, 68 zone-days. 2024-01-18 was skipped because its real-time prices in Supabase are incomplete.

| k hours | Hit | DAM-chosen, real-time $/MWh | Hindsight, real-time $/MWh |
|---|---|---|---|
| 1 | 31% | 19.47 | 16.74 |
| 2 | 60% | 19.55 | 17.65 |
| 3 | 67% | 20.84 | 18.67 |
| 4 | 67% | 21.64 | 19.81 |

Against the $25 band, counted only on zone-days with at least k hours at or under $25 (real-time $/MWh paid):

| k hours | Zone-days | $25 band | DAM-chosen | Hindsight |
|---|---|---|---|---|
| 1 | 59 | 21.59 | 17.89 | 15.14 |
| 2 | 54 | 20.52 | 16.38 | 15.20 |
| 3 | 45 | 19.60 | 15.81 | 14.51 |
| 4 | 37 | 18.61 | 14.59 | 13.72 |

Worst misses:

- 2026-09-03: about 0% hit in almost every zone.
- 2024-07-08, South: the DAM-chosen hours paid $21 to $28/MWh against $10 to $11 in hindsight.
- 2026-09-16, West: $40 to $67/MWh against $21 to $28.

History: the first run, 8 zone-days on 2026-08-30/31, gave hits of 12% / 62% / 75% / 78% for k = 1 to 4. Two days were too few to judge.

### Replay

**Result (2026-09-27, later): stopping the window at the spike wins back $174 of the $198 `heather-spike` lost, costs $13 in `heather-thaw`, and leaves the other two about the same.** Over the four replays it nets $1149.38, against $987.24 for the first DAM rule and $1163.52 for the old bands. It beats the bands in three of four (`calm-charge` +$6.38, `heather-thaw` +$0.38, `beryl-landfall` +$3.39) and loses $24.29 in `heather-spike`. 0 breaches in every run.

Seed 42. "Bands" is the old tape (no DAM) on today's engine, so the $25/$60 bands. "First DAM" is the 24-hour window (PR #50). "Stop at spike" is this rule. Net $ is dollars delivered minus the cost of charging.

| Scenario | kWh charged | Avg $/MWh to charge | $ delivered | Net $ | Breaches |
|---|---|---|---|---|---|
| `calm-charge` | 1344.8 / 1311.6 / 1313.8 | 20.55 / 16.10 / 16.10 | 129.01 / 127.87 / 128.90 | 101.37 / 106.76 / 107.75 | 0 / 0 / 0 |
| `heather-spike` | 1447.8 / 1158.3 / 1448.7 | 23.97 / 46.65 / 43.24 | 1075.78 / 896.72 / 1079.43 | 1041.08 / 842.68 / 1016.79 | 0 / 0 / 0 |
| `heather-thaw` | 2116.3 / 1734.8 / 1738.8 | 14.12 / 8.98 / 22.85 | 64.41 / 63.45 / 74.64 | 34.53 / 47.87 / 34.91 | 0 / 0 / 0 |
| `beryl-landfall` | 1512.2 / 1530.0 / 1530.0 | 15.73 / 11.92 / 11.92 | 10.32 / 8.17 / 8.17 | −13.46 / −10.07 / −10.07 | 0 / 0 / 0 |

Reasons, in zone-ticks (first DAM → stop at spike):

| Scenario | `dam_cheap_hour` | `before_spike` | `rt_dip` | `cheaper_hour_later` | `no_payback` | `full` | `sell_band` |
|---|---|---|---|---|---|---|---|
| `calm-charge` | 216 → 216 | 0 → 42 | 12 → 12 | 331 → 277 | 0 → 12 | 0 → 0 | 165 → 165 |
| `heather-spike` | 0 → 0 | 0 → 216 | 90 → 0 | 126 → 0 | 0 → 0 | 0 → 0 | 268 → 268 |
| `heather-thaw` | 24 → 24 | 0 → 65 | 231 → 196 | 255 → 225 | 0 → 0 | 1 → 1 | 117 → 117 |
| `beryl-landfall` | 135 → 135 | 0 → 0 | 328 → 328 | 282 → 282 | 3 → 3 | 0 → 0 | 24 → 24 |

What the first rule got wrong in `heather-spike`: at 13:30 tomorrow's DAM arrived with $16 to $22 midday hours, so Houston waited (`cheaper_hour_later`) through today's real $21 dip from 14:30 to 16:00 and met the $1,165 peak short of charge. Now every Houston hour of that afternoon is $78 or more, so the window is the current hour alone: Houston charges (`before_spike`) from 12:00 and through the dip, and sells 0.25 MW at the peak until about 19:00. The $24 still lost against the bands comes from 12:00-14:00, when Houston charged at real-time $31 to $54 (mostly $44 to $54 before 13:00). Today's DAM priced the 14:00-16:00 dip at $79 to $80, so nothing told the rule a $21 hour was coming. That is the forecast, not the window (limit: payback on DAM, not real-time).

What it costs in `heather-thaw`: at 05:00 Houston and North see DAM $121 to $198 for 05:00-08:00, and Houston's real-time does spike to $70 to $87 from 06:00. They fill (`before_spike`) at real-time $41 to $58. But the grid call through that spike is only 0.1 to 0.25 MW for the whole fleet, and the first rule's batteries already held enough to serve it from their starting charge, then filled at $16 to $17 at midday. The new rule sells more ($74.64 against $63.45) but pays $22.85/MWh instead of $8.98 to charge. The rule fills to full before a spike without asking how much the spike will take; the call is synthetic, so the engine cannot know. This is the new line in `HONEST_LIMITS`.

Tests: `tests/test_dam.py` (parser, window, fetch, backtest scoring), `tests/test_fleet.py` (`zone_hours_needed`), the `test_dam_*` cases in `tests/test_policy.py` (one per row above, plus no DAM and HOLD, and the spike cut: cheap hours behind a sell-band hour, the setting, payback on the spike, storm zones), and in `tests/test_controller.py` a home under its floor still refills on a DAM hold hour and `acted_intent` names the DAM reason.

## Refill to the floor

**Decision (2026-09-26, latest).** After every other step, `allocate` calls `add_refill` (`server/engine/controller.py`). Every live home in a known zone whose grid is up, is under its zone floor (`fleet.floor_kwh`), and has no other order this tick gets a charge order of `min(max_kw, (floor − soc) × 60 / tick_minutes)`, as negative kW. It stops at the floor: filling to full stays the cheap-power path's job. Operator HOLD still wins (no orders at all). Dead, stale, unknown-zone and grid-down homes get nothing.

- Why "no other order": a home under its floor has no headroom, so it is never a seller; a home the cheap path already charges takes its full room cap, which covers the floor.
- Reason code `reserve_refill`, after the shortfall and `charging` codes and before the status codes. `charging` now means cheap power charged some home; `reserve_refill` means a home under its floor did.
- Label: a tick where only refill charged reads charge / `reserve_refill`. A storm tick with a call where refill outweighs the sold kW reads charge / `grid_call_served` (net flow, as before).
- Before this, only `price_band` (at or below `CHARGE_BELOW_USD`) ever ordered a charge, so at $26+ a battery under a raised storm floor sat idle through the whole storm window.
- Seen on Heather (seed 42, `/flow`): when the storm floor rises at step 74, all 100 batteries charge (1.14 MW); before, all 100 sat "below floor" at 0 kW. 0 breaches.

Tests: the reserve refill block in `tests/test_controller.py`.

## Settings

Simulation knobs, not Base specs. In `.env.example`: `CHARGE_BELOW_USD=25`, `DISCHARGE_ABOVE_USD=60`. `read_settings()` stores them as `charge_threshold_usd_mwh` and `discharge_threshold_usd_mwh`. `ROUND_TRIP_PCT=89` (`round_trip_pct`) is the DAM payback share; its home is `CONSTRAINTS.md`, "Stale data".

## How a charge tick runs

**Decision (2026-09-26): serve the call, charge the rest.** On `intent == charge`, `allocate_charge` (`server/engine/controller.py`):

1. Picks just enough live homes to cover `target_mw`: most headroom (`home_caps`) first, ties by `home_id`. Those homes split the call with `split_target`. If headroom is short, every home with headroom sells and `missed_mw` is the rest.
2. Every other live home with room charges at its `charge_caps` cap (negative kW). A home never sells and charges in one tick.
3. With `target_mw == 0`, every live home with room charges (idle charging). With `zone_intent` set, only homes in `charge` zones charge; a zoned policy with no `charge` zone returns an empty plan. Other intents with no call still return an empty plan; operator HOLD still wins.
4. Reasons: the shortfall head code if missed, then `charging` if any home charges, then dead/stale/unknown-zone, then `grid_down:<zone>`. Grid-down zones neither sell nor charge.
5. Then `add_refill` charges any other home under its floor ("Refill to the floor").

Before this, a charge tick dropped the whole call and charged every home, adding load when the grid asked for power back.

`orchestrate_tick` (`server/engine/orchestration.py`) runs charge orders beside discharge orders, with these rules:

- **Never past full.** The worker caps a charge order at `fleet.room_kw` (room left to `capacity_kwh`, capped by `max_kw`), the same way it caps discharge at `safe_kw`. A capped order logs `clamped`.
- **Never delivery.** Charge orders are not in `zone_planned_mw`, `confirmed_mw`, `credited_mw`, `home_confirmed_kw` or rollup `discharging`. Only the sellers' confirmed kW is delivery. What the homes confirmed absorbing is `CycleResult.charged_mw` (add-only, a positive number). A charge report logs `charge_confirmed`, not `confirmed`.
- **Sent once.** A lost charge order is not timed out, retried or reassigned (charging owes the grid nothing). Its state closes `unconfirmed`, and `zone_acks` counts the home `unconfirmed`. A home with a charge order is never handed discharge work.
- **Lies caught.** The charge-drop check books the amount nearer zero (the real charge taken, or the claim if it is smaller).
- **Breaches count discharge only.** Charging a home still under a newly raised floor moves it up and is not a breach.
- Telemetry sees charge as negative confirmed kW, so a charging battery is not flagged `suspect`.
- `TickResult` does not carry `charged_mw` yet; the wall does not show charging MW.

The fuzzer (`tests/test_invariants.py`) draws random fleet and per-zone intents and checks every tick: no home past full, `charged_mw` never above what the homes took, and 0 floor breaches.

## What this is not

- Not a rename of `per_home_kw`. Sign is the charge/discharge split.
- `fleet.discharge` (the single-pass helper) still skips negative kW; every engine tick uses `orchestrate_tick`.
- Not a second risk rule. The floor is still HIGH / LOW / missing-signal.
- No Supabase import. Price on the engine tick is the tape number or the already-stamped LZ value.
- `web/src/contracts.ts` repeats `TickResult` names. `contracts.py` wins until that file adds the same names.

## Callers

`loop.py` stamps price, reads the tick's DAM window (`loop.frame_dam`) and, when there is one, `fleet.zone_hours_needed` on the planner's view, then calls `reserve_policy(..., mode, price_usd_mwh, price_label, zone_prices, county_alerts, dam_hours, zone_hours_needed)`, then `allocate` (inside `orchestrate_tick`), then stamps the tick with `acted_intent`. `/v1/snapshot` still calls `reserve_policy` without a price (Sunny). That snapshot tick keeps intent `hold` until that route passes the LZ number.

People page: `docs/humans/policy-intent.md`.
