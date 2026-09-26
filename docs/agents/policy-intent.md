# Charge / hold / discharge intent

**Decision (2026-09-26).** Fields were added, never renamed. `Policy` and `TickResult` carry `intent` (`charge` \| `discharge` \| `hold`) and `intent_reason`. `Allocation.per_home_kw` stays one dict and is signed: `>0` discharge, `<0` charge. Do not add `per_home_charge_kw` / `per_home_discharge_kw`. `Home.zone` was already present; `Home.updated_at` is the empty-string default until the fleet stamps a write. Charge raises `soc_kwh`. Discharge still never crosses the floor. `breaches == 0`. `allocate` still only writes positive kW until charge is implemented.

Open this file when you change the intent rule, the signed allocation contract, the charge/discharge price bands, or how intent is stamped on the tick.

## Rule (say it out loud)

1. Operator HOLD → hold.
2. `price_label` `none` (or a missing number) → hold, `intent_reason` `price_unavailable`.
3. Risk None or `signal_unavailable` → hold, or charge if the LZ price is present and at or below the charge band. Never discharge.
4. Risk HIGH → hold or charge only. Same cheap-price charge. Never discharge.
5. Risk LOW + AUTO: LZ price `<= charge_threshold_usd_mwh` → charge; `>= discharge_threshold_usd_mwh` → discharge; else hold.

Floor-only callers omit `price_label`. Intent stays `hold` and the floor reasons are unchanged.

## Settings

Simulation knobs, not Base specs. In `.env.example`: `CHARGE_BELOW_USD=25`, `DISCHARGE_ABOVE_USD=60`. `read_settings()` stores them as `charge_threshold_usd_mwh` and `discharge_threshold_usd_mwh`.

## What this is not

- Not a rename of `per_home_kw`. Sign is the charge/discharge split.
- Not a change to `allocate` or `discharge` on this slice. Those still sell kilowatts under the floor, or 0 on HOLD. Negative kW are ignored until charge is implemented.
- Not a second risk rule. The floor is still HIGH / LOW / missing-signal.
- No Supabase import. Price on the engine tick is the tape number or the already-stamped LZ value.
- `web/src/contracts.ts` repeats `TickResult` names. `contracts.py` wins until that file adds the same names.

## Callers

`loop.py` stamps price, then calls `reserve_policy(..., mode, price_usd_mwh, price_label)`, then `allocate`. `/v1/snapshot` still calls `reserve_policy` without a price (Sunny). That snapshot tick keeps intent `hold` until that route passes the LZ number.

People page: `docs/humans/policy-intent.md`.
