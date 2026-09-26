# ReserveGate × Storm Prep: merged attack plan

Written Fri Sep 25, 7:30 PM CT, by Agent Review. I checked it against `main` at `401713f` "Slice 1: fixture tracer bullet". Slice 1b is not pushed yet.
This doc replaces the team split in `team-onboarding.md` (its setup steps and merge checklist still apply). It does not rewrite plan v3. Here is what happens to v3's slices:
- Slice 1b (rule v2) stays exactly as written.
- Slice 2 (live fetch) becomes a stretch goal.
- Slice 3 (validate and fail_safe) shrinks into `policy.py`.
- Slices 4 and 5 (threaded batteries and hysteresis) are replaced by the fleet and controller below.
- Slice 6 (demo.sh, CI, README) stays with Sunny.

Still open from earlier: ask an organizer about the pre-event commits (Slices 0–1), and disclose them. This merge doesn't change that.

## 1. Product and name

**Name: ReserveGate.** Storm Prep becomes its backtested storm-reserve signal. Keep the repo name `storm-prep-signal`, because renaming mid-hackathon breaks everyone's clone and every link. The README title and the pitch say ReserveGate.

**One paragraph.** ReserveGate is an operator controller for a simulated fleet of home batteries in one ERCOT load zone. Each tick it reads a dispatch target and a price from a labeled tape (synthetic, or recorded from a named public source). It gives discharge work only to live homes that have energy above their reserve floor, and it never pushes a home below that floor. When the Storm Prep signal (rule v2, backtested on ERCOT's public outage postings; it fired on 1.7% of out-of-sample postings, where the old rule fired on 88%) reads HIGH, or when the signal can't be read, the policy raises the floor. Missing the target is then allowed and explained. When homes go dead or stale, the controller moves their work to the remaining homes, and the missed MW stays on screen. An operator can HOLD the fleet or return it to AUTO. After each tick a template brief explains the decision, and nothing reads that brief to make a decision.

**Honest limits (say them in the pitch):**
- The fleet is simulated.
- Battery size and reserve percentages are example simulation settings, not Base specs.
- Target and price come from a tape, and every number carries its label.
- The fleet only discharges. Charging and bidding are out of scope.
- The 15% storm margin was tuned on one month of data. It was not validated on separate data.

## 2. Architecture (freeze in `CONSTRAINTS.md` tonight)

### One tick, in order (`engine.py`)
1. `fleet.apply_events(homes, frame.events)` marks homes dead, stale, or live.
2. If `frame.risk_fixture` is set, run `risk = compute_risk(to_signal(load(fixture)), baseline)`. Rule v2 runs on a real or synthetic ERCOT posting. If that raises an error, `risk = None`.
3. `policy = reserve_policy(risk, settings)`
4. `mode = frame.events.get("operator", mode)`. The mode is AUTO or HOLD.
5. `alloc = allocate(homes, frame, policy, mode, settings)`
6. `breaches = fleet.discharge(homes, alloc, policy, settings)`
7. Build a `TickResult`, then `score.update(board, result)`, then `write_brief(result)`, then `log_event("tick", "ok", **asdict(result), brief=text)`.
8. After the last frame, the engine writes `var/runs/<run_id>.json`. The React app in `web/` reads a copy of that file. No server. There is no `storm_prep/screen.py`.

Command: `python -m storm_prep.engine --tape tapes/demo.json`. The existing `python -m storm_prep --fixture` keeps working unchanged.

### Files and owners (one owner per file; nobody else edits it)

| Owner | Files |
|---|---|
| **Uma** (policy core, glue, and merges) | `storm_prep/contracts.py`, `CONSTRAINTS.md`, `storm_prep/policy.py`, `storm_prep/engine.py`, and the existing `signal.py`, `risk.py`, `events.py`, `decision.py`, `__main__.py`, `batteries.py` (frozen, left alone). Shared files: `requirements.txt`, `.env.example`, `AGENTS.md`, `docs/*`, `pytest.ini`. Tests: `tests/test_risk.py`, `test_run.py`, `test_policy.py`, `test_engine.py`, `tests/fixtures/np3_*.json` |
| **Rajat** (controller and stress) | `storm_prep/controller.py`, `storm_prep/fleet.py`, `storm_prep/score.py`, `tests/test_controller.py`, `tests/test_fleet.py`, `tests/test_score.py`, `tests/fixtures/homes_*.json` |
| **Sunny** (story) | `storm_prep/tape.py`, `storm_prep/brief.py`, `tapes/*.json`, `tests/test_tape.py`, `tests/test_brief.py`, `demo.sh`, `.github/workflows/tests.yml`, `README.md`, `docs/pitch.md`, `web/`, `DESIGN.md` |

If you need something in a file you don't own, like a new dependency, a new setting, or a new contract field, ask its owner in a PR comment. Contract fields can be added, never renamed or removed.

### `storm_prep/contracts.py` (Uma writes this tonight; everyone imports from it)
```python
"""Shared data shapes. Fields may be added, never renamed or removed."""
from dataclasses import dataclass, field
from typing import Optional

@dataclass
class Home:
    home_id: str
    capacity_kwh: float
    soc_kwh: float            # energy stored right now
    max_kw: float             # fastest it can discharge
    status: str = "live"      # "live" | "stale" | "dead"

@dataclass
class TapeFrame:
    tick: int
    ts: str                   # ISO 8601 with UTC offset
    target_mw: float
    target_label: str         # "synthetic" or "recorded:<source>"
    price_usd_mwh: Optional[float]
    price_label: str          # "synthetic", "recorded:<source>", or "none"
    risk_fixture: Optional[str] = None   # path to an ERCOT outage posting
    events: dict = field(default_factory=dict)
    # events keys: "dead", "stale", "live" (lists of home_id), "operator" ("HOLD" | "AUTO")

@dataclass
class Policy:
    reserve_pct: float        # floor as a percent of capacity
    reason: str               # "normal" | "storm_risk_high" | "signal_unavailable"
    risk_level: Optional[str] # "LOW" | "HIGH" | None

@dataclass
class Allocation:
    per_home_kw: dict         # home_id to kW, only for homes given work
    delivered_mw: float
    missed_mw: float          # target_mw minus delivered_mw, never negative
    reasons: list = field(default_factory=list)
    # reason codes: "operator_hold", "storm_reserve", "signal_unavailable",
    # "homes_dead:<n>", "homes_stale:<n>", "fleet_headroom_short"

@dataclass
class TickResult:
    tick: int
    ts: str
    mode: str                 # "AUTO" | "HOLD"
    target_mw: float
    target_label: str
    delivered_mw: float
    missed_mw: float
    price_usd_mwh: Optional[float]
    price_label: str
    reserve_pct: float
    policy_reason: str
    risk_level: Optional[str]
    live_homes: int
    stale_homes: int
    dead_homes: int
    breaches: int             # homes discharged below their floor this tick; must be 0
    reasons: list = field(default_factory=list)
```

### Function contracts
| Function | Owner | Signature and promise |
|---|---|---|
| `reserve_policy` | Uma | `(risk: RiskResult \| None, settings) -> Policy`. HIGH gives `storm_reserve_pct`, LOW gives `base_reserve_pct`, and None gives `storm_reserve_pct` with reason `signal_unavailable` (fail safe means keep more backup). |
| `new_fleet` | Rajat | `(settings) -> list[Home]`: `fleet_size` homes, ids `home-001`, and so on. |
| `apply_events` | Rajat | `(homes, events) -> None`: sets status only. |
| `allocate` | Rajat | `(homes, frame, policy, mode, settings) -> Allocation`. Pure function: no I/O, no clock, never mutates homes. |
| `discharge` | Rajat | `(homes, alloc, policy, settings) -> int breaches`: lowers soc by `kw × tick_minutes / 60`. |
| `new_board` / `update` | Rajat | cumulative target, delivered and missed MWh, total breaches, and lowest soc %. |
| `load_tape` | Sunny | `(path) -> list[TapeFrame]`. Rejects a frame with no labels or with a naive `ts`. |
| `write_brief` | Sunny | `(result: TickResult) -> str`, one or two sentences built only from the result's fields. |
| `log_event` | Uma (exists) | the 7 fields (`ts, run_id, stage, event, ok, reason, data`) plus `decision_line` on the final event. Tick data goes inside `data`. |

### Allocation rule (Rajat implements it; Uma must be able to say it out loud)
1. If mode is HOLD, give every home 0 kW, set missed to the target, and add reason `operator_hold`.
2. A home is eligible only if it's `live`. Dead and stale homes get 0, because we don't send work to a home we can't hear from.
3. Headroom is `soc_kwh − reserve_pct/100 × capacity_kwh`. A home's cap is `min(max_kw, headroom_kwh × 60 / tick_minutes)`, and a home with no headroom has cap 0.
4. If the sum of caps is at or below the target, every home runs at its cap. Otherwise each home gets `cap × target / sum_caps` (proportional).
5. `missed = target − delivered`. Add reason codes whenever missed is above 0.

### Invariants (the tests and `CONSTRAINTS.md` both state these)
- No home is ever discharged below its floor, so `breaches == 0` on every tick of every tape.
- `0 ≤ delivered ≤ target` and `missed == target − delivered`, compared with a small tolerance.
- Dead and stale homes get 0 kW, and HOLD delivers 0.
- Nothing reads the brief. It's written after the decision.
- Every target and price shown on screen shows its label. No unlabeled $/MWh or MW anywhere.

### Example simulation settings (Uma adds these to `.env.example`, labeled as made-up simulation values, not Base specs)
`FLEET_SIZE=100`, `HOME_KWH=20`, `HOME_MAX_KW=5`, `HOME_START_SOC_MIN_PCT=45`, `HOME_START_SOC_MAX_PCT=75`, `BASE_RESERVE_PCT=30`, `STORM_RESERVE_PCT=60`, `TICK_MINUTES=5`. With these, the fleet tops out at 0.5 MW, so tape targets should run from 0.1 to 0.6 MW. `new_fleet` spreads starting charge evenly from 45% to 75% by home index, with no randomness. That spread matters for the demo. When the floor rises to 60%, roughly half the homes drop out, so the storm tick shows a partial miss instead of either no effect or zero delivered. (I checked this: if every home starts at the same charge, one 5-minute tick uses so little energy that raising the floor changes nothing until the homes are nearly at it.)

## 3. Per-person attack plans

Everyone:
- Follow the setup in `team-onboarding.md` (clone, venv, `.env` from `.env.example`, `pytest -q`).
- One branch per task, and a PR into `main`.
- Run `git pull origin main` and merge main into your branch right before asking Uma to merge.
- Never commit `.env`, `var/`, or `.venv/`.

### Uma: policy core, glue, merges, Loom
| # | Task | Branch | Done check | Deadline |
|---|---|---|---|---|
| 1 | Push Slice 1b (rule v2, `.env.example` margin set to 15, AGENTS.md signature fix) | `uma/1b-rule-v2` | `pytest -q` passes; real fixture gives LOW, synthetic gives HIGH | Fri 8:30 PM |
| 2 | `contracts.py` + `CONSTRAINTS.md` + sim settings in `.env.example` + copy this doc to `docs/reservegate.md` | `uma/contracts` | `python -c "import storm_prep.contracts"` runs; Rajat and Sunny can see it on main | **Fri 9:30 PM (freeze)** |
| 3 | `policy.py` + `tests/test_policy.py` (HIGH, LOW, and None cases) | `uma/policy` | 3 tests pass | Sat 10:30 AM |
| 4 | `engine.py` + `tests/test_engine.py`. The tracer bullet runs a 3-frame tape end to end. | `uma/engine` | `python -m storm_prep.engine --tape tapes/demo.json` prints delivered vs target for each tick, and the log has `stage: tick` events | Sat 12:30 PM |
| 5 | Write `var/runs/<run_id>.json` and the final `decision_line`. Run the full demo tape. | `uma/engine-final` | `var/runs/<run_id>.json` exists; breaches are 0 on every tick | Sat 5:00 PM |
| 6 | Merge everyone's PRs using the 6-line checklist. Record the Loom. | none | submitted by 10:30 | Sun |

Uma's first Cursor prompt:
```
Read AGENTS.md, docs/plan.md, and CONSTRAINTS.md if it exists. I'm a beginner, so explain each step before doing it and keep changes small.
Task: on a new branch uma/contracts, create storm_prep/contracts.py exactly as written in docs/reservegate.md section 2 (dataclasses Home, TapeFrame, Policy, Allocation, TickResult; do not rename any field). Create CONSTRAINTS.md listing: the file-owner table, the function contracts, the allocation rule, and the invariants from that same section, plus the line "Fields may be added, never renamed or removed. Change only with Uma." Add FLEET_SIZE=100, HOME_KWH=20, HOME_MAX_KW=5, HOME_START_SOC_MIN_PCT=45, HOME_START_SOC_MAX_PCT=75, BASE_RESERVE_PCT=30, STORM_RESERVE_PCT=60, TICK_MINUTES=5 to .env.example under a comment "# Example simulation settings, not Base specs".
Do not touch any other file. Run pytest -q and python -c "import storm_prep.contracts". Show me the diff, then commit with message "Contracts freeze".
```
Uma must not touch Rajat's or Sunny's files. If a teammate's PR is late for the tracer, put a stand-in of 5 lines or fewer in `engine.py`, marked `# TEMP until <branch> merges`, and delete it when the real PR lands.

### Rajat: controller and stress (allocation, fleet, failures, scoring)
| # | Task | Branch | Done check | Deadline |
|---|---|---|---|---|
| 1 | Setup; read `CONSTRAINTS.md` | none | `pytest -q` passes on main | Fri 10 PM |
| 2 | `fleet.py` (`new_fleet`, `apply_events`, `discharge`) + `controller.py` (`allocate`, the 5-step rule) + tests + `tests/fixtures/homes_small.json` (5 homes) | `rajat/controller` | Tests cover under-target, over-target (proportional), HOLD, 1 dead + 1 stale, and a storm floor that leaves some homes with 0 headroom; `breaches == 0` in every case | **Sat 11:00 AM** |
| 3 | `score.py` (`new_board`, `update`) + tests | `rajat/score` | Cumulative MWh adds up by hand on a 3-tick example | Sat 1:15 PM |
| 4 | Failure hardening: a home with soc below its new floor after a storm raise gets 0 and is not a breach; all homes dead gives delivered 0 with reason codes; bad status strings are rejected | `rajat/failures` | 3 new tests pass | Sat 6:00 PM |

Rajat's first Cursor prompt:
```
Read AGENTS.md, CONSTRAINTS.md and docs/reservegate.md (sections 2 and 3). I'm new to this repo; explain before changing.
Task: on branch rajat/controller, build storm_prep/fleet.py and storm_prep/controller.py using only the dataclasses in storm_prep/contracts.py (import them; never redefine or rename fields).
- fleet.new_fleet(settings) -> list[Home], starting charge spread evenly from home_start_soc_min_pct to home_start_soc_max_pct by index (no randomness); fleet.apply_events(homes, events) sets status from "dead"/"stale"/"live" lists; fleet.discharge(homes, alloc, policy, settings) lowers soc_kwh by kw*tick_minutes/60 and returns how many homes ended below reserve_pct of capacity after being given work.
- controller.allocate(homes, frame, policy, mode, settings) -> Allocation, following the 5-step allocation rule in CONSTRAINTS.md exactly. It must be pure: no file, network, clock or random calls, and it must not change the homes list.
Write tests/fixtures/homes_small.json (5 homes) and tests/test_controller.py + tests/test_fleet.py covering: target under capacity, target over capacity (proportional split), HOLD, one dead + one stale home, storm floor. Every test asserts breaches == 0 and missed == target - delivered.
Only create/edit the files named above. Run pytest -q, show the diff, commit, push, and open a PR into main titled "Controller + fleet".
```
Files Rajat must not touch: `contracts.py`, `CONSTRAINTS.md`, `policy.py`, `engine.py`, `risk.py`, `signal.py`, `events.py`, `decision.py`, `__main__.py`, `batteries.py`, `requirements.txt`, `.env.example`, anything in `tapes/`, `brief.py`, `tape.py`, `web/`, `README.md`, and CI.
Interfaces Rajat depends on: `Home`, `TapeFrame.target_mw` and `.events`, `Policy.reserve_pct`, `Allocation`, and the settings keys `fleet_size, home_kwh, home_max_kw, home_start_soc_min_pct, home_start_soc_max_pct, tick_minutes`.

### Sunny: story (tape, brief, React wall, demo, CI, README, pitch)
| # | Task | Branch | Done check | Deadline |
|---|---|---|---|---|
| 1 | Setup; read `CONSTRAINTS.md` | none | `pytest -q` passes | Fri 10 PM |
| 2 | `tape.py` (`load_tape`) + `tapes/demo.json` + `brief.py` (`write_brief` template) + tests | `sunny/tape-brief` | Tape loads 12 frames; a frame with no label or a naive ts is rejected; the brief for a storm tick names the raised floor and the missed MW | **Sat 11:00 AM** |
| 3 | `.github/workflows/tests.yml` (runs `pytest -q` on push and PR) + README draft | `sunny/ci-readme` | Green check on the PR | Sat 1:15 PM |
| 4 | `web/` operator wall: delivered vs target per tick, reserve %, live/stale/dead counts, labels, and the last brief | `sunny/web` | `npm run dev` in `web/` shows the wall from `/runs/latest.json`; every number shows its label | Sat 6:00 PM |
| 5 | `demo.sh` (the failure reel: runs the demo tape, then prints each tick's reasons) + `docs/pitch.md` | `sunny/demo` | `bash demo.sh` runs clean on a fresh clone | Sat 9:00 PM |
| 6 (stretch) | Host the same `web/` build. Buttons stay display-only unless Uma adds a command contract. | `sunny/hosted` | The built app loads from a URL and still reads the exported JSON | only if 1–5 are merged by Sat 9 PM |

The demo tape `tapes/demo.json` has 12 frames, all labeled `synthetic`, unless Sunny records real values and names the source:
- Ticks 1–2: calm, target 0.2 MW, `risk_fixture: tests/fixtures/np3_233_cd.json` (real, LOW).
- Ticks 3–4: price spike. Higher price and a 0.4 MW target.
- Tick 5: `risk_fixture: tests/fixtures/np3_spike_synthetic.json` (synthetic, HIGH). The floor rises to 60% and a miss is expected.
- Ticks 6–7: `dead` for 20 homes, then `stale` for 10.
- Tick 8: `operator: HOLD`.
- Tick 9: `operator: AUTO`.
- Ticks 10–12: recovery. Set some homes `live` and switch back to the LOW fixture.

Sunny's first Cursor prompt:
```
Read AGENTS.md, CONSTRAINTS.md and docs/reservegate.md (sections 2 and 3). I'm new to this repo; explain before changing.
Task: on branch sunny/tape-brief, build:
- storm_prep/tape.py: load_tape(path) -> list[TapeFrame] using the TapeFrame dataclass from storm_prep/contracts.py (import it; never redefine or rename fields). Reject any frame missing target_label or price_label, or whose ts has no UTC offset.
- tapes/demo.json: the 12-frame demo tape described in docs/reservegate.md section 3 (Sunny). Every target and price labeled "synthetic". Do not present any number as real ERCOT data.
- storm_prep/brief.py: write_brief(result: TickResult) -> str, a 1-2 sentence template using only fields of result (e.g. "Delivered 0.31 of 0.40 MW (synthetic target). Floor raised to 60% because storm risk is HIGH; 0.09 MW missed on purpose."). No LLM calls.
- tests/test_tape.py and tests/test_brief.py.
Only create/edit those files. Run pytest -q, show the diff, commit, push, and open a PR into main titled "Tape + brief".
```
Files Sunny must not touch: `contracts.py`, `CONSTRAINTS.md`, `policy.py`, `engine.py`, `controller.py`, `fleet.py`, `score.py`, `risk.py`, `signal.py`, `events.py`, `decision.py`, `__main__.py`, `batteries.py`, `requirements.txt`, `.env.example`, `tests/fixtures/`.
Interfaces Sunny depends on: `TapeFrame`, `TickResult` (every field), and the log layout (`var/logs/<run_id>.jsonl`, 7 fields, tick data under `data`, `stage == "tick"`).

## 4. Merge order and timeline (all CT)

Merge order: `uma/1b-rule-v2`, then `uma/contracts`, then `rajat/controller` and `sunny/tape-brief` (either order, since they share no files), then `uma/policy`, then `uma/engine` (the tracer), then `rajat/score`, then `sunny/ci-readme`, then `sunny/web`, then `uma/engine-final`, then `rajat/failures`, then `sunny/demo`.
Why this avoids conflicts: every file has one owner, the shared files are Uma's only, and each person merges main into their branch before asking for a merge. The only place the work comes together is `engine.py`, and only Uma edits it.

| When | What |
|---|---|
| Fri by 8:30 PM | 1b merged |
| Fri by 9:30 PM | Contracts frozen on main. Rajat and Sunny start. Everyone sleeps by a sane hour. |
| Sat 9:00–11:00 AM | First PRs from Rajat and Sunny; Uma does policy |
| Sat 11:00 AM–12:30 PM | Uma merges, then builds the engine tracer. **End-to-end run by 12:30.** |
| Sat 1:15 PM | Score and CI merged |
| **Sat 1:30–2:30 PM** | **Factory tour, protected. No merges.** |
| Sat 2:30–6:00 PM | Screen, failure hardening, full demo tape |
| Sat 6:00–9:00 PM | engine-final, demo.sh, README; first Loom rehearsal |
| Sat 9:00 PM | Feature freeze. Only fixes after this (plus the hosted stretch if everything is merged). |
| Sun 8:00–9:30 AM | Fresh-clone test, `bash demo.sh`, final README. **Code freeze 9:30.** |
| Sun 9:30–10:30 AM | Loom, write-up, submit (hard deadline 11:00) |

**Cut list, in order (cut from the top):**
1. The hosted build of `web/` (local `npm run dev` is the demo)
2. Live outage fetch (v3 Slice 2); the fixtures already show the real rule
3. `rajat/failures` extras beyond the all-dead case
4. The `demo.sh` reason printout (just run the engine)
5. `score.py` cumulative totals (the per-tick delivered vs target is enough)
6. The React wall falls back to the terminal table printed by the engine

Never cut: rule v2 driving the floor, the reserve-floor invariant tests, the labels, or `breaches == 0`.

## 5. What changes in the Loom, write-up and judge Q&A

**Loom (Uma narrates, following the demo tape in order):**
1. The problem: Base sells power from garage batteries that still need to keep the lights on in a blackout.
2. Calm ticks: we hit the target and every floor holds.
3. The price spike: we sell more, but only from energy above each home's floor.
4. The storm signal: the real rule v2 flips to HIGH on the synthetic spike posting. The floor rises, we miss on purpose, and the brief says why.
5. Homes go dead and stale: their work moves to the other homes and the missed MW stays visible.
6. HOLD, then AUTO.
7. Close on the 88% to 1.7% backtest and what we'd ship in a week.

**Write-up changes:**
- ReserveGate is now the product. Storm Prep's backtest is its evidence section.
- Add the honest limits from section 1.
- Credit Sunny for the controller idea and Uma for the signal and backtest.
- Map it to the tracks in Sunny's brief (Open Grid Data, Orchestration, Commercializable). Check them against the official guide's actual track names before submitting.

**Judge Q&A (prep these answers):**
- *Are the target and price real?* No. They come from a labeled synthetic tape. The outage postings behind the storm signal are real ERCOT public data, apart from the one labeled synthetic spike.
- *Why rules and not an LLM?* Dispatch has to be fast, testable and explainable. The brief is text written after the decision and never feeds back into it.
- *What happens if the signal fails?* The floor goes up, not down. Losing information means keeping more backup.
- *How good is the storm rule?* It fired on 1.7% of out-of-sample postings where the old rule fired on 88%. The 15% margin was tuned on one month and not validated, and we say so.
- *What ships in a week?* Following a real ERCOT or utility target on real devices, fed by live postings (v3 Slice 2).
- *Why proportional allocation?* It's simple and predictable, and it's easy to prove it never breaks a floor. Smarter allocation, like draining the fullest homes first, is next.
