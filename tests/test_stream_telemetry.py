"""scripts/stream_telemetry.py: realistic last readings onto public.homes."""
import importlib.util
from datetime import datetime, timezone
from pathlib import Path

import pytest

from server.engine.fleet import new_fleet

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    "stream_telemetry", ROOT / "scripts" / "stream_telemetry.py",
)
stream = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stream)

NOW = datetime(2026, 9, 26, 22, 5, tzinfo=timezone.utc)
CHARGE_STATES = {"CHARGING", "DISCHARGING", "HOLDING", "FULL", "EMPTY"}


@pytest.fixture
def no_network(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("the test tried to reach the network")
    monkeypatch.setattr(stream, "persist_pulse", refuse)
    monkeypatch.setattr(stream, "send", refuse)


def test_snapshot_uses_seed_home_ids_and_omits_silent(no_network):
    homes = new_fleet(200)
    snap = stream.build_snapshot(homes, now=NOW, rng=stream.random.Random(1))

    assert 0.04 * 200 <= (200 - len(snap)) <= 0.10 * 200
    assert set(snap) <= {home.home_id for home in homes}
    assert snap["home-001"]["charge_state"] in CHARGE_STATES


def test_power_sign_matches_charge_state(no_network):
    snap = stream.build_snapshot(new_fleet(200), now=NOW, rng=stream.random.Random(2))
    states = {row["charge_state"] for row in snap.values()}

    assert CHARGE_STATES <= states
    for row in snap.values():
        state, power, soc = row["charge_state"], row["power_kw"], row["soc_kwh"]
        if state == "DISCHARGING":
            assert power > 0
        elif state == "CHARGING":
            assert power < 0
        else:
            assert power == 0
        if state == "FULL":
            assert soc >= 18.0
        if state == "EMPTY":
            assert soc <= 2.0
        assert 0.0 <= soc <= 20.0
        assert "last_seen" in row
        assert "boot_id" in row
        assert "last_seq" in row


def test_most_readings_are_live_some_stale_or_dead(no_network):
    snap = stream.build_snapshot(new_fleet(400), now=NOW, rng=stream.random.Random(3))
    ages = []
    for row in snap.values():
        seen = datetime.fromisoformat(row["last_seen"])
        ages.append((NOW - seen).total_seconds())

    live = sum(1 for age in ages if age <= 180)
    stale = sum(1 for age in ages if 180 < age <= 600)
    dead = sum(1 for age in ages if age > 600)
    assert live / len(ages) >= 0.70
    assert stale >= 8
    assert dead >= 4


def test_next_pulse_increments_seq_and_refreshes_live_clock(no_network):
    homes = new_fleet(80)
    first = stream.build_snapshot(homes, now=NOW, rng=stream.random.Random(4), pulse=1)
    later = NOW.replace(minute=6)
    second = stream.build_snapshot(
        homes, now=later, rng=stream.random.Random(4), pulse=2, previous=first,
    )

    shared = set(first) & set(second)
    assert shared
    bumped = sum(1 for hid in shared if second[hid]["last_seq"] > first[hid]["last_seq"])
    assert bumped / len(shared) >= 0.8


def test_dry_run_writes_nothing_and_sends_nothing(tmp_path, no_network, capsys):
    dest = tmp_path / "telemetry.json"
    assert stream.main(["--dry-run", "--n", "80", "--path", str(dest)]) == 0
    assert not dest.exists()
    assert capsys.readouterr().out.startswith("telemetry_built:")


def test_no_config_skips_after_writing_snapshot(tmp_path, monkeypatch, capsys):
    dest = tmp_path / "telemetry.json"
    monkeypatch.setattr(stream, "ENV_PATH", tmp_path / "unused.env")
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)

    assert stream.main(["--n", "80", "--path", str(dest)]) == 0
    assert dest.is_file()
    assert capsys.readouterr().out == "telemetry_skipped: no_config\n"


def test_upsert_rows_carry_identity_so_postgres_accepts_the_insert(no_network):
    homes = new_fleet(40)
    snap = stream.build_snapshot(homes, now=NOW, rng=stream.random.Random(5))
    rows = stream.rows_for_upsert(homes, snap)

    assert rows
    assert all(row["zone"] in {"South", "North", "West", "Houston"} for row in rows)
    assert all(row["capacity_kwh"] == 20 for row in rows)
    assert all(row["max_kw"] == 5 for row in rows)
    assert all(row["status"] == "live" for row in rows)
    assert all("assigned_kw" not in row for row in rows)
    assert all(row["charge_state"] in CHARGE_STATES for row in rows)


def test_one_pulse_persists_identity_and_telemetry(tmp_path, monkeypatch, capsys):
    dest = tmp_path / "telemetry.json"
    posted = []

    def fake_send(rows, url, key, table="homes", on_conflict="home_id"):
        posted.append((rows, url, key, table, on_conflict))

    monkeypatch.setattr(stream, "send", fake_send)
    monkeypatch.setattr(stream, "ENV_PATH", tmp_path / "unused.env")
    monkeypatch.setenv("SUPABASE_URL", "https://example.test")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "secret")

    assert stream.main(["--n", "80", "--path", str(dest)]) == 0
    assert dest.is_file()
    rows, url, _key, table, on_conflict = posted[0]
    assert url == "https://example.test"
    assert table == "homes"
    assert on_conflict == "home_id"
    assert len(rows) >= 70
    assert all("zone" in row and "charge_state" in row for row in rows)
    assert capsys.readouterr().out == "telemetry_ok\n"


def test_engine_does_not_import_stream_telemetry():
    offenders = [
        path.as_posix()
        for path in (ROOT / "server" / "engine").rglob("*.py")
        if "stream_telemetry" in path.read_text()
    ]
    assert offenders == []
