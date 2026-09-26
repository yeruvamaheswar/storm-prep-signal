"""Tick loop entry: python -m server.engine --tape PATH | --live [--tape PATH] [--persist]"""
import argparse
import importlib.util
import sys
from pathlib import Path

from server.engine.loop import main


def persist_after_run():
    """Best-effort copy of the local run file. loop.run() never imports this."""
    path = Path(__file__).resolve().parents[2] / "scripts" / "persist_run.py"
    spec = importlib.util.spec_from_file_location("persist_run", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.persist_after_run()


def split_persist(argv=None):
    """Pull --persist out of argv; loop.main() rejects flags it does not know."""
    # allow_abbrev=False so a prefix like --pe is left for loop.main() to reject, not read as --persist.
    parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
    parser.add_argument("--persist", action="store_true")
    args, rest = parser.parse_known_args(argv)
    return args.persist, rest


def run_then_persist(argv=None):
    persist, argv = split_persist(argv)
    code = main(argv)
    if persist:
        try:
            persist_after_run()
        except Exception as exc:
            print(f"runs_skipped: {type(exc).__name__}")
    return code


if __name__ == "__main__":
    sys.exit(run_then_persist())
