# Live price

The live wall now reads one ERCOT number: the newest 15-minute price at LZ_NORTH (report NP6-905-CD). The engine and the Live `/v1/snapshot` route share that reader. Demo and Synthetic read the saved North price for the tape clock instead.

If the pull works, the tick shows that price, labeled `ercot`, with the interval time. If the pull fails, the tile stays empty. It does not fall back to the demo 185.

The live pull is still North only. Archive rows can fill Houston, South, and West for the same 15-minute interval. A zone with no row stays unread. The day-ahead report is not in this pass. Price now names charge, hold, or discharge on the tick. The batteries still only discharge. See `docs/humans/policy-intent.md`.

The long note is `docs/agents/price-live.md`.
