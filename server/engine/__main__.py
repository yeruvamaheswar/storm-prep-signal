"""Tick loop entry: python -m server.engine --tape PATH | --live [--tape PATH]"""
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


def run_then_persist(argv=None):
    code = main(argv)
    try:
        persist_after_run()
    except Exception as exc:
        print(f"runs_skipped: {type(exc).__name__}")
    return code


if __name__ == "__main__":
    sys.exit(run_then_persist())
