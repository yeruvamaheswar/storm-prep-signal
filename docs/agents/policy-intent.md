# Charge / hold / discharge intent

**Decision (2026-09-26, latest): a battery under its reserve floor charges back to that floor from the grid, at any price.** Rajat chose this; it replaces "refill is price-only". The point is to have the reserve in place before a storm lands: a weather alert or HIGH risk raises the floor to `storm_reserve_pct`, and every live, grid-up home under it refills, even at $60+. See "Refill to the floor" below.

**Decision (2026-09-26, later): the tick's label shows what the fleet was ordered to do this tick.** It is the order, not the result: if every discharge order times out, the tick still says discharge and `delivered_mw` shows the shortfall. `TickResult.intent` / `intent_reason` come from `controller.acted_intent(alloc, policy, mode)`, which reads the planned `cycle.allocation`, not the price band. `Policy.intent` is still the price band below and is still what `allocate` reads; `policy.py` is unchanged. Before this, a HIGH-risk $80 call sold 0.2 MW while the wall said "hold", and a LOW $80 tick with no call said "discharge" while nothing moved.

| Tick | `intent` | `intent_reason` |
|---|---|---|
| Mode HOLD | hold | `operator_hold` |
| Charged kW > sold kW, something sold (mixed, charge-heavy) | charge | `grid_call_served` |
| Charged kW > 0, nothing sold, band said charge | charge | policy reason |
| Charged kW > 0, nothing sold, band not charge (only zone prices said charge, e.g. headline missing and Houston $10) | charge | `zone_price` |
| Charged kW > 0, nothing sold, only homes under their floor charged (`reserve_refill` code, no `charging` code) | charge | `reserve_refill` |
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

## Refill to the floor

**Decision (2026-09-26, latest).** After every other step, `allocate` calls `add_refill` (`server/engine/controller.py`). Every live home in a known zone whose grid is up, is under its zone floor (`fleet.floor_kwh`), and has no other order this tick gets a charge order of `min(max_kw, (floor − soc) × 60 / tick_minutes)`, as negative kW. It stops at the floor: filling to full stays the cheap-power path's job. Operator HOLD still wins (no orders at all). Dead, stale, unknown-zone and grid-down homes get nothing.

- Why "no other order": a home under its floor has no headroom, so it is never a seller; a home the cheap path already charges takes its full room cap, which covers the floor.
- Reason code `reserve_refill`, after the shortfall and `charging` codes and before the status codes. `charging` now means cheap power charged some home; `reserve_refill` means a home under its floor did.
- Label: a tick where only refill charged reads charge / `reserve_refill`. A storm tick with a call where refill outweighs the sold kW reads charge / `grid_call_served` (net flow, as before).
- Before this, only `price_band` (at or below `CHARGE_BELOW_USD`) ever ordered a charge, so at $26+ a battery under a raised storm floor sat idle through the whole storm window.
- Seen on Heather (seed 42, `/flow`): when the storm floor rises at step 74, all 100 batteries charge (1.14 MW); before, all 100 sat "below floor" at 0 kW. 0 breaches.

Tests: the reserve refill block in `tests/test_controller.py`.

## Settings

Simulation knobs, not Base specs. In `.env.example`: `CHARGE_BELOW_USD=25`, `DISCHARGE_ABOVE_USD=60`. `read_settings()` stores them as `charge_threshold_usd_mwh` and `discharge_threshold_usd_mwh`.

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

`loop.py` stamps price, then calls `reserve_policy(..., mode, price_usd_mwh, price_label, zone_prices)`, then `allocate` (inside `orchestrate_tick`), then stamps the tick with `acted_intent`. `/v1/snapshot` still calls `reserve_policy` without a price (Sunny). That snapshot tick keeps intent `hold` until that route passes the LZ number.

People page: `docs/humans/policy-intent.md`.
