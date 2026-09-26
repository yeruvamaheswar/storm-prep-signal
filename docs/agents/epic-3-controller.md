# Epic 3: the controller, fleet and scoring lane (Rajat)

What this lane builds, in Sunny's story format, plus notes for Uma and Sunny on how to adjust. Source of truth for the lane. Open this file when a task touches `controller.py`, `fleet.py`, `score.py`, `scheduler.py`, `channel.py`, `orchestration.py` or their tests.


**Why it exists:** the grid asks for a total amount of power. Someone has to decide which homes give how much, never break a home's backup floor, and keep working when homes go offline, messages get lost, or a zone stalls. This epic is the "orchestration" in the Orchestration track.

**The one idea:** we may miss the target. We never break a reserve.

**Order of work (cut lines, top first):** Tracer (3.1 to 3.3), Kernel (3.4, 3.5), Runtime (3.6, 3.7), Evidence (3.8). Stretch (3.9) only if all of those are green.

---

### Cut line 0: the tracer works

**Story 3.1: The fleet and its zones** (`fleet.py`) `P0` `next few hours`
> As an operator, I want 100 simulated homes spread across the four ERCOT zones with different charge levels and a status of live, stale or dead, so that the demo looks like a real fleet in real regions.
- Acceptance:
  - 100 homes, 25 per zone. Zone comes from one small function, `assign_zone`, round-robin by home index by default.
  - Charge spread evenly from 45% to 75% by index, with no randomness.
  - `apply_events` sets status only. An unknown status is rejected.
- Say it out loud: "Spreading the charge levels matters. When a zone's floor jumps to 60%, about half its homes drop out, so a storm has a visible effect."

**Story 3.2: The allocator** (`controller.py`) `P0` `next few hours`
> As an operator, I want the target split across live homes in proportion to what each can safely give, using each home's zone floor, so that no home is drained below its floor.
- Acceptance:
  - Pure function: no files, clock, network or randomness, and it never changes the homes.
  - The target is converted from MW to kW once. A 0.5 MW target counts as 500 kW.
  - Each home's floor is `zone_reserve_pct` for its zone, falling back to `reserve_pct`. An unknown zone gets 0 and the reason `unknown_zone`.
  - Each home's cap is the smaller of its max kW and its energy above the floor spread over the tick, rounded down.
  - Caps at or under the target: every home runs at its cap. Otherwise each home gets `cap x target / sum of caps`.
  - HOLD gives every home 0 (`operator_hold`). Negative targets are rejected. A zero target does nothing.
  - Every shortfall carries a reason code, with a fixed precedence: `operator_hold` on HOLD; `storm_reserve` when a storm, weather or unavailable-signal reason raised a floor; otherwise `fleet_headroom_short`; plus `homes_dead:<n>`, `homes_stale:<n>` and `unknown_zone` when they apply.
- Say it out loud: "Missing the target is allowed. Breaking a homeowner's floor never is."

**Story 3.3: Applying the orders, with a second floor check** (`fleet.py`, `discharge`) `P0` `next few hours`
> As a judge, I want the charge to drop by exactly what each home really gave, with the floor checked again when the order is applied, so that "zero breaches" is proven and not just claimed.
- Acceptance:
  - Each order is clamped to safe headroom under the home's current zone floor, even if it arrived late or the allocator was wrong.
  - Returns the breach count, which must be 0. A home already under a newly raised floor gets 0 and is not a breach.
  - It is called once per tick and sees no command ids, so "never drains twice" is proven in Story 3.7, where commands exist.
  - The engine tracer prints non-zero delivered MW on the demo tape.
- Say it out loud: "Two checks on the floor: when we decide, and again when it happens."

---

### Cut line 1: the safety kernel is locked

**Story 3.4: The scoreboard** (`score.py`) `P0` `Sat 1:15 PM`
> As an operator, I want running totals per zone and overall, so that I can judge the whole event at a glance.
- Acceptance:
  - Tracks target, delivered (credited), missed, dollars and breaches, total and per zone (delivered per zone; the target is fleet-wide). Lowest charge when the homes are passed in. It fills `totals` in the run file.
  - Dollars follow delivered MWh x price. On the tracer path delivered means planned and applied; on the `run_cycle` path it means confirmed. If there is no price, dollars is None, never $0.
  - A 3-tick example adds up by hand.
- Say it out loud: "The books count what the batteries did, not what we asked."

**Story 3.5: The safety tests** (`tests/test_controller.py`, `test_fleet.py`) `P0` `Sat 1:15 PM`
> As a judge, I want every rule tested directly, so that I trust the system.
- Acceptance:
  - Covered: floors per zone, dead and stale homes get nothing, duplicates ignored, oversized orders clamped, HOLD, zero and negative targets, all homes dead, unknown zone.
  - Every test asserts `breaches == 0` and `missed == target - credited`.
  - No test is ever weakened to make it pass.
- Say it out loud: "Base hires for judgment under failure. These tests are where we show it."

---

### Cut line 2: the orchestration runtime

**Story 3.6: Independent homes on a virtual clock** (`scheduler.py`, `channel.py`, home workers) `P0` `Sat afternoon`
> As a judge, I want to see many independent homes acting at their own pace over a messy network, so that I believe this coordinates independent things.
- Acceptance:
  - A seeded virtual clock runs the whole system, so the same seed gives an identical event log.
  - A channel drops, duplicates and delays orders, all seeded.
  - Each home is its own worker. An error inside one home turns only that home dead and never stops the cycle.
- Say it out loud: "This is a deterministic simulation of a distributed controller. If seed 418 breaks a rule, we replay seed 418."

**Story 3.7: The orchestrator, `run_cycle`** (`orchestration.py`) `P0` `Sat afternoon`
> As an operator, I want a central node and one supervisor per zone that send orders in parallel, collect results on a deadline, and recover, so that a stalled zone or a slow home does not hold up the fleet.
- Acceptance:
  - Timeline in one 5-minute tick: orders at 0 s, confirmations until 60 s, time-outs at 60 s, one retry until 120 s, books close at 120 s. Later results are logged as late.
  - A retry reuses the same command id and payload. A reassignment gets a new id linked to the original.
  - Confirmed means the worker returned `actual_kw`. Unconfirmed work is never counted as delivered.
  - A repeated command id is ignored and counted, and never drains twice.
  - It has its own runner (`python -m server.engine.orchestration --tape ... --seed ...`) so the demo works even before the engine adopts it. Home workers live in `orchestration.py`.
  - One straggler and one dead zone do not stall the cycle, and the other zones still deliver.
  - Returns planned, confirmed, credited, unconfirmed and missed MW, per zone, plus command states and an event log.
- Say it out loud: "The central node doesn't wait for the slowest branch. It closes on a deadline with what is confirmed."

---

### Cut line 3: the evidence

**Story 3.8: Proof and the failure reel** (`tests/test_invariants.py`, failure suite) `P0` `Sat 6:00 PM`
> As a judge, I want random failures thrown at the system many times, so that I know the rules hold beyond the cases we thought of.
- Acceptance:
  - Seeded random fleets, faults, zone kills and floors run for 25 to 50 seeds and 600 or more ticks.
  - All four rules and the money invariants are asserted on every tick.
  - It prints a summary line such as `50 seeds, 600 ticks, 0 floor breaches`. A failing seed is printed with a rerun helper.
  - A manual mutation demo: remove the second floor check on a scratch branch and show the run fail with a seed.
  - The failure suite covers dropped, delayed and duplicated orders, a lost report, a straggler, a worker error, a whole zone down, short delivery, and mass failure.
- Say it out loud: "We don't claim it's safe. We show 50 random runs and zero breaches, and you can replay any of them."

---

### Stretch (only if everything above is green)

**Story 3.9: Beyond the core** `P1` `Sat 6 to 9 PM`
> As a judge, I want extra evidence of depth, so that the project stands out.
- In order: reconciling unknown outcomes across ticks, cross-zone reassignment, a suspect state with an energy-accounting check, a firm-capacity number with a hedge, a 20,000-home benchmark.
- Each item is dropped before anything above it, starting from the bottom.

---

**What this epic needs from others:** Uma's zone-assignment answer, OK for three new files (`scheduler.py`, `channel.py`, `orchestration.py`), and add-only fields for the new per-zone numbers. Sunny's tape can carry fault events later. None of it blocks 3.1 to 3.5.

**How Epic 3 connects to the others:** the storm signal (Epic 1) and zone floors (Epic 2) set each home's floor. This epic splits and executes the work under those floors. Epic 4 shows what happened per zone.

---

## Notes for the team: how to adjust for what Epic 3 is doing

These are suggestions, not edits. Each person owns their own epic and files. Anything marked "optional" can be ignored without breaking the tracer.

### General rules for everyone
- **Treat new fields as optional.** The extra numbers (planned, confirmed, unconfirmed, per-zone) arrive as add-only fields. If a field is missing, show what you have. A cut line might drop it.
- **Same words for the same numbers:** planned = safe power ordered; confirmed = what workers actually returned; credited = `min(confirmed, target)` and is what `delivered_mw` shows; unconfirmed = ordered but not confirmed; missed = `target - credited`, always with a reason.
- **Unconfirmed never counts as delivered and never earns dollars.** Please keep that true on screen, in the brief and in the video. Note: on the plain tracer path (engine calling `allocate` then `discharge`) there is no confirmation step, so delivered means planned and applied there. Only `run_cycle` produces confirmed and unconfirmed figures.
- **The Loom line:** "We may miss the grid's target. We never break a homeowner's reserve, and any failure can be replayed from its seed."

### For Uma (Epics 1 and 2)
- **Story 2.2, reserve floor policy:** the controller uses `Policy.zone_reserve_pct[zone]` per home, with a fallback to `reserve_pct`. Please keep zone floors present for every zone in `ZONES`. A missing zone will be treated as `unknown_zone` and get 0 work.
- **Story 2.3, the engine:**
  - When Stories 3.1 to 3.3 land, delete the TEMP block for `new_fleet`, `apply_events`, `allocate` and `discharge` and import ours. The tracer then shows real delivered MW.
  - In that path, `Allocation.delivered_mw` means planned safe delivery, and `discharge` applies it exactly.
  - Optional, later: replace `allocate` then `discharge` with one call, `run_cycle(homes, frame, policy, mode, settings, seed)`, and read `cycle.allocation` and `cycle.breaches`.
  - `totals` in the run file is filled by `score.py` (`new_board`, `update(board, result, homes=None)`; pass `homes` to get lowest charge). Please have the engine write it.
  - A `seed` setting (default 1) would help replays. Optional.
- **Contracts, add-only:** planned, confirmed and unconfirmed MW, and per-zone versions, on `TickResult`. Reason codes `timed_out:<n>`, `unknown_zone`, `duplicates_ignored:<n>`, `short_delivery:<n>`. We will send exact names when they are needed.
- **Asks that need your OK:** the zone-assignment rule (default is round-robin by home index), and three new files owned by Rajat: `scheduler.py`, `channel.py`, `orchestration.py`.
- **Story 2.4, ship:** the Loom's proof section can use the printed summary line, such as `50 seeds, 600 ticks, 0 floor breaches`, plus one replayed seed.
- **Epic 1:** nothing to change. If the signal is unreadable (risk None), all zones get the storm floor, and the controller handles that as it is.

### For Sunny (Epic 4)
- **Story 4.1, the tape:** it would help to have a few optional fault frames, all labeled synthetic:
  - a zone with many `dead` homes (for the whole-zone-down beat),
  - `duplicate` and `short_delivery` events for a few homes,
  - one frame with a straggler (a slow zone), and
  - one storm frame where different zones have different floors.
  Frames can stay as they are if there is no time.
- **Story 4.2, the brief:**
  - New reason codes may appear: `timed_out:<n>`, `unknown_zone`, and later `duplicates_ignored:<n>` and `short_delivery:<n>`. A default sentence for an unknown code is fine.
  - Please use "credited" or "delivered" only for confirmed power, and describe anything unconfirmed as unconfirmed.
- **Story 4.4, the screen:** optional additions, in order of value:
  1. Per-zone delivered (credited) vs planned, in the four ERCOT zones.
  2. A count of timed-out, retried and reassigned commands for the tick.
  3. Unconfirmed MW shown separately, with a label.
  4. The proof line as a small text block.
  If the new fields are missing, the screen falls back to what it shows today.
- **Story 4.5, demo script and README:**
  - `demo.sh` can also run the proof test and print its summary line, for example with `pytest -q tests/test_invariants.py -s`. That file will exist after Story 3.8.
  - README wording: the fleet, target and price are simulated and labeled, and concurrency is a **deterministic discrete-event simulation** in one process, not real parallel processes.
  - The failure reel in the video matches Story 3.7: an order dropped and retried, a straggler passing the deadline, a home going dead, a whole zone going down, then a storm raising the floors.

### If we cut something, here is what changes for you
| If this is cut | Effect on you |
|---|---|
| Stretch (3.9) | Nothing. It was never promised. |
| The orchestration runtime shrinks (3.6, 3.7) | The tracer, per-zone books and the proof run still exist. Fewer command-state details to show. |
| `run_cycle` is not ready | The engine keeps calling `allocate` then `discharge`. Nothing breaks. |
| Per-zone fields are not added to `TickResult` | Per-zone numbers stay in `totals` and the log only. The screen shows overall numbers. |

### Dates to plan around (Central)
Next few hours: real fleet and allocator, so the tracer works. Sat 1:15 PM: scoreboard and safety tests. Sat afternoon: runtime. Sat 6:00 PM: proof run. Sat 9:00 PM: feature freeze.
