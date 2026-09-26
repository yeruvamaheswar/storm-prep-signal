"""Persist AUTO|HOLD so a wall write and the next allocate() share one mode."""

import json
from pathlib import Path
from typing import Optional

STATE_PATH = Path("var") / "state.json"
MODES = ("AUTO", "HOLD")


def _path(path=None) -> Path:
    return Path(path) if path is not None else STATE_PATH


def read_fleet_mode(path=None) -> Optional[str]:
    """AUTO or HOLD from disk. None when the file is missing or unusable."""
    file = _path(path)
    try:
        data = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    mode = data.get("mode")
    return mode if mode in MODES else None


def load_fleet_mode(path=None) -> str:
    """Engine start: missing state is AUTO, the same default as a fresh run()."""
    return read_fleet_mode(path) or "AUTO"


def write_fleet_mode(mode: str, path=None) -> None:
    if mode not in MODES:
        raise ValueError(f"fleet mode must be AUTO or HOLD, got {mode!r}")
    file = _path(path)
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps({"mode": mode}), encoding="utf-8")


def apply_mode(tick: dict, path=None) -> dict:
    """Snapshot overlay. A missing file keeps the last tick's mode."""
    mode = read_fleet_mode(path)
    if mode is None:
        return tick
    stamped = dict(tick)
    stamped["mode"] = mode
    return stamped
