"""Reads the console fixtures that the web tests already use, so both sides share one copy."""

import json
import os
from pathlib import Path

# server/api/fixtures.py → repo root is two parents up.
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DIR = REPO_ROOT / "web" / "src" / "fixtures" / "console"

# Scenes a live tick can come from. Each name is a JSON file in the fixture folder.
LIVE_SCENES = ("live-ok", "bad-feed", "retry-spent", "stress-reserve")
TICK_FILES = LIVE_SCENES + ("playback",)


class FixtureStore:
    def __init__(self, folder: Path | None = None):
        self.folder = folder or Path(os.environ.get("CONSOLE_FIXTURES_DIR", DEFAULT_DIR))

    def load(self, name: str):
        # Read on every call so an edited fixture shows up without a restart.
        with open(self.folder / f"{name}.json", encoding="utf-8") as fh:
            return json.load(fh)

    def all_ticks(self) -> list[dict]:
        return [self.load(name) for name in TICK_FILES]
