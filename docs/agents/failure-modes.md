# Failure modes: simulated faults a tape or `.env` can switch on

**Decision (2026-09-26).** Faults are scheduled per tick with tape events, or set for a whole run in `.env`. `orchestration.tick_faults` applies them inside `orchestrate_tick`, so `loop.py` and the runner need no change. Every tick with an injected fault gets the reason `faults_injected`, so the screen never shows a simulated failure as a real one. Floors hold under every fault: the fuzzer and `tapes/failures.json` both show 0 breaches.

## Tape events (per tick, in `frame.events`)

| Key | Shape | Effect |
|---|---|---|
| `network` | `{"drop_rate": 0-1, "dup_rate": 0-1, "late_rate": 0-1}` | The lossy channel's rates for this tick. Lost orders time out at 60 s, retry once, and count as unconfirmed at 120 s. |
| `crash` | `["home-061", ...]` | Those homes' workers raise when they run an order. The home goes `dead` and stays dead until a `live` event. A listed home with no order this tick is not touched. |
| `misreport` | `{"home-081": 1.5}` | Those homes report factor × what they really gave. The charge-drop check catches it (`charge_mismatch:<n>`) and books the smaller number. |
| `short_delivery` | `{"home-001": 0.5}` | (existing) The home delivers that fraction of its order. |

A bad rate, a negative factor, an unknown key, or a home not in the fleet raises `ValueError`. A tape typo stops the run instead of passing quietly.

## Whole run (`.env`)

`CHANNEL_DROP_RATE`, `CHANNEL_DUP_RATE`, `CHANNEL_LATE_RATE` (default 0) set the network for every tick. A tape `network` event overrides them for its tick. These settings alone do not add `faults_injected`; the run's settings record them.

## Demo tape

`tapes/failures.json` is `tapes/demo.json` plus: tick 3 bad network (40% lost), tick 5 five homes crash, tick 7 two homes misreport, tick 9 worse network (60% lost). Run: `python -m server.engine --tape tapes/failures.json`. `tests/test_tracer.py` pins it: faults on ticks 3, 5, 7, 9 only, 0 breaches.

## Code

- `server/engine/orchestration.py`: `tick_faults`, `NETWORK_RATES`, the `faults_injected` reason in `orchestrate_tick`.
- `server/engine/cli.py`: the three `CHANNEL_*` settings.
- Tests: `tests/test_orchestration.py` (events, validation), `tests/test_run.py` (settings), `tests/test_tracer.py` (the tape).
