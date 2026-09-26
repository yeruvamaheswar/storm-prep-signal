"""Tick loop: python -m storm_prep.engine --tape PATH"""
import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path

from storm_prep.__main__ import read_settings
from storm_prep.baseline import load_baseline
from storm_prep.contracts import Allocation, Home, TapeFrame, TickResult
from storm_prep.events import log_event, start_run
from storm_prep.policy import reserve_policy
from storm_prep.risk import compute_risk
from storm_prep.signal import load_signal, to_signal

LOG_DIR = Path("var") / "logs"
RUNS_DIR = Path("var") / "runs"
SETTINGS_KEYS = ("fleet_size", "home_kwh", "home_max_kw", "base_reserve_pct", "storm_reserve_pct", "tick_minutes")


# TEMP until rajat/controller and sunny/tape-brief merge
def load_tape(path):
    return [TapeFrame(**frame) for frame in json.loads(Path(path).read_text())]


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


def read_risk(path, baseline, settings):
    """Rate one ERCOT posting. Any failure returns None, which the policy treats as fail safe."""
    try:
        loaded = load_signal(argparse.Namespace(fixture=False, file=path))
        signal = to_signal(loaded["raw"], loaded["now"])
        return compute_risk(signal, baseline, margin_pct=settings["margin_pct"],
                            lookahead_hours=settings["lookahead_hours"])
    except Exception as exc:
        log_event("compute_risk", "failed", ok=False, reason=f"{type(exc).__name__}: {exc}", path=path)
        return None


def count(homes, status):
    return sum(home.status == status for home in homes)


def run(tape_path, settings, log_dir=LOG_DIR, runs_dir=RUNS_DIR):
    """Play every frame of the tape through the fleet. Returns the run record written to disk."""
    run_id = start_run(log_dir)
    baseline = load_baseline(lookahead_hours=settings["lookahead_hours"])
    homes = new_fleet(settings)
    mode = "AUTO"
    ticks = []
    for frame in load_tape(tape_path):
        apply_events(homes, frame.events)
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
        "tape": str(tape_path),
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
    parser = argparse.ArgumentParser(prog="storm_prep.engine", description="Run a tape through the fleet.")
    parser.add_argument("--tape", required=True, help="path to a tape JSON file")
    args = parser.parse_args(argv)
    run(args.tape, read_settings())
    return 0


if __name__ == "__main__":
    sys.exit(main())
