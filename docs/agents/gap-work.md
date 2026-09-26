# How work is chosen

**Decision (2026-09-26).** File ownership is retired. We do not split the repo by person, and we do not stop because a file used to belong to someone else. We write the desired end state. An agent names **one** gap between that state and the repo. The next sitting fills that gap.

## Desired end state

The product end state is the Outcome and Success sections of `docs/agents/reservegate-summarized.md`. What we will not cut, and what we say out loud, stay in `docs/agents/team-manifest.md`. `CONSTRAINTS.md` still names the shapes, function promises, allocation rule, and invariants. Those are behavior contracts, not file locks.

Do not paste the end state into another file. Link here.

## One gap

When the chat has not already named a gap:

1. Read the end state above.
2. Read `docs/agents/progress.md` for what is already built.
3. Compare the repo to that end state.
4. Name **one** gap: the smallest missing piece a person can finish in one sitting and one branch.
5. Say what “filled” looks like in one or two checks (a test, a visible wall line, a route).
6. Stop. Do not name a second gap. Do not list a backlog.

If the person already named a gap, work that one. Do not substitute a different gap.

A gap may touch any path it needs: engine, API, wall, tests, settings, or notes. Stay inside the behavior `CONSTRAINTS.md` names. Fields may be added, never renamed or removed. New dependencies are a gap of their own; do not slip one into another change.

After the gap is filled, append a short entry to `docs/agents/progress.md` and stop.

## What this replaces

- One owner per file, and “do not edit someone else’s file.”
- Lanes that assign `engine.py`, `web/`, or `controller.py` to a named person.
- Asking a file owner before a shared field, a setting, or a dependency (name the need in the gap instead).

People on the team are still Uma, Rajat, and Sunny. That is who is in the room. It is not a map of which files they may touch.

## Old notes

Weekend attack plans in `docs/agents/reservegate.md` and `docs/agents/plan-of-attack.md` still record who did which Friday task. Those file locks are a record, not a live rule. This file wins on how work is chosen.
