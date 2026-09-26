# Fleet intent

The banner under the metrics is one line: discharge or hold. It reads the tick. It does not allocate, set the floor, or send kilowatts.

Charge is not a fleet action. The frozen plan says `allocate` only discharges. There is no charge controller to merge. `Policy.intent` may still say `charge` when the LZ price is cheap (`docs/agents/policy-intent.md`). That label does not send kilowatts into a home.

## What the three names were

- **Backup rule** is `reserve_policy` in `server/engine/policy.py`. LOW keeps 30%. HIGH, a missing signal, or a weather alert on a zone keeps 60%. The wall used to say that only as a fail banner, and again in the side brief.
- **Discharge** is `allocate` then `discharge`. The 5-step rule is in `CONSTRAINTS.md`. `allocate`, `home_caps`, and `split_target` live in `server/engine/controller.py`. `new_fleet`, `assign_zone`, `apply_events`, and `discharge` live in `server/engine/fleet.py`. `server/engine/loop.py` calls them in that order each tick. There is no charge controller.
- **Charge** is the starting state of charge on `Home.soc_kwh`. Nothing tops a battery up from price or from a forecast.

The side brief stays. It is written after the tick and is not an input. The banner is the action. The brief is the explanation.

## Path from an ERCOT figure to a home

1. **Outage posting.** `signal.py` reads NP3-233-CD (live, or a saved posting). Twelve MW fields, four load zones. There is no total field. `risk.py` rates the next 6 hours against the lead-matched baseline. That posting is the forecast. There is no second forecast feed.
2. **Floor.** `reserve_policy` turns HIGH, LOW, or nothing into 60% or 30%.
3. **Call and price.** The Demo tape keeps `TapeFrame.target_mw` (0.40 MW peak at 100 homes). Live/archive scale that call against `FLEET_SIZE * HOME_MAX_KW / 1000` and `CALL_TARGET_MW` (`docs/agents/fleet-rollups.md`). Live `--live` and `/v1/snapshot` stamp `price_usd_mwh` from NP6-905-CD at LZ_NORTH (`docs/agents/price-live.md`). A failed pull is none, not tape 185. Price picks `Policy.intent` (`docs/agents/policy-intent.md`). `allocate` still only discharges.
4. **Homes.** `Home` is id, capacity, soc, max kW, status (`live`, `stale`, `dead`), and zone. The wall's 100 cells are a reading of the tick counts. They are not device telemetry. Zone acks are an in-process rollup after allocate (`docs/agents/zone-acks.md`).
5. **Mode.** AUTO or HOLD, from `var/state.json` (and tape `events.operator`, which sticks until the next operator event). HOLD gives every home 0 kW. Live Hold/Auto write the file through `POST /v1/fleet/mode`. Demo Hold/Auto may still jump to the tape ticks that already carry that mode.
6. **Plan.** `Allocation` is per-home kW, delivered MW, missed MW, and reason codes. HOLD is 0 kW and `operator_hold`. Live homes only. Cap is `min(max_kw, headroom × 60 / tick_minutes)`. Under the sum of caps, every home runs at its cap; otherwise the split is proportional.
7. **Reconcile.** Delivered on the wall is the tick's `delivered_mw`, next to `target_label`. It is not a sum of home acknowledgements.

## Banner

`web/src/fleetIntent.ts` is the line. An untrusted report is hold, even if the tick still shows delivered megawatts. The codes live on `untrustedReport` in `web/src/wallLines.ts`. That sentence is `UNTRUSTED_REPORT`. The Feeds panel uses the same sentence. Operator HOLD is next. Otherwise delivered megawatts above zero are discharge, and zero is hold. A HIGH tick that is past the reserve threshold appends the outage trigger from `web/src/wallLines.ts`.

Tick 01: `Discharge above the 30% floor. Delivered 0.20 of 0.20 MW (synthetic).`

Tick 05: `Discharge above the 60% floor. Delivered 0.31 of 0.40 MW (synthetic). Outage 22,539 MW vs 22,348 MW threshold.`

Tick 08: `Hold. Discharge stays at zero until Auto.`

Fail-safe: `Hold the reserve floor. The outage report cannot be trusted.`
