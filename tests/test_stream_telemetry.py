"""scripts/stream_telemetry.py copies the controller tick onto Supabase."""
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    "stream_telemetry", ROOT / "scripts" / "stream_telemetry.py",
)
stream = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stream)

TS = "2026-09-26T22:00:00+00:00"


def make_emit(tick=1, fleet_size=3):
    return {
        "tick": tick,
        "ts": TS,
        "target_mw": 40.0,
        "target_label": "synthetic",
        "delivered_mw": 4.0,
        "fleet_size": fleet_size,
        "homes": {
            "home-001": {
                "soc_kwh": 12.4,
                "assigned_kw": 4.0,
                "power_kw": 4.0,
                "charge_state": "DISCHARGING",
                "status": "live",
                "zone": "South",
                "last_seen": TS,
                "command": {
                    "command_id": "home-001:1",
                    "kw": 4.0,
                    "actual_kw": 4.0,
                    "ack": "ok",
                    "sent_at": TS,
                },
            },
            "home-002": {
                "soc_kwh": 10.0,
                "assigned_kw": 0.0,
                "power_kw": 0.0,
                "charge_state": "HOLDING",
                "status": "live",
                "zone": "North",
                "last_seen": TS,
                "command": None,
            },
            "home-003": {
                "soc_kwh": 20.0,
                "assigned_kw": 0.0,
                "power_kw": 0.0,
                "charge_state": "FULL",
                "status": "live",
                "zone": "West",
                "last_seen": TS,
                "command": None,
            },
        },
    }


def write_emit(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload))
    return path


@pytest.fixture
def no_network(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("the test tried to reach the network")
    monkeypatch.setattr(stream, "send", refuse)


def test_missing_emit_prints_no_controller(tmp_path, monkeypatch, capsys, no_network):
    monkeypatch.setattr(stream, "ENV_PATH", tmp_path / "unused.env")
    missing = tmp_path / "tick_emit.json"
    state = tmp_path / "sent.json"

    assert stream.main(["--path", str(missing), "--state-path", str(state)]) == 0
    assert capsys.readouterr().out == "telemetry_skipped: no_controller\n"
    assert not state.exists()


def test_bad_emit_prints_bad_emit(tmp_path, monkeypatch, capsys, no_network):
    monkeypatch.setattr(stream, "ENV_PATH", tmp_path / "unused.env")
    emit = tmp_path / "tick_emit.json"
    emit.write_text("{not json")
    state = tmp_path / "sent.json"

    assert stream.main(["--path", str(emit), "--state-path", str(state)]) == 0
    assert capsys.readouterr().out == "telemetry_skipped: bad_emit\n"


def test_rows_come_from_controller_not_a_random_roll():
    emit = make_emit()
    homes_rows = {row["home_id"]: row for row in stream.rows_for_homes(emit)}

    assert homes_rows["home-001"]["charge_state"] == "DISCHARGING"
    assert homes_rows["home-001"]["power_kw"] == 4.0
    assert homes_rows["home-001"]["assigned_kw"] == 4.0
    assert homes_rows["home-001"]["soc_kwh"] == 12.4
    assert homes_rows["home-001"]["last_seen"] == TS
    assert homes_rows["home-002"]["charge_state"] == "HOLDING"
    assert homes_rows["home-002"]["power_kw"] == 0.0
    assert "assigned_kw" in homes_rows["home-002"]
    # No random helpers remain to invent a mix.
    assert not hasattr(stream, "pick_state")
    assert not hasattr(stream, "power_for")
    assert not hasattr(stream, "soc_for")
    assert "new_fleet" not in Path(stream.__file__).read_text()


def test_readings_and_commands_cover_every_home_for_the_tick():
    emit = make_emit(tick=7)
    readings = {(row["home_id"], row["tick"]): row for row in stream.rows_for_readings(emit)}
    commands = {row["home_id"]: row for row in stream.rows_for_commands(emit)}

    assert set(readings) == {("home-001", 7), ("home-002", 7), ("home-003", 7)}
    assert readings[("home-001", 7)]["seen_at"] == TS
    assert readings[("home-001", 7)]["soc_kwh"] == 12.4
    assert set(commands) == {"home-001", "home-002", "home-003"}
    assert commands["home-001"]["command_id"] == "home-001:1"
    assert commands["home-001"]["kw"] == 4.0
    assert commands["home-001"]["ack"] == "ok"
    # Null commands still write one row: a 0 kW timeout, never a fake ok.
    assert commands["home-002"]["command_id"] == "home-002:7"
    assert commands["home-002"]["kw"] == 0.0
    assert commands["home-002"]["ack"] == "timeout"


def test_dry_run_counts_rows_and_sends_nothing(tmp_path, monkeypatch, capsys, no_network):
    emit = write_emit(tmp_path / "tick_emit.json", make_emit())
    state = tmp_path / "sent.json"
    monkeypatch.setattr(stream, "ENV_PATH", tmp_path / "unused.env")

    assert stream.main(["--dry-run", "--path", str(emit), "--state-path", str(state)]) == 0
    out = capsys.readouterr().out
    assert out.startswith("telemetry_built:")
    assert "3 homes 3 readings 3 commands" in out
    assert not state.exists()


def test_no_config_skips_without_marking_tick_sent(tmp_path, monkeypatch, capsys, no_network):
    emit = write_emit(tmp_path / "tick_emit.json", make_emit())
    state = tmp_path / "sent.json"
    monkeypatch.setattr(stream, "ENV_PATH", tmp_path / "unused.env")
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)

    assert stream.main(["--path", str(emit), "--state-path", str(state)]) == 0
    assert capsys.readouterr().out == "telemetry_skipped: no_config\n"
    assert not state.exists()


def test_one_tick_upserts_homes_and_appends_history(tmp_path, monkeypatch, capsys):
    emit = write_emit(tmp_path / "tick_emit.json", make_emit(tick=2))
    state = tmp_path / "sent.json"
    posted = []

    def fake_send(rows, url, key, table="homes", on_conflict="home_id"):
        posted.append((list(rows), url, key, table, on_conflict))

    monkeypatch.setattr(stream, "send", fake_send)
    monkeypatch.setattr(stream, "ENV_PATH", tmp_path / "unused.env")
    monkeypatch.setenv("SUPABASE_URL", "https://example.test")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "secret")

    assert stream.main(["--path", str(emit), "--state-path", str(state)]) == 0
    assert capsys.readouterr().out == "telemetry_ok\n"
    assert json.loads(state.read_text()) == {"tick": 2, "fleet_size": 3}

    by_table = {table: (rows, conflict) for rows, _u, _k, table, conflict in posted}
    assert set(by_table) == {"homes", "home_readings", "home_commands"}
    assert by_table["homes"][1] == "home_id"
    assert by_table["home_readings"][1] == "home_id,tick"
    assert by_table["home_commands"][1] == "command_id"

    homes_rows = {row["home_id"]: row for row in by_table["homes"][0]}
    assert homes_rows["home-001"]["assigned_kw"] == 4.0
    assert homes_rows["home-001"]["charge_state"] == "DISCHARGING"
    assert len(by_table["home_readings"][0]) == 3
    assert len(by_table["home_commands"][0]) == 3


def test_second_run_of_same_tick_is_skipped(tmp_path, monkeypatch, capsys):
    emit = write_emit(tmp_path / "tick_emit.json", make_emit(tick=4))
    state = tmp_path / "sent.json"
    calls = []

    def fake_send(rows, url, key, table="homes", on_conflict="home_id"):
        calls.append(table)

    monkeypatch.setattr(stream, "send", fake_send)
    monkeypatch.setattr(stream, "ENV_PATH", tmp_path / "unused.env")
    monkeypatch.setenv("SUPABASE_URL", "https://example.test")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "secret")

    assert stream.main(["--path", str(emit), "--state-path", str(state)]) == 0
    assert capsys.readouterr().out == "telemetry_ok\n"
    assert calls == ["homes", "home_readings", "home_commands"]

    assert stream.main(["--path", str(emit), "--state-path", str(state)]) == 0
    assert capsys.readouterr().out == "telemetry_skipped: duplicate\n"
    assert len(calls) == 3


def test_loop_dry_run_runs_once_and_exits(tmp_path, monkeypatch, capsys, no_network):
    emit = write_emit(tmp_path / "tick_emit.json", make_emit())
    state = tmp_path / "sent.json"
    monkeypatch.setattr(stream, "ENV_PATH", tmp_path / "unused.env")

    assert stream.main(["--loop", "--dry-run", "--path", str(emit), "--state-path", str(state)]) == 0
    assert capsys.readouterr().out.startswith("telemetry_built:")


def test_loop_waits_quietly_until_the_emit_file_changes(tmp_path, monkeypatch, capsys):
    emit = write_emit(tmp_path / "tick_emit.json", make_emit(tick=9))
    state = tmp_path / "sent.json"
    monkeypatch.setattr(stream, "ENV_PATH", tmp_path / "unused.env")
    monkeypatch.setenv("SUPABASE_URL", "https://example.test")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "secret")
    monkeypatch.setattr(stream, "send", lambda *args, **kwargs: None)

    calls = []
    orig = stream.run_once

    def counting(*args, **kwargs):
        calls.append(args)
        return orig(*args, **kwargs)

    sleeps = []

    def stop_after_two(seconds):
        sleeps.append(seconds)
        if len(sleeps) >= 2:
            raise RuntimeError("stop the loop")

    monkeypatch.setattr(stream, "run_once", counting)
    monkeypatch.setattr(stream.time, "sleep", stop_after_two)

    with pytest.raises(RuntimeError, match="stop the loop"):
        stream.main(["--loop", "--path", str(emit), "--state-path", str(state), "--every", "1"])
    # First sighting sends the tick; the unchanged file then sleeps quietly.
    assert len(calls) == 1
    assert capsys.readouterr().out == "telemetry_ok\n"


def make_big_emit(n=20, tick=1):
    homes = {}
    states = ["DISCHARGING", "HOLDING", "CHARGING"]
    for i in range(1, n + 1):
        hid = f"home-{i:03d}"
        state = states[i % len(states)]
        power = 4.0 if state == "DISCHARGING" else (-4.0 if state == "CHARGING" else 0.0)
        homes[hid] = {
            "soc_kwh": 12.0 + (i % 5),
            "assigned_kw": power,
            "power_kw": power,
            "charge_state": state,
            "status": "live",
            "zone": "South",
            "last_seen": TS,
            "command": None,
        }
    return {
        "tick": tick,
        "ts": TS,
        "target_mw": 40.0,
        "target_label": "synthetic",
        "delivered_mw": 4.0,
        "fleet_size": n,
        "homes": homes,
    }


def test_drop_draw_is_deterministic_for_a_tick():
    emit = make_big_emit()
    first = stream.select_dropped(emit, 0.3, seed=1)
    assert stream.select_dropped(emit, 0.3, seed=1) == first
    assert 0 < len(first) < 20
    assert stream.select_dropped(emit, 0.0, seed=1) == set()


def test_dropped_telemetry_skips_homes_and_readings_but_keeps_commands(tmp_path, monkeypatch, capsys):
    emit = write_emit(tmp_path / "tick_emit.json", make_big_emit(n=20, tick=3))
    state = tmp_path / "sent.json"
    posted = {}

    def fake_send(rows, url, key, table="homes", on_conflict="home_id"):
        posted[table] = list(rows)

    monkeypatch.setattr(stream, "send", fake_send)
    monkeypatch.setattr(stream, "ENV_PATH", tmp_path / "unused.env")
    monkeypatch.setenv("SUPABASE_URL", "https://example.test")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "secret")

    assert stream.main([
        "--path", str(emit), "--state-path", str(state),
        "--drop-rate", "0.3", "--seed", "1",
    ]) == 0
    assert capsys.readouterr().out == "telemetry_ok\n"

    dropped = stream.select_dropped(make_big_emit(n=20, tick=3), 0.3, seed=1)
    assert 0 < len(dropped) < 20
    assert {row["home_id"] for row in posted["homes"]} == set(make_big_emit()["homes"]) - dropped
    assert {row["home_id"] for row in posted["home_readings"]} == set(make_big_emit()["homes"]) - dropped
    # Commands are the controller log: every home still gets one row.
    assert len(posted["home_commands"]) == 20
    # Survivors keep the controller's charge state; nothing is re-rolled.
    by_id = {row["home_id"]: row for row in posted["homes"]}
    survivor = next(iter(sorted(set(make_big_emit()["homes"]) - dropped)))
    assert by_id[survivor]["charge_state"] == make_big_emit()["homes"][survivor]["charge_state"]


def test_engine_does_not_import_stream_telemetry():
    offenders = [
        path.as_posix()
        for path in (ROOT / "server" / "engine").rglob("*.py")
        if "stream_telemetry" in path.read_text()
    ]
    assert offenders == []
