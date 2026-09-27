# Charge, hold, or discharge

The tick's `intent` says what the batteries actually did: charge, hold, or discharge.

The price picks a plan first. Cheap (at or below $25/MWh) plans a charge. Expensive (at or above $60/MWh) on a calm Auto tick plans a discharge. A storm or a missing outage report never plans a discharge. These are example numbers, not Base specs.

But when the grid calls, the homes sell from spare energy even on a hold price. That tick now says discharge, with the reason `grid_call`. A high price with no grid call says hold, with the reason `no_grid_call`. Operator Hold always says hold.

Discharge still never goes below the backup floor. The per-home kilowatt number is signed: plus means sell, minus means charge.

The long note is `docs/agents/policy-intent.md`.
