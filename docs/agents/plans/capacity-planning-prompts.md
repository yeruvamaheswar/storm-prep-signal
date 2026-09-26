# Capacity planning: charge cheap, sell expensive

Launch prompts 1–7 together. They do not share files. The contract below is the shared API; no prompt waits for another to land.

Copy-paste each block into its own agent. Product limits stay in `CONSTRAINTS.md`. Look stays `DESIGN.md`. Do not edit those two files.

## What is already true

- `Policy.intent` is `charge` | `hold` | `discharge` from LZ price bands (`CHARGE_BELOW_USD=25`, `DISCHARGE_ABOVE_USD=60`) and the storm floor. Home: `docs/agents/policy-intent.md`.
- `Allocation.per_home_kw` is signed in the contract (`>0` sell, `<0` charge). `allocate` still only writes positive kW. `HomeWorker.run` subtracts `kw × minutes / 60` from `soc_kwh` and has no fill-to-capacity clamp.
- Live price GET is **LZ_NORTH only**. Archive already binds all four LZs. `/v1/snapshot` calls `reserve_policy` without `price_label`, so snapshot `intent` stays `hold`.
- The wall banner (`fleetIntent`) is discharge or hold from `delivered_mw`. It does not read `TickResult.intent`, so Charge never appears.
- Pack settings are example `HOME_KWH=20`, `HOME_MAX_KW=5`, not Base. Base publishes 25 / 39.2 / 50 kWh with an ~11 kW inverter and a 20% member reserve. This pack adopts the common **25 kWh / 11.4 kW** unit. Storm floors stay 30% / 60% (example). Do not change `BASE_RESERVE_PCT`.
- NP3-233-CD is outages. NP6-905-CD is price. There is still no ERCOT VPP dispatch. LZ **load** (NP3-560-CD) is the next pack, not this one.

## Shared contract

**Price bands (unchanged numbers).** Charge at `price <= charge_threshold_usd_mwh` ($25). Discharge at `price >= discharge_threshold_usd_mwh` ($60). Between them, hold. Missing price (`price_label` `none`) is hold, `intent_reason` `price_unavailable`. HIGH or missing signal may charge when cheap and never discharge. Operator HOLD is hold.

**Allocate follows intent.**

| `policy.intent` | `per_home_kw` | `delivered_mw` | `missed_mw` |
|---|---|---|---|
| `hold` | omitted / 0 | 0 | `target_mw` (reason `operator_hold` or `holding_spare_energy`) |
| `discharge` | today's positive split of `target_mw` | sell MW | `target − delivered` |
| `charge` | negative kW, live homes only | 0 | `target_mw` (reason `charging`) |

Charge cap per home is `min(max_kw, room_kwh × 60 / tick_minutes)` where `room_kwh = capacity_kwh − soc_kwh`. Never fill past `capacity_kwh`. Never discharge on a charge tick. Charge is not a breach.

**Zone price.** When `zone_prices` has a row, that zone's homes follow **that** LZ number. A zone with no row holds. `Policy.zone_intent` is add-only `{South|North|West|Houston: charge|hold|discharge}`. Fleet `intent` is `discharge` if any zone is discharging, else `charge` if any zone is charging, else `hold`.

**Helpers prompt 7 will call** (prompts 4 and 5 must use these names):

- `fetch_zone_prices(settings, token)` and `stamp_zone_prices(body)` in `server/engine/signal.py`
- `reserve_policy(..., zone_prices=None)` in `server/engine/policy.py` (add-only kwarg)

**Base pack.** `HOME_KWH=25`, `HOME_MAX_KW=11.4`. Demo (`FLEET_SIZE=100`, no `CALL_TARGET_MW`) keeps tape `target_mw` as written (0.40 peak). Live/archive cap is `FLEET_SIZE × 11.4 / 1000` (114 MW at 10k). Unset `CALL_TARGET_MW` still scales the 0.40 peak by `FLEET_SIZE / 100` and clamps to that cap (40 MW at 10k, still under 114).

**Honest limits.** The 25 / 11.4 unit and the $25 / $60 bands are public Base-shaped numbers, not a signed Base spec sheet. We do not fetch NP3-560-CD or SCED in this pack.

## Shared rules

- Do not edit files outside your list. If you need a file you do not own, stop and name it.
- Do not add a dependency.
- `allocate` stays pure. The engine never imports Supabase during a tick.
- Fields are add-only. Do not rename or remove.
- Demo tape stays 100 homes / 0.40 MW at `FLEET_SIZE=100`.
- `pytest -q` (and `npx vitest run` / `npx tsc --noEmit` when you touch `web/`) before you stop.
- Do not edit `docs/agents/progress.md`. One line in the PR body is enough.
- Docs ownership: prompt 1 → `docs/agents/fleet-rollups.md`. Prompt 4 → `docs/agents/price-live.md`. Prompt 5 → `docs/agents/policy-intent.md` and `docs/humans/policy-intent.md`. Prompt 6 → `docs/agents/fleet-intent.md`. Prompt 7 → `docs/agents/wall-snapshot.md` only if the snapshot tick gains `intent` from a price.

## Prompt 1 — Base pack settings

```markdown
**[Enhancement] Adopt The Public Base Pack For Fleet Cap**: `.env.example` and `new_fleet` still seed `HOME_KWH=20` and `HOME_MAX_KW=5`, labeled example settings. Base's public help lists 25 / 39.2 / 50 kWh with an ~11 kW inverter. Use the common ground-mount unit: `HOME_KWH=25`, `HOME_MAX_KW=11.4`. Demo at `FLEET_SIZE=100` with no `CALL_TARGET_MW` must still keep tape `target_mw` as written (0.40 peak is identity). Live/archive `fleet_cap_mw` becomes `FLEET_SIZE × 11.4 / 1000` (114 MW at 10k). Unset `CALL_TARGET_MW` still scales 0.40 × FLEET_SIZE/100 and clamps to that new cap (40 MW at 10k). Do not change `BASE_RESERVE_PCT` or `STORM_RESERVE_PCT`. Do not change `allocate`. Own only `.env.example`, the default reads in `server/engine/cli.py`, `HOME_KWH` / `HOME_MAX_KW` and the cap comments in `server/engine/fleet.py`, `tests/test_fleet_scale.py`, and `docs/agents/fleet-rollups.md`. Research `server/engine/fleet.py` `fleet_cap_mw` `call_target_mw` `scale_target_mw`, `.env.example`, `docs/agents/team-manifest.md` Honest limits, and `docs/agents/fleet-rollups.md` before editing.
```

## Prompt 2 — Allocate follows intent

```markdown
**[Enhancement] Make Allocate Charge When The Price Band Says Charge**: `reserve_policy` already sets `Policy.intent` to charge / hold / discharge from the LZ price bands, but `allocate` ignores it and always splits a positive `target_mw` across live homes. A cheap tick therefore still sells. Follow the table in `docs/agents/plans/capacity-planning-prompts.md`: HOLD or `intent==hold` writes no kW and misses the call (`holding_spare_energy` unless `operator_hold`); `intent==discharge` keeps today's positive split; `intent==charge` writes **negative** kW only, cap `min(max_kw, (capacity_kwh − soc_kwh) × 60 / tick_minutes)`, never past `capacity_kwh`, `delivered_mw` 0, `missed_mw` = `target_mw`, reason `charging`. If `policy.zone_intent` is a non-empty dict, each home follows its zone's intent; a missing zone holds. Live homes only. Dead and stale stay 0. Do not add `per_home_charge_kw`. Do not edit `policy.py` or `orchestration.py`. Own only `server/engine/controller.py` and `tests/test_controller.py`. Research `CONSTRAINTS.md` allocation rule step 6, `docs/agents/policy-intent.md`, `server/engine/controller.py` `allocate` `home_caps` `split_target`, and `server/engine/policy.py` `_set_intent` before editing.
```

## Prompt 3 — Workers fill on a charge order

```markdown
**[Bug] Honor Negative kW And Do Not Fill Past Capacity**: `HomeWorker.run` always does `soc_kwh -= kw × tick_minutes / 60` after `kw = min(cmd.kw, safe_kw)`. A charge order is negative kW. `min(-5, safe)` keeps the sign so soc rises, but there is no clamp to `capacity_kwh`, and a charge is scored against the discharge floor. On `cmd.kw < 0`, fill at `min(|kw|, room_to_capacity × 60 / tick_minutes)`, raise `soc_kwh` by that energy, book `actual_kw` negative, and never count a charge as a floor breach. `cmd.kw > 0` stays today's discharge clamp. `cmd.kw == 0` is a no-op. Own only `server/engine/orchestration.py` and new cases in `tests/test_orchestration.py`. Research `server/engine/orchestration.py` `HomeWorker.run` `check_charge_drop`, `server/engine/fleet.py` `discharge` (already raises soc on negative kW), and `CONSTRAINTS.md` step 6 before editing.
```

## Prompt 4 — Live prices for all four load zones

```markdown
**[Enhancement] Fetch Live NP6-905-CD For Houston North South And West**: `fetch_price()` GETs `settlementPoint=LZ_NORTH` only. Archive already binds `LZ_HOUSTON|NORTH|SOUTH|WEST`. A South vs West spread cannot pick charge in one zone and discharge in another while live only has North. Add `fetch_zone_prices(settings, token)` and `stamp_zone_prices(body)` in `server/engine/signal.py`. They return the newest shared interval's four load-zone prices (ignore `LZ_AEN|CPS|LCRA|RAYBN`). `price_usd_mwh` stays LZ_NORTH when that row exists. Failure of one LZ omits that key; failure of all four is `price_label` `none`, never tape 185. Stale remains 30 minutes. DAM NP4-190 stays out. Do not edit `loop.py` or `snapshot.py` (prompt 7 wires the callers). Own only `server/engine/signal.py`, `tests/test_price.py`, and `docs/agents/price-live.md`. Research `server/engine/signal.py` `fetch_price` `read_price` `stamp_price`, `server/api/prices.py` `LOAD_ZONE_POINTS`, and `docs/agents/price-live.md` before editing.
```

## Prompt 5 — Per-zone intent from each LZ price

```markdown
**[Enhancement] Pick Charge Or Discharge Per Load Zone From That Zone's Price**: `_set_intent` uses one fleet `price_usd_mwh`. When `zone_prices` is present, South can be cheap while Houston is expensive. Add-only kwarg `zone_prices=None` on `reserve_policy`. Add-only fields `Policy.zone_intent` and `TickResult.zone_intent` (`default_factory=dict`, keys South/North/West/Houston, values charge|hold|discharge). Each zone uses its own `$/MWh` with the same bands and storm rule as the fleet (HIGH / missing signal: charge or hold, never discharge). A zone with no price is `hold`. Fleet `intent` is `discharge` if any zone is discharging, else `charge` if any zone is charging, else `hold`. Floor-only callers that omit `price_label` stay hold and `zone_intent` {}. Do not edit `loop.py` (prompt 7 copies `zone_intent` onto the tick). Own only `server/engine/policy.py`, the add-only `zone_intent` fields in `server/engine/contracts.py`, `tests/test_policy.py`, `docs/agents/policy-intent.md`, and `docs/humans/policy-intent.md`. Research `docs/agents/policy-intent.md`, `server/engine/policy.py` `_set_intent`, and `CONSTRAINTS.md` `reserve_policy` before editing.
```

## Prompt 6 — Wall names Charge when the tick does

```markdown
**[Enhancement] Show Charge On The Banner When Tick Intent Is Charge**: `fleetIntent` only returns discharge or hold from `delivered_mw`, so a cheap ERCOT tick that charged still reads Hold. `TickResult.intent` is already on the engine tick. Add-only `intent` and `intent_reason` on `web/src/contracts.ts` `TickView`. `FleetAction` gains `charge`. When `tick.intent==="charge"` (and the report is trusted, mode is AUTO), the line is charge at the floor, with the same delivered/target MW and `target_label` as today. Untrusted report and operator HOLD still outrank. Do not allocate or fetch. Own only `web/src/fleetIntent.ts`, add-only intent fields in `web/src/contracts.ts`, `web/tests/fleetIntent.test.ts` (or the existing fleet-intent test file if that is its name), `web/src/components/templates/OperatorWall.tsx` only if `intentClass` needs a `charge` branch (exhaustive `never`), and `docs/agents/fleet-intent.md`. Research `web/src/fleetIntent.ts`, `docs/agents/fleet-intent.md`, `docs/agents/policy-intent.md`, and `DESIGN.md` tokens before editing.
```

## Prompt 7 — Snapshot and the live tick use the price

```markdown
**[Enhancement] Stamp Intent From The Live LZ Price On Snapshot And The Engine Tick**: `/v1/snapshot` calls `reserve_policy(risk, settings)` with no `price_label`, so the wall tick's `intent` stays `hold` even when NP6-905-CD is $10 or $200. `loop.py` stamps LZ_NORTH and copies `policy.intent`, but it does not pass `zone_prices` into policy or copy `zone_intent`. After prompt 4 and 5 land, call `fetch_zone_prices` / `stamp_zone_prices` from the existing live price path in `loop.py`, pass `price_usd_mwh`, `price_label`, and `zone_prices` into `reserve_policy`, and copy `policy.zone_intent` onto `TickResult`. In `server/api/snapshot.py`, pass the already-stamped LZ price (and `zone_prices` when present) into `reserve_policy` so Live/archive snapshots carry `intent` / `intent_reason` / `zone_intent`. Floor-only paths that have no price stay hold. Do not fetch a new ERCOT product. If `fetch_zone_prices` or `zone_prices=` is not in the tree yet, stop and name the missing symbol; do not paste a second reader. Own only `server/engine/loop.py` (the price/policy/TickResult stamp only), `server/api/snapshot.py`, `tests/test_snapshot_prices.py`, and a snapshot intent case in `tests/test_snapshot.py` or `tests/test_engine.py` as already used for price. Research `server/engine/loop.py` where it calls `stamp_price` and `reserve_policy`, `server/api/snapshot.py` `reserve_policy` call sites, `docs/agents/policy-intent.md` Callers, and `docs/agents/wall-snapshot.md` before editing.
```
