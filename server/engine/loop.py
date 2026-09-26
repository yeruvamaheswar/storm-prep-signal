"""Tick loop: python -m server.engine --tape PATH | --live [--tape PATH]"""
import argparse
import json
import sys
from dataclasses import asdict
from datetime import datetime, timedelta
from pathlib import Path

from server.engine.baseline import load_baseline
from server.engine.cli import read_settings
from server.engine.contracts import Allocation, Home, TapeFrame, TickResult
from server.engine.events import log_event, start_run
from server.engine.policy import reserve_policy
from server.engine.risk import compute_risk
from server.engine.signal import CENTRAL, LIVE_SOURCE, SignalUnavailable, load_signal, to_signal

LOG_DIR = Path("var") / "logs"
RUNS_DIR = Path("var") / "runs"
SETTINGS_KEYS = ("fleet_size", "home_kwh", "home_max_kw", "base_reserve_pct", "storm_reserve_pct", "tick_minutes")
# --live with no tape plays this many ticks at a flat synthetic target (not a real grid request).
SYNTHETIC_TICKS = 12
SYNTHETIC_TARGET_MW = 0.2


# TEMP until rajat/controller and sunny/tape-brief merge
def load_tape(path):
    return [TapeFrame(**frame) for frame in json.loads(Path(path).read_text())["frames"]]


def new_fleet(settings):
    kwh = settings["home_kwh"]
    return [Home(f"home-{i:03d}", kwh, 0.6 * kwh, settings["home_max_kw"])
            for i in range(1, settings["fleet_size"] + 1)]


def apply_events(homes, events):
    pass


def allocate(homes, frame, policy, mode, settings):
    return Allocation({home.home_id: 0.0 for home in homes}, 0.0, frame.target_mw, ["temp_stub"])


def discharge(homes, alloc, policy, settings):
    return 0


def write_brief(result):
    return ""
# end TEMP


def rate(path, baseline, settings):
    """Load one ERCOT posting and rate it: the saved file at `path`, or a live fetch when path is None.

    Live loading applies FETCH_TIMEOUT_S and the stale check (see signal.load_signal).
    """
    loaded = load_signal(argparse.Namespace(fixture=False, file=path), settings)
    signal = to_signal(loaded["raw"], loaded["now"])
    return compute_risk(signal, baseline, margin_pct=settings["margin_pct"],
                        lookahead_hours=settings["lookahead_hours"])


def read_risk(path, baseline, settings):
    """Rate one saved posting. Any failure returns None, which the policy treats as fail safe."""
    try:
        return rate(path, baseline, settings)
    except Exception as exc:
        log_event("compute_risk", "failed", ok=False, reason=f"{type(exc).__name__}: {exc}", path=path)
        return None


def read_live_risk(baseline, settings):
    """Fetch ERCOT once and rate it. Any failure returns None, logged and printed, never hidden."""
    try:
        risk = rate(None, baseline, settings)
    except Exception as exc:
        reason = str(exc) if isinstance(exc, SignalUnavailable) else f"{type(exc).__name__}: {exc}"
        log_event("compute_risk", "failed", ok=False, reason=reason, source=LIVE_SOURCE)
        print(f"live: risk unknown | {reason} | source: {LIVE_SOURCE}")
        return None
    log_event("compute_risk", "ok", source=LIVE_SOURCE, **asdict(risk))
    print(f"live: risk {risk.level} | source: {LIVE_SOURCE}")
    return risk


def synthetic_frames(settings, start):
    """The frames used by --live with no tape: a flat target, labeled synthetic, no price."""
    step = timedelta(minutes=settings["tick_minutes"])
    return [TapeFrame(tick=i, ts=(start + (i - 1) * step).isoformat(timespec="seconds"),
                      target_mw=SYNTHETIC_TARGET_MW, target_label="synthetic",
                      price_usd_mwh=None, price_label="none")
            for i in range(1, SYNTHETIC_TICKS + 1)]


def count(homes, status):
    return sum(home.status == status for home in homes)


def run(tape_path, settings, log_dir=LOG_DIR, runs_dir=RUNS_DIR, live=False):
    """Play every frame of the tape through the fleet. Returns the run record written to disk.

    live=True fetches ERCOT once and uses that risk on every tick, ignoring the frames' risk
    fixtures. With no tape it plays SYNTHETIC_TICKS synthetic frames.
    """
    run_id = start_run(log_dir)
    baseline = load_baseline(lookahead_hours=settings["lookahead_hours"])
    live_risk = read_live_risk(baseline, settings) if live else None
    frames = load_tape(tape_path) if tape_path else synthetic_frames(settings, datetime.now(CENTRAL))
    homes = new_fleet(settings)
    mode = "AUTO"
    ticks = []
    for frame in frames:
        apply_events(homes, frame.events)
        if live:
            risk = live_risk
        else:
            risk = read_risk(frame.risk_fixture, baseline, settings) if frame.risk_fixture else None
        policy = reserve_policy(risk, settings)
        mode = frame.events.get("operator", mode)
        alloc = allocate(homes, frame, policy, mode, settings)
        breaches = discharge(homes, alloc, policy, settings)
        result = TickResult(
            tick=frame.tick, ts=frame.ts, mode=mode,
            target_mw=frame.target_mw, target_label=frame.target_label,
            delivered_mw=alloc.delivered_mw, missed_mw=alloc.missed_mw,
            price_usd_mwh=frame.price_usd_mwh, price_label=frame.price_label,
            reserve_pct=policy.reserve_pct, policy_reason=policy.reason, risk_level=policy.risk_level,
            live_homes=count(homes, "live"), stale_homes=count(homes, "stale"), dead_homes=count(homes, "dead"),
            breaches=breaches, reasons=list(alloc.reasons),
        )
        brief = write_brief(result)
        log_event("tick", "ok", **asdict(result), brief=brief)
        print(f"tick {result.tick}: delivered {result.delivered_mw:.3f} of {result.target_mw:.3f} MW"
              f" ({result.target_label} target) | reserve {result.reserve_pct:g}% | {result.policy_reason}")
        ticks.append({**asdict(result), "brief": brief})

    record = {
        "run_id": run_id,
        "tape": str(tape_path) if tape_path else "synthetic",
        "source": "live" if live else "scenario",
        "settings": {key: settings[key] for key in SETTINGS_KEYS},
        "ticks": ticks,
        "totals": {},
    }
    runs_dir = Path(runs_dir)
    runs_dir.mkdir(parents=True, exist_ok=True)
    text = json.dumps(record, indent=2)
    (runs_dir / f"{run_id}.json").write_text(text)
    (runs_dir / "latest.json").write_text(text)
    return record


def main(argv=None):
    parser = argparse.ArgumentParser(prog="server.engine", description="Run a tape through the fleet.")
    parser.add_argument("--tape", help="path to a tape JSON file (optional with --live)")
    parser.add_argument("--live", action="store_true", help="fetch ERCOT once and use that risk on every tick")
    args = parser.parse_args(argv)
    if not (args.tape or args.live):
        parser.error("give --tape PATH, --live, or both")
    run(args.tape, read_settings(), live=args.live)
    return 0


if __name__ == "__main__":
    sys.exit(main())
