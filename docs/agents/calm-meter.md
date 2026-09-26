# Calm meter

Decision (2026-09-25, Sunny): the wall shows a 2-pip meter, "calm N/2", in the top strip right after Risk. It is display only. The engine does not enforce a calm streak.

## Rule the meter shows

- The streak starts at 0 for each run.
- A LOW tick adds 1, up to 2.
- A HIGH tick, a `signal_unavailable` tick, or a scene with quality `timeout` or `stale` resets it to 0.
- The Risk cell caption says `normal` only at 2/2. Before that it says "1 more calm reading". HIGH and fail-safe ticks keep the engine's `policy_reason`.
- The Floor cell always keeps the engine's `policy_reason`, because it reports the floor the engine actually set.
- A wall scene is a staged tick with no history, so it is counted on its own.

On the layout fixture, ticks 9, 10, 11, and 12 read 0/2, 1/2, 2/2, and 2/2.

## Gap to know about

`reserve_policy` (see `CONSTRAINTS.md`) returns `base_reserve_pct` with reason `normal` on the first LOW tick. So at tick 10 the fleet is already selling at the 30% floor while the meter reads 1/2. The two-calm rule comes from `plan.md` Slice 5, and it was never built into the engine. For the engine to gate on it, Uma would have to add the streak to `reserve_policy` and a field to `TickResult`. Then the wall should read that field instead of counting ticks itself.

## Code

- `web/src/calmStreak.ts`: `calmStep`, `calmStreak`, `riskCaption`
- `web/src/components/molecules/CalmMeter.tsx`
- `web/tests/calmStreak.test.ts`
