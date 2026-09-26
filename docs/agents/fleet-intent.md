# Fleet intent

The banner under the metrics is one line: discharge or hold. It reads the tick. It does not allocate, set the floor, or send kilowatts.

Charge is not a fleet action. The frozen plan says the fleet only discharges. There is no charge controller to merge.

## What the three names were

- **Backup rule** is `reserve_policy` in `storm_prep/policy.py`. LOW keeps 30%. HIGH, a missing signal, or a weather alert on a zone keeps 60%. The wall used to say that only as a fail banner, and again in the side brief.
- **Discharge** is `allocate` then `discharge`. Both are still the temporary stubs in `storm_prep/engine.py`: every home gets 0 kW, delivered stays 0, and state of charge does not move. `storm_prep/controller.py` and `storm_prep/fleet.py` are not in the repo. The 5-step rule they must follow is in `CONSTRAINTS.md`.
- **Charge** is the starting state of charge on `Home.soc_kwh`. Nothing tops a battery up from price or from a forecast.

The side brief stays. It is written after the tick and is not an input. The banner is the action. The brief is the explanation.

## Path from an ERCOT figure to a home

1. **Outage posting.** `signal.py` reads NP3-233-CD (live, or a saved posting). Twelve MW fields, four load zones. There is no total field. `risk.py` rates the next 6 hours against the lead-matched baseline. That posting is the forecast. There is no second forecast feed.
2. **Floor.** `reserve_policy` turns HIGH, LOW, or nothing into 60% or 30%.
3. **Call and price.** `TapeFrame.target_mw` and `price_usd_mwh` come from a labeled tape, or from the flat 0.2 MW synthetic frames when `--live` has no tape. There is no live DAM or RT price fetch, and ERCOT does not send this fleet a dispatch order. Price is shown. It does not pick the action.
4. **Homes.** `Home` is id, capacity, soc, max kW, status (`live`, `stale`, `dead`), and zone. The wall's 100 cells and the ack rail are a reading of the tick counts. They are not device telemetry. Acks on the rail are a staged timer.
5. **Mode.** AUTO or HOLD, from the tape. HOLD gives every home 0 kW.
6. **Plan.** `Allocation` is per-home kW, delivered MW, missed MW, and reason codes. The stub fills 0 kW and misses the whole target.
7. **Reconcile.** Delivered on the wall is the tick's `delivered_mw`, next to `target_label`. It is not a sum of home acknowledgements.

## Banner

`web/src/fleetIntent.ts` is the line. An untrusted report is hold, even if the tick still shows delivered megawatts. The codes live on `untrustedReport` in `web/src/wallLines.ts`. That sentence is `UNTRUSTED_REPORT`. The Feeds panel uses the same sentence. Operator HOLD is next. Otherwise delivered megawatts above zero are discharge, and zero is hold. A HIGH tick that is past the reserve threshold appends the outage trigger from `web/src/wallLines.ts`.

Tick 01: `Discharge above the 30% floor. Delivered 0.20 of 0.20 MW (synthetic).`

Tick 05: `Discharge above the 60% floor. Delivered 0.31 of 0.40 MW (synthetic). Outage 22,539 MW vs 22,348 MW threshold.`

Tick 08: `Hold. Discharge stays at zero until Auto.`

Fail-safe: `Hold the reserve floor. The outage report cannot be trusted.`
