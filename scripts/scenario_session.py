"""Scenario session worker for the /flow page. Runs on the laptop, or beside uvicorn on Render (render.yaml).

Usage: python scripts/scenario_session.py [--scenario heather] [--seed 42] [--steps N]

Loop: read new operator requests from var/scenario/requests.json (written by POST /v1/scenario/*),
apply them, play one engine tick when the time-lapse clock says so, and rewrite
var/scenario/state.json (read by GET /v1/scenario/state). This process is the only one that runs
the engine for scenarios; the API never allocates.

Everything it reads is committed (tapes/scenarios/, data/fixtures/), so it runs without wifi.
Stop it with Ctrl-C. --steps N plays N ticks and exits (used by tests and smoke checks).
"""
import argparse
import sys
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server.engine.cli import read_settings  # noqa: E402
from server.engine.scenario import (  # noqa: E402
    CATALOG_PATH,
    SCENARIO_DIR,
    Session,
    last_request_seq,
    load_catalog,
    read_requests,
    write_state,
)

POLL_S = 0.25
HEARTBEAT_S = 1.0


def rescale_next_step(next_step, now, old_step_s, new_step_s):
    """When the next tick is due after a speed change: the time left, at the new rate."""
    if old_step_s == new_step_s or not old_step_s > 0 or next_step <= now:
        return next_step
    return now + (next_step - now) * new_step_s / old_step_s


def tick_left(session, next_step, paused_left, now):
    """Real seconds left in the current tick, for the page's playhead: counting down while playing, the kept
    remainder while paused mid-tick, None when no tick is running or frozen (idle, finished, after Next tick)."""
    if session.playing:
        return round(max(0.0, next_step - now), 3)
    return None if paused_left is None else round(paused_left, 3)


def run(scenario_dir=SCENARIO_DIR, catalog_path=CATALOG_PATH, scenario=None, seed=None, steps=None,
        settings=None, poll_s=POLL_S, clock=time.monotonic, sleep=time.sleep, ignore_old_requests=True):
    """The worker loop. Returns the session after `steps` ticks (or never, without --steps)."""
    scenario_dir = Path(scenario_dir)
    session = Session(settings or read_settings(), load_catalog(catalog_path), log_dir=scenario_dir / "logs")
    # Requests left from an earlier worker are not replayed: the page asks again.
    last_seq = last_request_seq(scenario_dir) if ignore_old_requests else 0
    if scenario:
        session.start(scenario, seed)
    played, next_step, last_write = 0, clock(), None
    # Seconds left in the tick a pause froze; None when no tick is frozen.
    paused_left = None
    while True:
        changed = False
        step_before = session.step_seconds()
        playing_before, index_before = session.playing, session.index
        for request in read_requests(last_seq, scenario_dir):
            session.apply(request)
            last_seq, changed = request["seq"], True
        now = clock()
        step_after = session.step_seconds()
        # A speed change mid-tick keeps the share of the tick already played; only the rest changes pace.
        next_step = rescale_next_step(next_step, now, step_before, step_after)
        if paused_left is not None and step_before > 0 and step_after != step_before:
            paused_left = paused_left * step_after / step_before
        if playing_before and not session.playing:
            # Pause keeps the time left in this tick instead of letting the clock run on.
            paused_left = max(0.0, next_step - now)
        if session.index < index_before:
            # A reset or a new scenario: nothing is left of the old tick.
            next_step, paused_left = now, None
        elif session.index > index_before:
            # Only Next tick moves the index here. The page plays the stepped tick from now, so its window runs
            # from now too, even when Play (or a pause) lands in the same poll; the old tick's remainder is dropped.
            next_step, paused_left = now + step_after, None
        if not playing_before and session.playing:
            # Play resumes the frozen tick, or the rest of a stepped tick (none left if it ran out).
            next_step = now + paused_left if paused_left is not None else max(next_step, now)
            paused_left = None
        # --steps runs as fast as it can; the page run waits for the time-lapse clock.
        if session.playing and (steps is not None or now >= next_step):
            try:
                if session.step():
                    played += 1
            except Exception as exc:
                # A crashed tick stops playback and is named on the page; the worker keeps serving.
                session.playing = False
                session.error = f"{type(exc).__name__}: {exc}"
                session.note(f"tick failed: {session.error}")
                traceback.print_exc()
            next_step, changed = now + session.step_seconds(), True
        if changed or last_write is None or now - last_write >= HEARTBEAT_S:
            state = session.state()
            state["tick_left_s"] = tick_left(session, next_step, paused_left, now)
            write_state(state, scenario_dir)
            last_write = now
        if steps is not None and (played >= steps or not session.playing):
            return session
        sleep(poll_s)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Step the engine over an archive scenario for /flow.")
    parser.add_argument("--scenario", help="scenario id to start right away (see tapes/scenarios/catalog.json)")
    parser.add_argument("--seed", type=int, help="seed for the random starting charge")
    parser.add_argument("--steps", type=int, help="play this many ticks, then exit")
    parser.add_argument("--dir", default=str(SCENARIO_DIR), help="state folder (default %(default)s)")
    args = parser.parse_args(argv)
    print(f"scenario worker: writing {args.dir}/state.json; open /flow in the wall")
    try:
        session = run(scenario_dir=args.dir, scenario=args.scenario, seed=args.seed, steps=args.steps,
                      poll_s=0.0 if args.steps else POLL_S)
    except KeyboardInterrupt:
        return 0
    if session.board:
        print(f"played {session.index} ticks | seed {session.seed} | breaches {session.board['breaches']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
