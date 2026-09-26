# Constraints (frozen)

Fields may be added, never renamed or removed. Change only with Uma.

Source: `docs/reservegate.md` section 2. The data shapes live in `storm_prep/contracts.py`.

## Files and owners (one owner per file; nobody else edits it)

| Owner | Files |
|---|---|
| **Uma** (policy core, glue, and merges) | `storm_prep/contracts.py`, `CONSTRAINTS.md`, `storm_prep/policy.py`, `storm_prep/engine.py`, and the existing `signal.py`, `risk.py`, `events.py`, `decision.py`, `__main__.py`, `batteries.py` (frozen, left alone). Shared files: `requirements.txt`, `.env.example`, `AGENTS.md`, `docs/*`, `pytest.ini`. Tests: `tests/test_risk.py`, `test_run.py`, `test_policy.py`, `test_engine.py`, `tests/fixtures/np3_*.json` |
| **Rajath** (controller and stress) | `storm_prep/controller.py`, `storm_prep/fleet.py`, `storm_prep/score.py`, `tests/test_controller.py`, `tests/test_fleet.py`, `tests/test_score.py`, `tests/fixtures/homes_*.json` |
| **Sunny** (story) | `storm_prep/tape.py`, `storm_prep/brief.py`, `storm_prep/screen.py`, `tapes/*.json`, `tests/test_tape.py`, `tests/test_brief.py`, `tests/test_screen.py`, `demo.sh`, `.github/workflows/tests.yml`, `README.md`, `docs/pitch.md`, `app/` (stretch) |

If you need something in a file you don't own, like a new dependency, a new setting, or a new contract field, ask its owner in a PR comment. Contract fields can be added, never renamed or removed.

## Function contracts

| Function | Owner | Signature and promise |
|---|---|---|
| `reserve_policy` | Uma | `(risk: RiskResult \| None, settings) -> Policy`. HIGH gives `storm_reserve_pct`, LOW gives `base_reserve_pct`, and None gives `storm_reserve_pct` with reason `signal_unavailable` (fail safe means keep more backup). |
| `new_fleet` | Rajath | `(settings) -> list[Home]`: `fleet_size` homes, ids `home-001`, and so on. |
| `apply_events` | Rajath | `(homes, events) -> None`: sets status only. |
| `allocate` | Rajath | `(homes, frame, policy, mode, settings) -> Allocation`. Pure function: no I/O, no clock, never mutates homes. |
| `discharge` | Rajath | `(homes, alloc, policy, settings) -> int breaches`: lowers soc by `kw × tick_minutes / 60`. |
| `new_board` / `update` | Rajath | cumulative target, delivered and missed MWh, total breaches, and lowest soc %. |
| `load_tape` | Sunny | `(path) -> list[TapeFrame]`. Rejects a frame with no labels or with a naive `ts`. |
| `write_brief` | Sunny | `(result: TickResult) -> str`, one or two sentences built only from the result's fields. |
| `render` | Sunny | `(log_path) -> Path`: one static HTML file from `stage == "tick"` events. No server needed. |
| `log_event` | Uma (exists) | the 7 fields (`ts, run_id, stage, event, ok, reason, data`) plus `decision_line` on the final event. Tick data goes inside `data`. |

## Allocation rule (Rajath implements it; Uma must be able to say it out loud)

1. If mode is HOLD, give every home 0 kW, set missed to the target, and add reason `operator_hold`.
2. A home is eligible only if it's `live`. Dead and stale homes get 0, because we don't send work to a home we can't hear from.
3. Headroom is `soc_kwh − reserve_pct/100 × capacity_kwh`. A home's cap is `min(max_kw, headroom_kwh × 60 / tick_minutes)`, and a home with no headroom has cap 0.
4. If the sum of caps is at or below the target, every home runs at its cap. Otherwise each home gets `cap × target / sum_caps` (proportional).
5. `missed = target − delivered`. Add reason codes whenever missed is above 0.

## Invariants (the tests and `CONSTRAINTS.md` both state these)

- No home is ever discharged below its floor, so `breaches == 0` on every tick of every tape.
- `0 ≤ delivered ≤ target` and `missed == target − delivered`, compared with a small tolerance.
- Dead and stale homes get 0 kW, and HOLD delivers 0.
- Nothing reads the brief. It's written after the decision.
- Every target and price shown on screen shows its label. No unlabeled $/MWh or MW anywhere.
