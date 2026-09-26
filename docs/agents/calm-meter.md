# Calm meter

Decision (2026-09-25, Sunny): the wall shows calm in the top strip right after Risk. It is display only. The engine does not enforce a calm streak.

The control is a 0–2 meter: the count, a fill, and the line "clean LOW readings in a row". Zero keeps the ruled track and a muted 0. Risk stays this tick's level. Calm is how many clean LOW readings have stacked.

## Rule the meter shows

- The streak starts at 0 for each run.
- A LOW tick adds 1, up to 2.
- A HIGH tick, a `signal_unavailable` tick, or a scene with quality `timeout` or `stale` resets it to 0.
- The Risk cell caption says `Normal` only at 2/2. Before that it says "1 more calm reading". HIGH and fail-safe ticks keep the engine's `policy_reason`.
- The Floor cell always keeps the engine's `policy_reason`, because it reports the floor the engine actually set.
- Both cells show that code through `headerReason`: a sentence-case label plus a tooltip for why the floor moved. The raw code stays in the tick. `riskCaption` still returns the code, and the header maps it.
- A wall scene is a staged tick with no history, so it is counted on its own.

On the layout fixture, ticks 9, 10, 11, and 12 read 0/2, 1/2, 2/2, and 2/2.

## Gap to know about

`reserve_policy` (see `CONSTRAINTS.md`) returns `base_reserve_pct` with reason `normal` on the first LOW tick. So at tick 10 the fleet is already selling at the 30% floor while the meter reads 1/2. The two-calm rule comes from `plan.md` Slice 5, and it was never built into the engine. For the engine to gate on it, Uma would have to add the streak to `reserve_policy` and a field to `TickResult`. Then the wall should read that field instead of counting ticks itself.

## Code

- `web/src/calmStreak.ts`: `calmStep`, `calmStreak`, `riskCaption`
- `web/src/format.ts`: `headerReason` maps `normal`, `storm_risk_high`, `signal_unavailable`, and `weather_alert`
- `web/src/components/molecules/CalmMeter.tsx`
- `web/tests/calmStreak.test.ts`
