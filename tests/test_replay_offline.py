"""Replaying a saved tape needs no network and gives the same floors and delivery every run."""
import json
import shutil
import socket
from pathlib import Path

import pytest

from server.engine.__main__ import run_then_persist
from server.engine.baseline import BASELINE_PATH
from server.engine.loop import run, summary_line

ROOT = Path(__file__).parent.parent
REPO_VAR = ROOT / "var"
DEMO = ROOT / "tapes" / "demo.json"
HEATHER = ROOT / "tapes" / "heather.json"
HEATHER_BASELINE = ROOT / "data" / "fixtures" / "heather" / "baseline.json"
# Example simulation settings, not Base specs.
SETTINGS = {"margin_pct": 15, "lookahead_hours": 6, "fleet_size": 100, "home_kwh": 20,
            "home_max_kw": 5, "base_reserve_pct": 30, "storm_reserve_pct": 60, "tick_minutes": 5}
COMPARED = ("reserve_pct", "zone_reserve_pct", "policy_reason", "delivered_mw")
TOTAL_KEYS = ("delivered_mwh", "target_mwh", "delivery_pct", "breaches", "hold_ticks")
# read_settings() loads the repo .env; load_dotenv never overrides a set variable, so pin the defaults.
CLI_ENV = {"RISK_MARGIN_PCT": "15", "LOOKAHEAD_HOURS": "6", "FLEET_SIZE": "100", "HOME_KWH": "20",
           "HOME_MAX_KW": "5", "BASE_RESERVE_PCT": "30", "STORM_RESERVE_PCT": "60", "TICK_MINUTES": "5",
           "CHANNEL_DROP_RATE": "0", "CHANNEL_DUP_RATE": "0", "CHANNEL_LATE_RATE": "0"}


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
    first_run = _replay(tape, baseline, tmp_path / "first")
    second_run = _replay(tape, baseline, tmp_path / "second")
    first, second = first_run["ticks"], second_run["ticks"]

    assert connects == []
    assert first_run["totals"] == second_run["totals"]
    assert [t["tick"] for t in first] == [t["tick"] for t in second]
    for a, b in zip(first, second):
        assert {k: a[k] for k in COMPARED} == {k: b[k] for k in COMPARED}, f"tick {a['tick']}"
    assert all(t["breaches"] == 0 for t in first + second)


def test_demo_run_writes_scoreboard_totals(tmp_path, connects):
    record = _replay(DEMO, BASELINE_PATH, tmp_path)
    totals = record["totals"]

    assert totals
    assert totals["ticks"] == len(record["ticks"])
    assert totals["breaches"] == 0
    assert totals["delivered_mwh"] <= totals["target_mwh"] + 1e-9
    # The demo tape holds for one tick (operator HOLD on one frame).
    assert totals["hold_ticks"] == sum(t["mode"] == "HOLD" for t in record["ticks"]) >= 1
    # The file on disk carries the same board the run returned.
    assert json.loads((tmp_path / "runs" / "latest.json").read_text())["totals"] == totals
    assert summary_line(totals).startswith("run total: delivered ")


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


def test_demo_brief_names_a_zone_floor_that_differs_from_the_fleet(tmp_path, connects):
    ticks = {t["tick"]: t for t in _replay(DEMO, BASELINE_PATH, tmp_path)["ticks"]}

    assert "Floor 30% (Houston 60%: weather_alert)" in ticks[4]["brief"]
    # Every zone matches the fleet floor on tick 1, so its line stays as it was.
    assert ticks[1]["brief"] == "Delivered 0.20 of 0.20 MW. timed out 1; duplicates ignored 1; over delivery 1."


def _var_files():
    """Every file under the repo's var/ with its mtime. A missing var/ counts as empty."""
    if not REPO_VAR.exists():
        return {}
    return {str(p.relative_to(REPO_VAR)): p.stat().st_mtime_ns for p in REPO_VAR.rglob("*") if p.is_file()}


def _copy_tape_fixtures(dest):
    """Tape risk_fixture paths are cwd-relative. Copy the ones that exist; the missing one stays missing."""
    for frame in json.loads(DEMO.read_text())["frames"]:
        name = frame.get("risk_fixture")
        if name and (ROOT / name).exists():
            (dest / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, dest / name)


def _cli_totals(folder, monkeypatch, capsys):
    """One pass through `python3 -m server.engine --tape` from a fresh cwd, read back from the run file it wrote.

    A run reloads the last run's var/fleet/homes.json, so a fresh start needs its own folder.
    """
    folder.mkdir()
    _copy_tape_fixtures(folder)
    monkeypatch.chdir(folder)
    assert run_then_persist(["--tape", str(DEMO)]) == 0
    totals = json.loads(Path("var/runs/latest.json").read_text())["totals"]
    assert capsys.readouterr().out.rstrip().endswith(summary_line(totals))
    return {key: totals[key] for key in TOTAL_KEYS}


def test_cli_tape_replay_writes_nothing_under_repo_var(tmp_path, monkeypatch, capsys, connects):
    for name, value in CLI_ENV.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("CALL_TARGET_MW", raising=False)
    before = _var_files()

    first = _cli_totals(tmp_path / "first", monkeypatch, capsys)
    second = _cli_totals(tmp_path / "second", monkeypatch, capsys)

    assert connects == []
    assert _var_files() == before
    assert first == second
    assert (round(first["delivered_mwh"], 3), round(first["target_mwh"], 3)) == (0.164, 0.317)
    assert (first["breaches"], first["hold_ticks"]) == (0, 1)
