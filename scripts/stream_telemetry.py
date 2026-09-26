"""Copy the controller tick onto Supabase: current homes plus one history row each.

Usage:
  python scripts/stream_telemetry.py            # one tick from var/fleet/tick_emit.json
  python scripts/stream_telemetry.py --loop     # wait until the emit file changes
  python scripts/stream_telemetry.py --dry-run  # print the counts, send nothing

Reads var/fleet/tick_emit.json (the whole fleet for that tick, written by the
controller). Upserts soc_kwh, assigned_kw, charge_state, power_kw, and
last_seen onto public.homes, and appends one home_readings row and one
home_commands row per home for that tick. Charge states always come from the
controller; --drop-rate only omits a random slice of homes from the homes
upsert and the readings append (their rows go stale), while every command is
still recorded. A tick already sent (same tick and fleet_size as the state
file) is skipped. A missing emit file prints telemetry_skipped: no_controller
and exits 0; no charge state is invented. The engine never imports this
module. Needs SUPABASE_URL and SUPABASE_SECRET_KEY in server/.env.
"""
import argparse
import json
import os
import random
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT), str(ROOT / "scripts")]

import load_ercot_archive as archive  # noqa: E402
from load_ercot_archive import BatchFailed, send  # noqa: E402
from persist_telemetry import BATCH_SIZE  # noqa: E402
from server.env import ENV_PATH, load_env  # noqa: E402

EMIT_PATH = Path("var") / "fleet" / "tick_emit.json"
STATE_PATH = Path("var") / "fleet" / ".stream_telemetry_sent.json"
EVERY_S = 15.0
ACKS = ("ok", "timeout")


def load_emit(path):
    """Read and validate the controller emit file. Raises on a bad shape."""
    payload = json.loads(Path(path).read_text())
    if not isinstance(payload, dict):
        raise ValueError("emit must be an object")
    homes = payload.get("homes")
    if not isinstance(homes, dict):
        raise ValueError("emit.homes must be keyed by home_id")
    tick = payload.get("tick")
    if not isinstance(tick, int):
        raise ValueError("emit.tick must be an int")
    fleet_size = payload.get("fleet_size")
    if fleet_size is None:
        # Older emits omit it; the home count is the fleet that tick planned.
        fleet_size = len(homes)
    return {
        "tick": tick,
        "fleet_size": int(fleet_size),
        "ts": payload.get("ts"),
        "homes": homes,
    }


def read_sent(state_path):
    """Last (tick, fleet_size) sent, or None when nothing is recorded."""
    try:
        saved = json.loads(Path(state_path).read_text())
    except (OSError, ValueError, AttributeError):
        return None
    if not isinstance(saved, dict):
        return None
    tick, size = saved.get("tick"), saved.get("fleet_size")
    if not isinstance(tick, int) or size is None:
        return None
    return (tick, int(size))


def write_sent(state_path, tick, fleet_size):
    dest = Path(state_path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps({"tick": tick, "fleet_size": fleet_size}))


def select_dropped(emit, drop_rate, seed):
    """Home ids whose telemetry never arrives this tick. Commands still send.

    The controller still decided every home's charge state; the drop only
    models an imperfect feed (dead radio, missed post). Seeded by seed, tick,
    and fleet_size so a rerun drops the same homes. Sorted ids keep the draw
    independent of the emit file's key order.
    """
    try:
        rate = float(drop_rate)
    except (TypeError, ValueError):
        return set()
    if rate <= 0.0:
        return set()
    if rate >= 1.0:
        return {home_id for home_id in emit["homes"]}
    rng = random.Random(f"{seed}:{emit['tick']}:{emit['fleet_size']}")
    return {
        home_id
        for home_id in sorted(emit["homes"])
        if rng.random() < rate
    }


def rows_for_homes(emit):
    """Current columns for public.homes: only what the controller reported."""
    rows = []
    for home_id, data in emit["homes"].items():
        if not isinstance(data, dict):
            continue
        row = {"home_id": home_id}
        if data.get("soc_kwh") is not None:
            row["soc_kwh"] = data["soc_kwh"]
        if data.get("assigned_kw") is not None:
            row["assigned_kw"] = data["assigned_kw"]
        if data.get("charge_state") not in (None, ""):
            row["charge_state"] = data["charge_state"]
        if data.get("power_kw") is not None:
            row["power_kw"] = data["power_kw"]
        seen = data.get("last_seen") or emit.get("ts")
        if seen:
            row["last_seen"] = seen
        rows.append(row)
    return rows


def rows_for_readings(emit):
    """One home_readings row per home. Homes without soc or time are skipped."""
    tick, ts = emit["tick"], emit.get("ts")
    rows = []
    for home_id, data in emit["homes"].items():
        if not isinstance(data, dict):
            continue
        if data.get("soc_kwh") is None:
            continue
        seen_at = data.get("last_seen") or ts
        if not seen_at:
            continue
        row = {
            "home_id": home_id,
            "tick": tick,
            "seen_at": seen_at,
            "soc_kwh": data["soc_kwh"],
        }
        if data.get("charge_state") not in (None, ""):
            row["charge_state"] = data["charge_state"]
        if data.get("power_kw") is not None:
            row["power_kw"] = data["power_kw"]
        rows.append(row)
    return rows


def rows_for_commands(emit):
    """One home_commands row per home. A null command is a 0 kW timeout order."""
    tick, ts = emit["tick"], emit.get("ts")
    rows = []
    for home_id, data in emit["homes"].items():
        if not isinstance(data, dict):
            continue
        cmd = data.get("command")
        if isinstance(cmd, dict):
            command_id = cmd.get("command_id") or f"{home_id}:{tick}"
            kw = cmd.get("kw")
            if kw is None:
                kw = data.get("assigned_kw", 0)
            if kw is None:
                kw = 0
            row = {
                "command_id": str(command_id),
                "home_id": home_id,
                "tick": tick,
                "kw": kw,
            }
            if cmd.get("actual_kw") is not None:
                row["actual_kw"] = cmd["actual_kw"]
            ack = cmd.get("ack")
            row["ack"] = ack if ack in ACKS else "timeout"
            sent_at = cmd.get("sent_at") or data.get("last_seen") or ts
            if sent_at:
                row["sent_at"] = sent_at
        else:
            # The tick sent no order: record the hold as a timeout, not a fake ack.
            assigned = data.get("assigned_kw", 0)
            if assigned is None:
                assigned = 0
            power = data.get("power_kw", 0)
            if power is None:
                power = 0
            row = {
                "command_id": f"{home_id}:{tick}",
                "home_id": home_id,
                "tick": tick,
                "kw": assigned,
                "actual_kw": power,
                "ack": "timeout",
            }
            sent_at = data.get("last_seen") or ts
            if sent_at:
                row["sent_at"] = sent_at
        rows.append(row)
    return rows


def persist_tick(homes_rows, reading_rows, command_rows, url, key):
    if not (url and key):
        return "skipped: no_config"
    previous = archive.BATCH_SIZE
    archive.BATCH_SIZE = BATCH_SIZE
    try:
        send(homes_rows, url, key, table="homes", on_conflict="home_id")
        send(reading_rows, url, key, table="home_readings", on_conflict="home_id,tick")
        send(command_rows, url, key, table="home_commands", on_conflict="command_id")
    except BatchFailed as exc:
        return f"skipped: {exc}"
    finally:
        archive.BATCH_SIZE = previous
    return "ok"


def run_once(emit_path, state_path, url, key, dry_run, drop_rate=0.0, seed=1):
    emit_file = Path(emit_path)
    if not emit_file.is_file():
        print("telemetry_skipped: no_controller", flush=True)
        return 0
    try:
        emit = load_emit(emit_file)
    except (OSError, ValueError, KeyError, TypeError):
        print("telemetry_skipped: bad_emit", flush=True)
        return 0
    if read_sent(state_path) == (emit["tick"], emit["fleet_size"]):
        print("telemetry_skipped: duplicate", flush=True)
        return 0
    dropped = select_dropped(emit, drop_rate, seed)
    homes_rows = [row for row in rows_for_homes(emit) if row["home_id"] not in dropped]
    reading_rows = [row for row in rows_for_readings(emit) if row["home_id"] not in dropped]
    command_rows = rows_for_commands(emit)
    if dry_run:
        print(
            f"telemetry_built: {len(homes_rows)} homes "
            f"{len(reading_rows)} readings {len(command_rows)} commands "
            f"({len(dropped)} dropped)",
            flush=True,
        )
        return 0
    if not (url and key):
        print("telemetry_skipped: no_config", flush=True)
        return 0
    result = persist_tick(homes_rows, reading_rows, command_rows, url, key)
    print(f"telemetry_{result}", flush=True)
    if result == "ok":
        try:
            write_sent(state_path, emit["tick"], emit["fleet_size"])
        except OSError:
            pass
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Copy the controller tick_emit.json onto public.homes plus history.",
    )
    parser.add_argument("--dry-run", action="store_true", help="print the row counts, send nothing")
    parser.add_argument("--loop", action="store_true", help="wait until the emit file changes")
    parser.add_argument("--path", default=str(EMIT_PATH), help="controller emit file to read")
    parser.add_argument("--state-path", default=str(STATE_PATH), help="where the last sent tick is kept")
    parser.add_argument("--every", type=float, default=EVERY_S, help="poll interval for --loop")
    parser.add_argument("--n", type=int, default=None, help="ignored: the emit file sizes the fleet")
    parser.add_argument("--seed", type=int, default=1, help="seed for the telemetry drop draw")
    parser.add_argument(
        "--drop-rate",
        type=float,
        default=0.0,
        help="fraction of homes whose telemetry is dropped each tick (0 sends all, commands always send)",
    )
    args = parser.parse_args(argv)

    load_env(ENV_PATH)
    url, key = os.getenv("SUPABASE_URL", ""), os.getenv("SUPABASE_SECRET_KEY", "")

    if not args.loop:
        return run_once(args.path, args.state_path, url, key, args.dry_run, args.drop_rate, args.seed)
    if args.dry_run:
        return run_once(args.path, args.state_path, url, key, True, args.drop_rate, args.seed)
    # Live loop: only a changed emit file is a new tick. An unchanged file
    # sleeps quietly instead of inventing a fresh random mix every 15 s.
    last_mtime = None
    was_missing = False
    while True:
        try:
            stat = Path(args.path).stat()
            mtime = (stat.st_mtime_ns, stat.st_size)
        except OSError:
            if not was_missing:
                print("telemetry_skipped: no_controller", flush=True)
                was_missing = True
            time.sleep(max(1.0, args.every))
            continue
        was_missing = False
        if mtime == last_mtime:
            time.sleep(max(1.0, args.every))
            continue
        run_once(args.path, args.state_path, url, key, False, args.drop_rate, args.seed)
        last_mtime = mtime
        time.sleep(max(1.0, args.every))


if __name__ == "__main__":
    sys.exit(main())
