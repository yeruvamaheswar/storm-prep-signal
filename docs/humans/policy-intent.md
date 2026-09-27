# Charge, hold, or discharge

The tick's `intent` says what the fleet was ordered to do this tick: charge, hold, or discharge. If an order is lost on the way, the label still shows the order; delivered MW shows what arrived.

The price picks a plan first. Cheap (at or below $25/MWh) plans a charge. Expensive (at or above $60/MWh) on a calm Auto tick plans a discharge. A storm or a missing outage report never plans a discharge. These are example numbers, not Base specs.

But when the grid calls, the homes sell from spare energy even on a hold price. That tick now says discharge, with the reason `grid_call`. A high price with no grid call says hold, with the reason `no_grid_call`. Operator Hold always says hold.

Each load zone uses its own price when we have one. A $10 Houston charges while an $80 West is first in line to sell. The grid call is still always served: the expensive and middle zones share it first, and cheap zones sell only what is left.

Discharge still never goes below the backup floor. The per-home kilowatt number is signed: plus means sell, minus means charge.

The long note is `docs/agents/policy-intent.md`.
