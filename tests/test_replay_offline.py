"""Replaying a saved tape needs no network and gives the same floors and delivery every run."""
import socket
from pathlib import Path

import pytest

from server.engine.baseline import BASELINE_PATH
from server.engine.loop import run

ROOT = Path(__file__).parent.parent
DEMO = ROOT / "tapes" / "demo.json"
HEATHER = ROOT / "tapes" / "heather.json"
HEATHER_BASELINE = ROOT / "data" / "fixtures" / "heather" / "baseline.json"
# Example simulation settings, not Base specs.
SETTINGS = {"margin_pct": 15, "lookahead_hours": 6, "fleet_size": 100, "home_kwh": 20,
            "home_max_kw": 5, "base_reserve_pct": 30, "storm_reserve_pct": 60, "tick_minutes": 5}
COMPARED = ("reserve_pct", "zone_reserve_pct", "policy_reason", "delivered_mw")


@pytest.fixture
def connects(monkeypatch):
    """Block outbound sockets. read_risk swallows errors, so the test also checks nothing tried."""
    attempts = []

    def blocked(sock, address):
        attempts.append(address)
        raise OSError(f"network blocked in offline replay: {address}")

    monkeypatch.setattr(socket.socket, "connect", blocked)
    monkeypatch.setenv("SUPABASE_URL", "https://offline.invalid")
    # Tape risk_fixture paths are relative to the repo root.
    monkeypatch.chdir(ROOT)
    return attempts


def _replay(tape, baseline, out):
    return run(tape, SETTINGS, log_dir=out / "logs", runs_dir=out / "runs", state_path=None,
               baseline_path=baseline)


@pytest.mark.parametrize("tape,baseline", [(DEMO, BASELINE_PATH), (HEATHER, HEATHER_BASELINE)],
                         ids=["demo", "heather"])
def test_offline_replay_is_identical_across_two_runs(tmp_path, connects, tape, baseline):
    first = _replay(tape, baseline, tmp_path / "first")["ticks"]
    second = _replay(tape, baseline, tmp_path / "second")["ticks"]

    assert connects == []
    assert [t["tick"] for t in first] == [t["tick"] for t in second]
    for a, b in zip(first, second):
        assert {k: a[k] for k in COMPARED} == {k: b[k] for k in COMPARED}, f"tick {a['tick']}"
    assert all(t["breaches"] == 0 for t in first + second)


def test_demo_weather_raises_houston_then_missing_signal_raises_every_zone(tmp_path, connects):
    ticks = {t["tick"]: t for t in _replay(DEMO, BASELINE_PATH, tmp_path)["ticks"]}

    assert connects == []
    weather = ticks[4]
    assert weather["policy_reason"] == "normal"
    assert weather["zone_reserve_pct"] == {"Houston": 60, "North": 30, "South": 30, "West": 30}
    assert weather["zone_reasons"]["Houston"] == "weather_alert"

    missing = ticks[12]
    assert (missing["reserve_pct"], missing["policy_reason"]) == (60, "signal_unavailable")
    assert set(missing["zone_reserve_pct"].values()) == {60}
    assert set(missing["zone_reasons"].values()) == {"signal_unavailable"}
