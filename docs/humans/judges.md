# ReserveGate: judges start here

## 1. What it is

ReserveGate runs 100 simulated home batteries across ERCOT's 4 load zones (Houston, North, South, West) on 5-minute ticks, and never discharges a home below its reserve floor. Rules decide every battery action; text only explains the decision afterward.

## 2. Run it in 60 seconds

From the repo root, with Python 3:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python3 -m server.engine --tape tapes/demo.json
python3 -m pytest -q
```

After the one-time `pip install`, it works offline. Wi-Fi is optional. The tape run needs no API keys and makes no network calls. It prints one line per tick and writes `var/runs/latest.json`.

Every tape run starts from a fresh fleet, so the demo prints the same total every time you run it.

## 3. What you'll see

The 12 ticks of `tapes/demo.json`. Targets and prices on this tape are labeled `synthetic`.

| Ticks | What happens | What the engine does |
|---|---|---|
| 1–2 | Calm grid, 0.2 MW target | Floor 30%, target met |
| 3 | Price spike: $220/MWh, target 0.4 MW | Floor 30%, target met |
| 4 | Weather warning for Houston only | Houston floor 60%, other zones 30%, target met |
| 5 | Outage report spikes: storm risk HIGH | Floor 30% → 60% in every zone; delivered 0.145 of 0.4 MW |
| 6–7 | 20 homes go dead, then 10 go stale | Those homes get 0 kW; the rest keep working |
| 8–9 | Operator presses HOLD, then AUTO | Tick 8 sends 0 MW; tick 9 resumes at the 60% floor |
| 10–11 | Calm again; homes come back | Floor 30%, target met |
| 12 | Outage report missing | Every zone to 60%, 0 MW discharged |

The last line:

```
run total: delivered 0.164 of 0.317 MWh (51.9%) | floor breaches 0 | hold ticks 1
```

The 51.9% is deliberate. On ticks 5–9 and 12 the engine keeps 60% of every battery for backup, and on tick 8 the operator held. It misses the target rather than drain a family's reserve. The rule is "we may miss the target; we never break a reserve."

## 4. Failure handling

All test files are in `tests/`.

| Failure | What the engine does | Test |
|---|---|---|
| ERCOT outage report missing, fetch timed out, or report older than 90 min | Risk unknown, so 60% floor in every zone with reason `signal_unavailable`; never a discharge intent | `test_engine.py`, `test_signal.py`, `test_policy.py`, `test_replay_offline.py` |
| Home dead or stale | That home gets 0 kW (`homes_dead:n`, `homes_stale:n`); the rest still deliver | `test_controller.py`, `test_failures.py`, `test_orchestration.py` |
| Order or reply lost on the simulated network | Retry at 60 s with the same id; books close at 120 s; unanswered work is not counted as delivered | `test_failures.py`, `test_orchestration.py` |
| Duplicate message | Each command runs once; the copy is ignored | `test_orchestration.py`, `test_failures.py` |
| Reply arrives after the 120 s close | Logged, not counted | `test_orchestration.py` |
| Home reports more energy than its battery gave | Booked at the real charge drop, reason `charge_mismatch:n` | `test_failures.py`, `test_orchestration.py` |
| Battery telemetry reports a frozen charge (`--telemetry` runner only) | Flagged suspect after its first order, then gets no work | `test_telemetry.py` |
| Operator HOLD | 0 kW to every home, reason `operator_hold` | `test_controller.py`, `test_orchestration.py` |

## 5. How we know it's safe

| Invariant | Proved by |
|---|---|
| 0 floor breaches on every tick | `test_invariants.py` (30 seeded random worlds, 12 ticks each, with lost, duplicated and late messages, dead zones, and crashing or lying homes), `test_failures.py`, `test_replay_offline.py` (every tick of the demo and Heather tapes) |
| Delivered ≤ target, and missed = target − delivered | `test_invariants.py`, `test_failures.py`, `test_replay_offline.py` |
| The same tape replays identically | `test_replay_offline.py`: two runs of the demo and Heather tapes match tick for tick, and two CLI runs in the same folder both give 0.164 of 0.317 MWh |
| A tape run needs no network and writes nothing outside its own folder | `test_replay_offline.py` blocks every outbound connection, checks none was attempted, and checks the repo's `var/` is unchanged after CLI runs from other folders |

## 6. Honest limits

- The homes and the network are simulated. No real battery is controlled.
- Targets and prices on the demo tape are practice numbers. Fleet settings (20 kWh, 5 kW, 30% and 60% floors) are example values, not Base specs.
- The 15% storm margin was tuned on one month of data and has not been validated. The storm replays come from two archived events, Beryl and Heather.
- Weather warnings come from the tape, not a live NWS feed.

## 7. Where to read next

- [System design](../agents/system-design.md): the parts, the decisions, and every failure case.
- [Code flow](../agents/code-flow.md): one tick through the code, file by file.
