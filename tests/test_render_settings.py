"""render.yaml pins the non-secret settings the API computes with. They must match .env.example,
so Render and the laptop worker that writes the runs never drift apart."""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# The API re-rates postings and sizes the fleet with these; the laptop worker reads the same names.
PINNED = ("FLEET_SIZE", "HOME_KWH", "HOME_MAX_KW", "BASE_RESERVE_PCT", "STORM_RESERVE_PCT",
          "CHARGE_BELOW_USD", "DISCHARGE_ABOVE_USD", "ROUND_TRIP_PCT")


def render_values():
    # No YAML dependency: each envVar is a "- key: NAME" line followed by a "value: ..." line.
    pairs = re.findall(r"-\s*key:\s*([A-Z_0-9]+)\s*\n\s*value:\s*\"?([^\"\n]+)\"?", (ROOT / "render.yaml").read_text())
    return dict(pairs)


def example_values():
    lines = (ROOT / ".env.example").read_text().splitlines()
    return dict(line.split("=", 1) for line in lines if re.match(r"^[A-Z_0-9]+=", line))


def test_render_pins_every_api_setting():
    missing = [name for name in PINNED if name not in render_values()]
    assert missing == []


def test_render_settings_match_env_example():
    render, example = render_values(), example_values()
    assert {name: render.get(name) for name in PINNED} == {name: example.get(name) for name in PINNED}


def test_render_worker_prints_are_unbuffered():
    # Without it the live worker's prints sit in a pipe buffer and never reach Render's logs.
    assert render_values().get("PYTHONUNBUFFERED") == "1"
