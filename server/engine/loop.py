"""Tick loop: python -m server.engine --tape PATH | --live [--tape PATH]"""
import argparse
import json
import sys
from dataclasses import asdict, replace
from datetime import datetime, timedelta
from pathlib import Path

from server.engine.baseline import load_baseline
from server.engine.brief import write_brief
from server.engine.cli import read_settings
from server.engine.contracts import TapeFrame, TickResult
from server.engine.controller import allocate
from server.engine.events import log_event, start_run
from server.engine.fleet import (
    apply_events,
    discharge,
    fleet_rollups,
    new_fleet,
    save_rollups,
    scale_target_mw,
    zone_delivered,
)
from server.engine.fleet_state import STATE_PATH, load_fleet_mode, write_fleet_mode
from server.engine.policy import reserve_policy
from server.engine.risk import compute_risk
from server.engine.supervisor import simulate_zone_acks
from server.engine.signal import (
    CENTRAL,
    LIVE_SOURCE,
    PRICE_SOURCE,
    SignalUnavailable,
    load_price,
    load_signal,
    stamp_price,
    to_signal,
)

LOG_DIR = Path("var") / "logs"
RUNS_DIR = Path("var") / "runs"
SETTINGS_KEYS = ("fleet_size", "home_kwh", "home_max_kw", "base_reserve_pct", "storm_reserve_pct",
                 "charge_threshold_usd_mwh", "discharge_threshold_usd_mwh", "tick_minutes")
# --live with no tape plays this many ticks at a flat synthetic target (not a real grid request).
SYNTHETIC_TICKS = 12
SYNTHETIC_TARGET_MW = 0.2
# live_cycle passes a precomputed risk/price so the engine does not fetch twice.
_UNSET = object()


# TEMP until sunny/tape-brief merge
def load_tape(path):
    return [TapeFrame(**frame) for frame in json.loads(Path(path).read_text())["frames"]]
# end TEMP


# Tests may pass a short settings dict. Production read_settings() already has these.
_FLEET_DEFAULTS = {
    "home_start_soc_min_pct": 45.0,
    "home_start_soc_max_pct": 75.0,
    "zones": {"Houston": "48201", "North": "48113", "South": "48355", "West": "48329"},
    # Simulation bands, not Base specs. Short test settings omit them.
    "charge_threshold_usd_mwh": 25.0,
    "discharge_threshold_usd_mwh": 60.0,
}


def with_fleet_defaults(settings):
    filled = dict(settings)
    for key, value in _FLEET_DEFAULTS.items():
        filled.setdefault(key, value)
    return filled


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


def read_live_price(settings):
    """Fetch NP6-905-CD once. A failure is None, so the tick does not keep tape 185."""
    try:
        price = load_price(settings)
    except SignalUnavailable as exc:
        log_event("fetch_price", "failed", ok=False, reason=str(exc), source=PRICE_SOURCE)
        print(f"live: price unknown | {exc} | source: {PRICE_SOURCE}")
        return None
    log_event("fetch_price", "ok", source=PRICE_SOURCE, usd_mwh=price["usd_mwh"], as_of=price["as_of"])
    print(f"live: price {price['usd_mwh']} $/MWh | source: {PRICE_SOURCE}")
    return price


def synthetic_frames(settings, start):
    """The frames used by --live with no tape: a flat target, labeled synthetic, no price."""
    step = timedelta(minutes=settings["tick_minutes"])
    return [TapeFrame(tick=i, ts=(start + (i - 1) * step).isoformat(timespec="seconds"),
                      target_mw=SYNTHETIC_TARGET_MW, target_label="synthetic",
                      price_usd_mwh=None, price_label="none")
            for i in range(1, SYNTHETIC_TICKS + 1)]


def count(homes, status):
    return sum(home.status == status for home in homes)


def read_operator_mode(state_path):
    if not state_path:
        return "AUTO"
    return load_fleet_mode(state_path)


def write_operator_mode(state_path, mode):
    if not state_path:
        return
    write_fleet_mode(mode, state_path)


def write_run_files(runs_dir, run_id, record):
    """Write the run and latest.json together so /v1/snapshot can read a mid-run live cycle."""
    runs_dir = Path(runs_dir)
    runs_dir.mkdir(parents=True, exist_ok=True)
    text = json.dumps(record, indent=2)
    (runs_dir / f"{run_id}.json").write_text(text)
    (runs_dir / "latest.json").write_text(text)


def run(tape_path, settings, log_dir=LOG_DIR, runs_dir=RUNS_DIR, live=False, state_path=None,
        frames=None, live_risk=_UNSET, live_price=_UNSET):
    """Play every frame of the tape through the fleet. Returns the run record written to disk.

    live=True fetches ERCOT once and uses that risk on every tick, ignoring the frames' risk
    fixtures. With no tape it plays SYNTHETIC_TICKS synthetic frames. A caller that already
    fetched (the live worker) may pass `frames`, `live_risk`, and `live_price`.

    Each tick is apply_events → compute_risk → reserve_policy → allocate → simulate_zone_acks → discharge → TickResult.
    """
    settings = with_fleet_defaults(settings)
    run_id = start_run(log_dir)
    baseline = load_baseline(lookahead_hours=settings["lookahead_hours"])
    if live:
        if live_risk is _UNSET:
            live_risk = read_live_risk(baseline, settings)
        # Skip a second login when the outage fetch already failed on the token.
        if live_price is _UNSET:
            live_price = read_live_price(settings) if live_risk is not None else None
    else:
        live_risk = None
        live_price = None
    if frames is None:
        frames = load_tape(tape_path) if tape_path else synthetic_frames(settings, datetime.now(CENTRAL))
    homes = new_fleet(settings)
    mode = read_operator_mode(state_path)
    ticks = []
    for frame in frames:
        apply_events(homes, frame.events)
        if live:
            risk = live_risk
        else:
            risk = read_risk(frame.risk_fixture, baseline, settings) if frame.risk_fixture else None
        mode = frame.events.get("operator", mode)
        write_operator_mode(state_path, mode)
        # Stamp price before the policy so intent can read the LZ number. Allocate ignores intent.
        if live:
            priced = stamp_price({"price_usd_mwh": frame.price_usd_mwh, "price_label": frame.price_label},
                                 live_price)
        else:
            priced = {"price_usd_mwh": frame.price_usd_mwh, "price_label": frame.price_label,
                      "price_as_of": None}
        policy = reserve_policy(
            risk, settings, mode=mode,
            price_usd_mwh=priced["price_usd_mwh"], price_label=priced["price_label"],
        )
        # Demo tape (100 homes) keeps 0.40. Live/archive scale to the fleet cap / call target.
        target_mw = scale_target_mw(frame.target_mw, settings)
        frame = replace(frame, target_mw=target_mw)
        alloc = allocate(homes, frame, policy, mode, settings)
        # In-process zone acks. There is no per-home device command API yet.
        zone_acks = simulate_zone_acks(homes, alloc, frame.tick, settings)
        breaches = discharge(homes, alloc, policy, settings)
        result = TickResult(
            tick=frame.tick, ts=frame.ts, mode=mode,
            target_mw=target_mw, target_label=frame.target_label,
            delivered_mw=alloc.delivered_mw, missed_mw=alloc.missed_mw,
            price_usd_mwh=priced["price_usd_mwh"], price_label=priced["price_label"],
            reserve_pct=policy.reserve_pct, policy_reason=policy.reason, risk_level=policy.risk_level,
            live_homes=count(homes, "live"), stale_homes=count(homes, "stale"), dead_homes=count(homes, "dead"),
            breaches=breaches, reasons=list(alloc.reasons),
            zone_reserve_pct=dict(policy.zone_reserve_pct),
            zone_reasons=dict(policy.zone_reasons),
            zone_delivered_mw=zone_delivered(homes, alloc),
            price_as_of=priced["price_as_of"],
            zone_acks=zone_acks,
            intent=policy.intent,
            intent_reason=policy.intent_reason,
        )
        brief = write_brief(result)
        log_event("tick", "ok", **asdict(result), brief=brief)
        print(f"tick {result.tick}: delivered {result.delivered_mw:.3f} of {result.target_mw:.3f} MW"
              f" ({result.target_label} target) | reserve {result.reserve_pct:g}% | {result.policy_reason}")
        ticks.append({**asdict(result), "brief": brief})
        # Aggregates only. The wall reads this file, never the 10k-home seed.
        save_rollups(fleet_rollups(homes, alloc, policy), Path(runs_dir) / ".." / "fleet" / "rollups.json")
        record = {
            "run_id": run_id,
            "tape": str(tape_path) if tape_path else "synthetic",
            "source": "live" if live else "scenario",
            "settings": {key: settings[key] for key in SETTINGS_KEYS},
            "ticks": list(ticks),
            "totals": {},
        }
        # Each cycle, so /runs/latest.json and /v1/snapshot stay aligned during --live.
        write_run_files(runs_dir, run_id, record)

    if not ticks:
        record = {
            "run_id": run_id,
            "tape": str(tape_path) if tape_path else "synthetic",
            "source": "live" if live else "scenario",
            "settings": {key: settings[key] for key in SETTINGS_KEYS},
            "ticks": [],
            "totals": {},
        }
        write_run_files(runs_dir, run_id, record)
    return record


def main(argv=None):
    parser = argparse.ArgumentParser(prog="server.engine", description="Run a tape through the fleet.")
    parser.add_argument("--tape", help="path to a tape JSON file (optional with --live)")
    parser.add_argument("--live", action="store_true", help="fetch ERCOT once and use that risk on every tick")
    args = parser.parse_args(argv)
    if not (args.tape or args.live):
        parser.error("give --tape PATH, --live, or both")
    run(args.tape, read_settings(), live=args.live, state_path=STATE_PATH)
    return 0


if __name__ == "__main__":
    sys.exit(main())
