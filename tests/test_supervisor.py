"""In-process zone ack rollup. No device command API; drops are simulated after allocate."""
from pathlib import Path

from server.engine.contracts import Allocation, Home
from server.engine.loop import run
from server.engine.supervisor import (
    CYCLE_CLOSE_S,
    CYCLE_CONFIRM_S,
    Command,
    HomeWorker,
    command_id,
    simulate_zone_acks,
)


def home(home_id, zone="Houston", status="live"):
    return Home(home_id, 20.0, 14.0, 5.0, status=status, zone=zone)


def alloc(*pairs):
    return Allocation({home_id: kw for home_id, kw in pairs}, 0.01, 0.0, [])


def test_command_id_is_home_and_tick():
    assert command_id("home-001", 5) == "home-001:5"
    assert Command("home-001:5", "home-001", 4.0).command_id == "home-001:5"


def test_seen_ignores_a_repeat_of_the_same_command():
    worker = HomeWorker()
    assert worker.accept("home-001:1") is True
    assert worker.accept("home-001:1") is False
    assert worker.seen == {"home-001:1"}


def test_live_allocated_homes_ack_by_zone_when_nothing_drops():
    homes = [
        home("a", "Houston"),
        home("b", "Houston"),
        home("c", "North"),
        home("d", "North"),
    ]
    totals = simulate_zone_acks(homes, alloc(("a", 4.0), ("c", 4.0)), tick=1)
    assert totals["Houston"] == {"acked": 1, "held": 1, "silent": 0, "dead": 0, "unconfirmed": 0}
    assert totals["North"] == {"acked": 1, "held": 1, "silent": 0, "dead": 0, "unconfirmed": 0}


def test_dead_and_stale_are_never_commanded():
    homes = [
        home("live", "South"),
        home("quiet", "South", status="stale"),
        home("gone", "South", status="dead"),
    ]
    totals = simulate_zone_acks(homes, alloc(("live", 5.0), ("quiet", 5.0), ("gone", 5.0)), tick=2)
    assert totals["South"] == {"acked": 1, "held": 0, "silent": 1, "dead": 1, "unconfirmed": 0}


def test_full_drop_rate_leaves_allocated_homes_unconfirmed():
    homes = [home("a", "West"), home("b", "West")]
    totals = simulate_zone_acks(
        homes, alloc(("a", 5.0)), tick=3, settings={"channel_drop_rate": 1.0, "seed": 7}
    )
    assert totals["West"]["unconfirmed"] == 1
    assert totals["West"]["acked"] == 0
    assert totals["West"]["held"] == 1


def test_virtual_deadlines_match_the_other_branch():
    assert CYCLE_CONFIRM_S == 60.0
    assert CYCLE_CLOSE_S == 120.0


def test_engine_tick_includes_zone_ack_totals(tmp_path, monkeypatch):
    root = Path(__file__).resolve().parents[1]
    monkeypatch.chdir(root)
    settings = {
        "margin_pct": 15, "lookahead_hours": 6, "fleet_size": 100, "home_kwh": 20,
        "home_max_kw": 5, "base_reserve_pct": 30, "storm_reserve_pct": 60, "tick_minutes": 5,
    }
    record = run(
        root / "tests" / "fixtures" / "tape_tiny.json",
        settings,
        log_dir=tmp_path / "logs",
        runs_dir=tmp_path / "runs",
    )
    first = record["ticks"][0]
    assert set(first["zone_acks"]) >= {"Houston", "North", "South", "West"}
    row = first["zone_acks"]["Houston"]
    assert set(row) == {"acked", "held", "silent", "dead", "unconfirmed"}
    assert sum(row.values()) > 0
