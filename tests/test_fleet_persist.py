"""A live loop.run writes discharged fleet truth and reloads it; a tape replay never touches it."""
import json
from pathlib import Path

from server.engine import loop
from server.engine.fleet import load_fleet, new_fleet, save_fleet
from server.engine.loop import run

ROOT = Path(__file__).parent.parent
TAPE = ROOT / "tests" / "fixtures" / "tape_tiny.json"

SETTINGS = {
    "margin_pct": 15,
    "lookahead_hours": 6,
    "fleet_size": 4,
    "home_kwh": 20,
    "home_max_kw": 5,
    "home_start_soc_min_pct": 45.0,
    "home_start_soc_max_pct": 75.0,
    "base_reserve_pct": 30,
    "storm_reserve_pct": 60,
    "tick_minutes": 5,
    "zones": {"Houston": "48201", "North": "48113", "South": "48355", "West": "48329"},
}


def _play(tmp_path, settings=None, live=True):
    """live_risk/live_price stand in for the one ERCOT fetch, so a live run stays offline."""
    settings = settings or SETTINGS
    extra = {"live_risk": None, "live_price": None} if live else {}
    return run(TAPE, settings, log_dir=tmp_path / "logs", runs_dir=tmp_path / "runs", live=live, **extra)


def _homes_path(tmp_path):
    return tmp_path / "fleet" / "homes.json"


def test_run_writes_homes_json_after_discharge(tmp_path, monkeypatch):
    monkeypatch.chdir(ROOT)
    record = _play(tmp_path)
    assert record["ticks"][0]["delivered_mw"] > 0
    dest = _homes_path(tmp_path)
    assert dest.is_file()
    rows = json.loads(dest.read_text())
    assert len(rows) == SETTINGS["fleet_size"]
    seeded = {home.home_id: home.soc_kwh for home in new_fleet(SETTINGS)}
    dropped = False
    for row in rows:
        assert row["status"] in ("live", "stale", "dead")
        assert row["zone"] in ("South", "North", "West", "Houston")
        assert "T" in row["updated_at"]
        # ISO 8601 with a UTC offset (Central is -05:00 / -06:00, not Z).
        assert row["updated_at"][-6] in "+-" or row["updated_at"].endswith("Z")
        if row["soc_kwh"] < seeded[row["home_id"]] - 1e-9:
            dropped = True
    assert dropped, "discharge never lowered soc_kwh before save_fleet"


def test_next_run_reloads_matching_homes_instead_of_reseeding(tmp_path, monkeypatch):
    monkeypatch.chdir(ROOT)
    _play(tmp_path)
    after_first = {home.home_id: home.soc_kwh for home in load_fleet(_homes_path(tmp_path))}
    _play(tmp_path)
    after_second = {home.home_id: home.soc_kwh for home in load_fleet(_homes_path(tmp_path))}
    # Same tape from a fresh 45–75% seed would land on the same SOC. Loading the saved
    # file means the second process starts from where the first ended, so it lands elsewhere
    # (homes under the floor refill, so the total need not be lower).
    assert after_second != after_first


def test_wrong_length_homes_json_reseeds(tmp_path, monkeypatch):
    monkeypatch.chdir(ROOT)
    dest = _homes_path(tmp_path)
    save_fleet(new_fleet({**SETTINGS, "fleet_size": 2}), dest)
    _play(tmp_path)
    loaded = load_fleet(dest)
    assert len(loaded) == SETTINGS["fleet_size"]
    assert [home.home_id for home in loaded] == ["home-001", "home-002", "home-003", "home-004"]


def test_demo_fleet_stays_100_when_fleet_size_is_100(tmp_path, monkeypatch):
    monkeypatch.chdir(ROOT)
    settings = {**SETTINGS, "fleet_size": 100}
    _play(tmp_path, settings)
    loaded = load_fleet(_homes_path(tmp_path))
    assert len(loaded) == 100
    assert loaded[0].home_id == "home-001"
    assert loaded[-1].home_id == "home-100"


def test_live_run_saves_homes_after_each_tick(tmp_path, monkeypatch):
    monkeypatch.chdir(ROOT)
    calls = []
    monkeypatch.setattr(loop, "persist_discharged_homes", lambda homes, path: calls.append(len(homes)))
    record = _play(tmp_path)
    assert len(record["ticks"]) == 3
    assert calls == [SETTINGS["fleet_size"]] * len(record["ticks"])


def test_tape_run_never_reads_or_writes_homes_json(tmp_path, monkeypatch):
    monkeypatch.chdir(ROOT)
    fresh = _play(tmp_path / "fresh", live=False)
    assert not _homes_path(tmp_path / "fresh").exists()

    drained = new_fleet(SETTINGS)
    for home in drained:
        home.soc_kwh = 0.0
    dest = _homes_path(tmp_path / "drained")
    save_fleet(drained, dest)
    before = dest.read_bytes()
    replay = _play(tmp_path / "drained", live=False)

    assert dest.read_bytes() == before
    assert replay["totals"] == fresh["totals"]
