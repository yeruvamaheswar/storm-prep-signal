"""scripts/seed_homes.py and the public.homes migration. No live network."""
import importlib.util
import random
from collections import Counter
from pathlib import Path

import pytest

from server.engine.fleet import ZONE_ORDER, new_fleet

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = ROOT / "supabase" / "migrations" / "20260926_homes.sql"
spec = importlib.util.spec_from_file_location("seed_homes", ROOT / "scripts" / "seed_homes.py")
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)

COLUMNS = (
    "home_id", "zone", "capacity_kwh", "soc_kwh", "max_kw", "status",
    "assigned_kw", "last_seen", "charge_state", "power_kw", "boot_id",
    "last_seq", "run_id", "tick", "updated_at",
)


@pytest.fixture
def no_network(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("the test tried to reach the network")
    monkeypatch.setattr(seed, "send", refuse)


def test_migration_is_an_upsert_ready_homes_table():
    sql = MIGRATION.read_text()
    folded = " ".join(sql.lower().split())

    assert "create table public.homes" in folded
    for column in COLUMNS:
        assert column in folded, column
    assert "primary key" in folded
    assert "replica identity full" in folded
    assert "on public.homes (zone)" in folded
    assert "on public.homes (zone, status)" in folded
    assert "enable row level security" not in folded


def test_build_rows_keeps_zones_and_randomizes_soc(no_network):
    homes = new_fleet(10_000)
    rows = seed.build_rows(rng=random.Random(1))
    other = seed.build_rows(rng=random.Random(2))
    again = seed.build_rows(rng=random.Random(1))

    assert len(rows) == 10_000
    assert rows[0]["home_id"] == "home-001"
    assert rows[-1]["home_id"] == "home-10000"
    assert [row["zone"] for row in rows] == [home.zone for home in homes]
    assert Counter(row["zone"] for row in rows) == {zone: 2500 for zone in ZONE_ORDER}
    assert all(9.0 <= row["soc_kwh"] <= 15.0 for row in rows)
    assert [row["soc_kwh"] for row in rows] != [home.soc_kwh for home in homes]
    assert [row["soc_kwh"] for row in rows] != [row["soc_kwh"] for row in other]
    assert [row["soc_kwh"] for row in rows] == [row["soc_kwh"] for row in again]
    assert all(row["capacity_kwh"] == 20 and row["max_kw"] == 5 for row in rows)
    assert all(row["status"] == "live" and row["assigned_kw"] == 0 for row in rows)
    assert all(row["zone"] in ZONE_ORDER for row in rows)


def test_dry_run_builds_ten_thousand_and_sends_nothing(monkeypatch, capsys, no_network):
    sent = []

    def fake_send(*args, **kwargs):
        sent.append((args, kwargs))

    monkeypatch.setattr(seed, "send", fake_send)

    assert seed.main(["--dry-run"]) == 0
    assert sent == []
    assert "10000" in capsys.readouterr().out


def test_missing_config_skips_without_sending(tmp_path, monkeypatch, capsys, no_network):
    monkeypatch.setattr(seed, "ENV_PATH", tmp_path / "missing.env")
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)

    assert seed.main([]) == 0
    assert capsys.readouterr().out == "homes_skipped: no_config\n"


def test_upsert_uses_home_id_and_keeps_going_on_failure(monkeypatch, no_network):
    sent = []

    def fake_send(rows, url, key, table="ercot_postings", on_conflict="report,posted_at"):
        sent.append((table, on_conflict, url, len(rows), rows[0]["home_id"]))
        raise seed.BatchFailed("HTTP 503: down")

    monkeypatch.setattr(seed, "send", fake_send)

    status = seed.persist_rows(
        seed.build_rows(), url="https://example.test", key="secret",
    )

    assert status == "skipped: HTTP 503: down"
    assert sent == [("homes", "home_id", "https://example.test", 10_000, "home-001")]
