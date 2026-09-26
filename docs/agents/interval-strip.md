# Interval strip

**Decision.** The bottom chart is two views. Demo is tape playback: the 12-tick spark, tick buttons, and annotations such as "05 missed on purpose". Live is a rolling interval strip bound to target, delivered, and reserved from a backend series. Live never uses ticks 01–12 as a stand-in. Until that series exists, the strip is a skeleton and the line "Waiting for intervals".

The chart math lives in `web/src/chartPlot.ts`. Tape columns and tick-button copy stay in `web/src/components/organisms/tapeSpark.ts` and `TapeScrubber.tsx`. Interval points, event marks, and the rolling window stay in `web/src/intervalSeries.ts` and `IntervalStrip.tsx`. `ControlBar` picks one view from `runtimeMode`.

## Live series

An interval is a clock window (SCED or 15-minute), not a tape index. The wall keeps the last `INTERVAL_WINDOW` (12) points. Each point carries `targetMw`, `deliveredMw`, `reservedMw`, and zero or more marks: risk HIGH, floor raised, homes offline, hold. Marks come from the series (risk, reserve, dead homes, mode), not from brief text.

`OperatorWall` passes intervals from `useLiveStamp()` in Live. Each `/v1/snapshot` poll appends or replaces a point (`pushLiveInterval`). Filling the strip from `run.ticks` is a fallback and is not allowed. Demo still uses the tape spark, not this series.

## Demo playback

Tick buttons, scenario chips, and the High-risk advance stay on the tape. Zone drill-in still swaps that spark to the selected zone's outage MW. Hold and Auto still jump to the tape tick that already carries that mode. None of that runs in Live.

Radar is a map overlay. It stays on both views.
