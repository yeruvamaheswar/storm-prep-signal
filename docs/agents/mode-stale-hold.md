# Stale Hold after requesting Auto

**Decision (2026-09-26).** `GET /v1/snapshot` strips a stale `operator_hold` when it overlays a requested AUTO onto the last dispatched HOLD tick, and the wall reads an AUTO full miss with no reason codes as "next dispatch pending" instead of Hold. `POST /v1/fleet/mode` only flips the wall to Auto after the write succeeds.

Open this file when you change snapshot mode overlay, the fleet intent banner, or the Hold/Auto POST path.

## What the wall showed

Live, 10k fleet, target 40 MW (synthetic): masthead AUTO, banner "Hold above the 30% floor. Delivered 0.00 of 40.00 MW", reasons "Operator hold", delivered 0. The run file still held the last HOLD dispatch (`mode` HOLD, `delivered_mw` 0, `reasons` `['operator_hold']`); the snapshot had overlaid the requested AUTO without touching the other fields.

## Why

- `server/engine/fleet_state.py` `apply_mode` overlays `var/state.json` onto the tick. That overlay is required (`tests/test_snapshot_mode.py`), so the mode flips up to 5 minutes before the next `live_cycle` dispatch runs.
- The engine invariant is `operator_hold` ⟺ mode HOLD at dispatch (`server/engine/controller.py`). The overlay broke it: AUTO + `operator_hold` + 0 MW.
- The wall made it worse: `OperatorWall.showMode` set the local Auto before the POST resolved, so even a failed write looked like Auto.

## Fix (this gap)

- `server/api/snapshot.py` `_reconcile_mode_overlay`: on an AUTO overlay of a HOLD tick, drop `operator_hold` from reasons, clear a matching intent reason, and rebuild the brief. Delivered MW stays stale on purpose; routes still do not allocate. A HOLD overlay keeps the dispatched reasons untouched.
- `web/src/fleetIntent.ts` `isPendingAuto`: AUTO + delivered ≤ 0 + full miss + zero reasons reads as "Auto requested — next dispatch pending". A real miss always carries a code (`storm_reserve`, `fleet_headroom_short`, `homes_dead:n`, ...), so empty means the next dispatch has not run yet. Action stays `hold`, so styling and the exhaustive switch are unchanged.
- `web/src/components/templates/OperatorWall.tsx` `showMode`: the Live POST resolves before the local flip. A failed write keeps showing the engine's mode.

## Checks

- `tests/test_snapshot_mode.py`: AUTO overlay strips the stale hold; HOLD overlay keeps dispatched reasons.
- `web/tests/fleetIntent.test.ts`: AUTO full miss with no codes reads pending, never "Operator hold".
- `pytest -q` full suite; `vitest` on `fleetIntent`, `wallMode`, `wallSnapshot`; `tsc --noEmit` clean.
- Live proof: after the next `live_cycle` tick with state AUTO, snapshot returned AUTO + 40.0 MW delivered.
