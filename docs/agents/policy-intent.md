# Charge / hold / discharge intent

**Decision (2026-09-26, later): the tick's label shows what the fleet was ordered to do this tick.** It is the order, not the result: if every discharge order times out, the tick still says discharge and `delivered_mw` shows the shortfall. `TickResult.intent` / `intent_reason` come from `controller.acted_intent(alloc, policy, mode)`, which reads the planned `cycle.allocation`, not the price band. `Policy.intent` is still the price band below and is still what `allocate` reads; `policy.py` is unchanged. Before this, a HIGH-risk $80 call sold 0.2 MW while the wall said "hold", and a LOW $80 tick with no call said "discharge" while nothing moved.

| Tick | `intent` | `intent_reason` |
|---|---|---|
| Mode HOLD | hold | `operator_hold` |
| Any home planned `> 0` kW (sold) | discharge | policy reason if the band said discharge, else `grid_call` |
| Else any home `< 0` kW (charged) | charge | policy reason |
| Nothing moved, band said hold | hold | policy reason (`""`, `price_unavailable`) |
| Nothing moved, band said charge/discharge, target 0 | hold | `no_grid_call` |
| Nothing moved, band said charge/discharge, target > 0 | hold | policy reason (a call nobody could serve; `reasons` says why) |

A tick that both sells and charges ("serve the call, charge the rest") is labelled discharge; the `charging` code in `reasons` shows the charge. `/v1/snapshot`'s AUTO overlay still clears `operator_hold`. The wall's banner (`web/src/fleetIntent.ts`) reads `delivered_mw`, not `intent`; `/flow` prints `intent (intent_reason)` as text. Tests: `acted_intent` cases in `tests/test_controller.py`, paths 21 to 23 in `tests/test_tick_paths.py`.

**Decision (2026-09-26).** Fields were added, never renamed. `Policy` and `TickResult` carry `intent` (`charge` \| `discharge` \| `hold`) and `intent_reason`. `Allocation.per_home_kw` stays one dict and is signed: `>0` discharge, `<0` charge. Do not add `per_home_charge_kw` / `per_home_discharge_kw`. `Home.zone` was already present; `Home.updated_at` is the empty-string default until the fleet stamps a write. Charge raises `soc_kwh`. Discharge still never crosses the floor. `breaches == 0`. Since PR #31, `allocate` writes negative kW on `intent == charge` (and per zone with `zone_intent`); hold still serves the call from headroom. The runtime rules for charge orders are in "How a charge tick runs" below.

Open this file when you change the intent rule, the signed allocation contract, the charge/discharge price bands, or how intent is stamped on the tick.

## Rule (say it out loud): the price band on `Policy.intent`

1. Operator HOLD → hold.
2. `price_label` `none` (or a missing number) → hold, `intent_reason` `price_unavailable`.
3. Risk None or `signal_unavailable` → hold, or charge if the LZ price is present and at or below the charge band. Never discharge.
4. Risk HIGH → hold or charge only. Same cheap-price charge. Never discharge.
5. Risk LOW + AUTO: LZ price `<= charge_threshold_usd_mwh` → charge; `>= discharge_threshold_usd_mwh` → discharge; else hold.

Floor-only callers omit `price_label`. Intent stays `hold` and the floor reasons are unchanged.

## Settings

Simulation knobs, not Base specs. In `.env.example`: `CHARGE_BELOW_USD=25`, `DISCHARGE_ABOVE_USD=60`. `read_settings()` stores them as `charge_threshold_usd_mwh` and `discharge_threshold_usd_mwh`.

## How a charge tick runs

`orchestrate_tick` (`server/engine/orchestration.py`) runs charge orders beside discharge orders, with these rules:

- **Never past full.** The worker caps a charge order at `fleet.room_kw` (room left to `capacity_kwh`, capped by `max_kw`), the same way it caps discharge at `safe_kw`. A capped order logs `clamped`.
- **Never delivery.** Charge orders are not in `zone_planned_mw`, `confirmed_mw`, `credited_mw`, `home_confirmed_kw` or rollup `discharging`. A charge tick delivers 0 and misses the call. What the homes confirmed absorbing is `CycleResult.charged_mw` (add-only, a positive number). A charge report logs `charge_confirmed`, not `confirmed`.
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

`loop.py` stamps price, then calls `reserve_policy(..., mode, price_usd_mwh, price_label)`, then `allocate` (inside `orchestrate_tick`), then stamps the tick with `acted_intent`. `/v1/snapshot` still calls `reserve_policy` without a price (Sunny). That snapshot tick keeps intent `hold` until that route passes the LZ number.

People page: `docs/humans/policy-intent.md`.
