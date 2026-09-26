"""Command line entry point: python -m storm_prep --fixture | --file PATH | --live"""
import argparse
import os
import sys
from dataclasses import asdict
from pathlib import Path

from dotenv import load_dotenv

from storm_prep.baseline import baseline_span, load_baseline
from storm_prep.batteries import apply_to_batteries, new_batteries
from storm_prep.decision import format_decision
from storm_prep.events import log_event, start_run
from storm_prep.policy import reserve_policy
from storm_prep.risk import compute_risk, decide_mode
from storm_prep.signal import LIVE_SOURCE, SignalUnavailable, load_signal, to_signal

LOG_DIR = Path("var") / "logs"


def parse_args(argv):
    parser = argparse.ArgumentParser(prog="storm_prep", description="Rate ERCOT outage risk and set battery modes.")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--fixture", action="store_true", help="use the saved real ERCOT response")
    source.add_argument("--file", help="use a saved ERCOT response at this path")
    source.add_argument("--live", action="store_true", help="fetch the newest posting from ERCOT")
    return parser.parse_args(argv)


def read_settings():
    load_dotenv()
    # The fallbacks match compute_risk's defaults and .env.example.
    return {
        "margin_pct": float(os.getenv("RISK_MARGIN_PCT", "15")),
        "lookahead_hours": int(os.getenv("LOOKAHEAD_HOURS", "6")),
        "fetch_timeout_s": float(os.getenv("FETCH_TIMEOUT_S", "3")),
        # Example simulation settings, not Base specs.
        "fleet_size": int(os.getenv("FLEET_SIZE", "100")),
        "home_kwh": float(os.getenv("HOME_KWH", "20")),
        "home_max_kw": float(os.getenv("HOME_MAX_KW", "5")),
        "home_start_soc_min_pct": float(os.getenv("HOME_START_SOC_MIN_PCT", "45")),
        "home_start_soc_max_pct": float(os.getenv("HOME_START_SOC_MAX_PCT", "75")),
        "base_reserve_pct": float(os.getenv("BASE_RESERVE_PCT", "30")),
        "storm_reserve_pct": float(os.getenv("STORM_RESERVE_PCT", "60")),
        "tick_minutes": int(os.getenv("TICK_MINUTES", "5")),
        # Zone name to anchor county FIPS code; codes stay strings to keep leading zeros.
        "zones": dict(pair.split(":", 1) for pair in
                      os.getenv("ZONES", "Houston:48201,North:48113,South:48355,West:48329").split(",")),
    }


def rate(args, settings, risk_settings):
    """Load the signal and rate it. Each step logs one event."""
    loaded = load_signal(args, settings)
    signal = to_signal(loaded["raw"], loaded["now"])
    log_event("load_signal", "ok", path=loaded["path"], source=loaded["source"],
              clock_pinned=loaded["clock_pinned"], now=loaded["now"], rows=len(signal["rows"]))
    baseline = load_baseline(lookahead_hours=settings["lookahead_hours"])
    log_event("load_baseline", "ok", postings=baseline["postings"],
              baseline_from=baseline["from"], baseline_to=baseline["to"])
    risk = compute_risk(signal, baseline, **risk_settings)
    log_event("compute_risk", "ok", **asdict(risk))
    return loaded, signal, baseline, risk


def signal_unavailable(exc, settings):
    """The live signal failed: log why, treat risk as None, and keep the storm floor."""
    reason = str(exc) if isinstance(exc, SignalUnavailable) else f"{type(exc).__name__}: {exc}"
    log_event("compute_risk", "failed", ok=False, reason=reason, source=LIVE_SOURCE)
    policy = reserve_policy(None, settings)
    batteries = new_batteries()
    acks = apply_to_batteries("RESERVE", batteries)
    log_event("apply_to_batteries", "mode_set", mode="RESERVE", acks=acks)
    line = (f"[RESERVE] risk unknown | {reason} | reserve floor {policy.reserve_pct:g}%"
            f" ({policy.reason}) | source: {LIVE_SOURCE}")
    log_event("run", "finished", ok=False, reason=reason, decision=line)
    return line, batteries


def run(args, settings, log_dir=LOG_DIR):
    """One pass through the pipeline. Returns the printed line and the batteries."""
    start_run(log_dir)
    log_event("run", "started", mode="live" if args.live else "fixture" if args.fixture else "file")
    # compute_risk and format_decision reject unknown keywords, so the sim settings stay out.
    risk_settings = {key: settings[key] for key in ("margin_pct", "lookahead_hours")}
    try:
        loaded, signal, baseline, risk = rate(args, settings, risk_settings)
    except Exception as exc:
        # Live data can fail many ways (network, login, bad JSON, missing hour); each must fail
        # safe. File modes read known files, so their errors still surface.
        if not args.live:
            raise
        return signal_unavailable(exc, settings)
    mode = decide_mode(risk)
    log_event("decide_mode", "ok", mode=mode)
    batteries = new_batteries()
    acks = apply_to_batteries(mode, batteries)
    log_event("apply_to_batteries", "mode_set", mode=mode, acks=acks)
    # "unchecked" until validate() exists (Slice 3); the line must not claim checks that never ran.
    line = format_decision(mode, risk, signal["posted_at"], loaded["now"], loaded["source"],
                           quality="unchecked", clock_pinned=loaded["clock_pinned"],
                           baseline_span=baseline_span(baseline), **risk_settings)
    log_event("run", "finished", decision=line)
    return line, batteries


def main(argv=None):
    line, _ = run(parse_args(argv), read_settings())
    print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
