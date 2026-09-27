# Charge, hold, or discharge

The tick's `intent` says what the fleet was ordered to do this tick: charge, hold, or discharge. If an order is lost on the way, the label still shows the order; delivered MW shows what arrived.

The price picks a plan first. Cheap (at or below $25/MWh) plans a charge. Expensive (at or above $60/MWh) on a calm Auto tick plans a discharge. A storm or a missing outage report never plans a discharge. These are example numbers, not Base specs.

But when the grid calls, the homes sell from spare energy even on a hold price. That tick now says discharge, with the reason `grid_call`. A high price with no grid call says hold, with the reason `no_grid_call`. Operator Hold always says hold.

Each load zone uses its own price when we have one. A $10 Houston charges while an $80 West does not. When the grid calls, the expensive and middle zones share the call, and cheap zones sell only what is left. A zone under a storm warning never sells on price.

When we have ERCOT's day-ahead prices, a zone charges in its cheapest hours of the next 24 and waits when a cheaper hour is coming (`docs/humans/dam-forecast.md`). It usually pays less to charge, but not always: in one saved storm it waited past a real price dip and had less charge when prices spiked.

A battery under its backup floor always charges back up to that floor, at any price. A storm warning raises the floor, so batteries refill before the storm lands. That tick says charge, with the reason `reserve_refill`.

Discharge still never goes below the backup floor. The per-home kilowatt number is signed: plus means sell, minus means charge.

The long note is `docs/agents/policy-intent.md`.
