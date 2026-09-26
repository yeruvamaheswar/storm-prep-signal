# Charge, hold, or discharge

The engine now names what it *wants* to do this tick: charge, hold, or discharge. That name lives on the tick as `intent`.

Hold always wins if the operator pressed Hold, or if there is no price. A storm or a missing outage report will not discharge. They may charge if the North price is cheap. Only a calm Auto tick with a high price asks to discharge.

Cheap and expensive are example numbers (charge at or below $25/MWh, discharge at or above $60/MWh). They are not Base specs.

The batteries still only discharge today. The allocator has not learned to charge. The new fields are the label. When charge is applied later, it will raise stored energy. Discharge still never goes below the backup floor.

Each home can carry a zone and a last-updated time. The per-home kilowatt number is signed: plus means sell, minus means charge. We did not add a second pair of field names.

The long note is `docs/agents/policy-intent.md`.
