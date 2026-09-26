"""The tick loop runs the simulated battery feed (docs/agents/telemetry-vpp.md) when
settings["telemetry_feed"] is on. read_settings() turns it on; bare test settings leave it off."""
from pathlib import Path

from server.engine import cli
from server.engine.loop import run

ROOT = Path(__file__).parent.parent
TAPE = ROOT / "tests" / "fixtures" / "tape_tiny.json"
# Example simulation settings, not Base specs. Same keys as tests/test_engine.py.
SETTINGS = {"margin_pct": 15, "lookahead_hours": 6, "fleet_size": 100, "home_kwh": 20,
            "home_max_kw": 5, "base_reserve_pct": 30, "storm_reserve_pct": 60, "tick_minutes": 5}
ZONES = {"Houston", "North", "South", "West"}


def play(tmp_path, **over):
    return run(TAPE, {**SETTINGS, **over}, log_dir=tmp_path / "logs", runs_dir=tmp_path / "runs")


def test_feed_on_fills_plant_feed_and_zone_telemetry_every_tick(tmp_path):
    record = play(tmp_path, telemetry_feed=True)
    assert record["settings"]["telemetry_feed"] is True
    assert record["ticks"]
    for tick in record["ticks"]:
        assert tick["breaches"] == 0
        assert tick["plant"]["homes"]["total"] == 100
        assert tick["plant"]["data_label"] == "synthetic"
        assert tick["feed"]["accepted"] > 0
        assert set(tick["zone_telemetry"]) == ZONES


def test_feed_off_leaves_the_telemetry_fields_empty(tmp_path):
    record = play(tmp_path)
    assert record["settings"]["telemetry_feed"] is False
    for tick in record["ticks"]:
        assert tick["plant"] == {} and tick["feed"] == {} and tick["zone_telemetry"] == {}


def test_feed_off_matches_a_run_that_never_mentions_it(tmp_path):
    bare = play(tmp_path / "a")
    off = play(tmp_path / "b", telemetry_feed=False)
    assert bare["ticks"] == off["ticks"]


def test_battery_state_carries_across_ticks(tmp_path):
    # One feed per run. home-001 goes silent right after registering. By the end of tick 3
    # (900 s) its data is older than 600 s, so it is dead. A feed rebuilt every tick would
    # re-register it and it could never look older than one tick (300 s, only stale).
    ticks = play(tmp_path, telemetry_feed=True, telemetry_outage_rate=0.0, telemetry_liar_ids=(),
                 telemetry_outages={"home-001": [(0.0, 10_000.0)]})["ticks"]
    assert len(ticks) == 3
    assert ticks[0]["plant"]["homes"]["stale"] == 1
    assert ticks[-1]["plant"]["homes"]["dead"] == 1


def test_same_seed_same_telemetry(tmp_path):
    a = play(tmp_path / "a", telemetry_feed=True)
    b = play(tmp_path / "b", telemetry_feed=True)
    assert a["ticks"] == b["ticks"]


def test_read_settings_turns_the_feed_on_by_default(monkeypatch):
    monkeypatch.setattr(cli, "load_dotenv", lambda: None)
    monkeypatch.delenv("TELEMETRY_FEED", raising=False)
    settings = cli.read_settings()
    assert settings["telemetry_feed"] is True
    assert settings["telemetry_every_s"] == 10.0
    assert settings["stale_after_s"] == 180.0
    assert settings["dead_after_s"] == 600.0


def test_read_settings_feed_can_be_switched_off(monkeypatch):
    monkeypatch.setattr(cli, "load_dotenv", lambda: None)
    monkeypatch.setenv("TELEMETRY_FEED", "0")
    assert cli.read_settings()["telemetry_feed"] is False
