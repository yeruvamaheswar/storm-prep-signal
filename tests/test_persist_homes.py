"""scripts/persist_homes.py: map var/fleet/homes.json onto public.homes. No live network."""
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("persist_homes", ROOT / "scripts" / "persist_homes.py")
persist = importlib.util.module_from_spec(spec)
spec.loader.exec_module(persist)

HOME = {
    "home_id": "home-001",
    "capacity_kwh": 20.0,
    "soc_kwh": 12.0,
    "max_kw": 5.0,
    "status": "live",
    "zone": "South",
    "updated_at": "2026-09-26T16:00:00-05:00",
}
NOW = "2026-09-26T21:00:00+00:00"


def sample_home(index, **extra):
    zones = ("South", "North", "West", "Houston")
    row = {
        "home_id": f"home-{index:03d}",
        "capacity_kwh": 20.0,
        "soc_kwh": 10.0 + index / 10,
        "max_kw": 5.0,
        "status": "live",
        "zone": zones[(index - 1) % 4],
        "updated_at": "",
    }
    row.update(extra)
    return row


class _Ok:
    ok = True
    text = ""


@pytest.fixture
def no_network(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("the test tried to reach the network")
    monkeypatch.setattr(persist.requests, "post", refuse)
    monkeypatch.setattr(persist.archive.requests, "post", refuse)


def test_row_maps_home_and_optional_fields(no_network):
    row = persist.row_from_home(
        {**HOME, "assigned_kw": 4.5, "run_id": "run-1", "tick": 3},
        now=NOW,
    )

    assert row["home_id"] == "home-001"
    assert row["zone"] == "South"
    assert row["capacity_kwh"] == 20.0
    assert row["soc_kwh"] == 12.0
    assert row["max_kw"] == 5.0
    assert row["status"] == "live"
    assert row["assigned_kw"] == 4.5
    assert row["run_id"] == "run-1"
    assert row["tick"] == 3
    assert row["updated_at"] == HOME["updated_at"]
    assert "last_seen" not in row
    assert "charge_state" not in row
    assert "power_kw" not in row


def test_assigned_kw_defaults_to_zero_and_empty_updated_at_stamps(no_network):
    row = persist.row_from_home({**HOME, "updated_at": ""}, now=NOW)

    assert row["assigned_kw"] == 0
    assert row["updated_at"] == NOW
    assert "run_id" not in row
    assert "tick" not in row


def test_payload_list_and_wrapper_share_optional_fields(no_network):
    listed = persist.rows_from_payload(
        [{**HOME, "assigned_kw": 1.5, "run_id": "per-home", "tick": 2}],
        now=NOW,
    )
    wrapped = persist.rows_from_payload(
        {
            "homes": [HOME],
            "assigned_kw": {"home-001": 4.5},
            "run_id": "run-wrap",
            "tick": 7,
        },
        now=NOW,
    )

    assert listed[0]["assigned_kw"] == 1.5
    assert listed[0]["run_id"] == "per-home"
    assert listed[0]["tick"] == 2
    assert wrapped[0]["assigned_kw"] == 4.5
    assert wrapped[0]["run_id"] == "run-wrap"
    assert wrapped[0]["tick"] == 7


def test_rows_from_save_fleet_snapshot(tmp_path, no_network):
    from server.engine.fleet import new_fleet, save_fleet

    path = save_fleet(new_fleet(4), tmp_path / "homes.json")
    rows = persist.rows_from_payload(json.loads(path.read_text()), now=NOW)

    assert [row["home_id"] for row in rows] == ["home-001", "home-002", "home-003", "home-004"]
    assert rows[0]["zone"] == "South"
    assert rows[0]["assigned_kw"] == 0
    assert rows[0]["status"] == "live"


def test_dry_run_builds_rows_and_sends_nothing(tmp_path, monkeypatch, capsys, no_network):
    path = tmp_path / "homes.json"
    path.write_text(json.dumps([HOME, sample_home(2)]))
    monkeypatch.setattr(persist, "ENV_PATH", tmp_path / "missing.env")
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)

    assert persist.main([str(path), "--dry-run"]) == 0
    assert capsys.readouterr().out == "homes_built: 2\n"


def test_missing_config_skips_without_sending(tmp_path, monkeypatch, capsys, no_network):
    path = tmp_path / "homes.json"
    path.write_text(json.dumps([HOME]))
    monkeypatch.setattr(persist, "ENV_PATH", tmp_path / "missing.env")
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)

    assert persist.main([str(path)]) == 0
    assert capsys.readouterr().out == "homes_skipped: no_config\n"


def test_upsert_uses_home_id_conflict_and_keeps_going_on_failure(no_network, monkeypatch):
    sent = []

    def fake_send(rows, url, key, table="ercot_postings", on_conflict="report,posted_at"):
        sent.append((table, on_conflict, url, [row["home_id"] for row in rows], rows[0]["soc_kwh"]))
        raise persist.BatchFailed("HTTP 503: down")

    monkeypatch.setattr(persist, "send", fake_send)

    status = persist.persist_homes(
        [HOME], url="https://example.test", key="secret", now=NOW,
    )

    assert status == "skipped: HTTP 503: down"
    assert sent == [("homes", "home_id", "https://example.test", ["home-001"], 12.0)]


def test_failed_post_prints_skipped_and_exits_zero(tmp_path, monkeypatch, capsys, no_network):
    path = tmp_path / "homes.json"
    path.write_text(json.dumps([HOME]))
    monkeypatch.setenv("SUPABASE_URL", "https://example.test")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "secret")
    monkeypatch.setattr(persist, "ENV_PATH", tmp_path / "unused.env")
    monkeypatch.setattr(
        persist, "persist_homes",
        lambda *args, **kwargs: "skipped: HTTP 503: down",
    )

    assert persist.main([str(path)]) == 0
    assert capsys.readouterr().out == "homes_skipped: HTTP 503: down\n"


def test_batches_are_200_to_500(tmp_path, monkeypatch):
    homes = [sample_home(i) for i in range(1, 601)]
    path = tmp_path / "homes.json"
    path.write_text(json.dumps(homes))
    posted = []

    def fake_post(url, json=None, headers=None, timeout=None):
        posted.append((url, json, headers))
        return _Ok()

    monkeypatch.setattr(persist.archive.requests, "post", fake_post)
    monkeypatch.setenv("SUPABASE_URL", "https://example.test")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "secret")
    monkeypatch.setattr(persist, "ENV_PATH", tmp_path / "unused.env")

    assert persist.main([str(path)]) == 0
    sizes = [len(body) for _, body, _ in posted]
    assert sizes
    assert all(200 <= size <= 500 for size in sizes)
    assert sum(sizes) == 600
    assert "on_conflict=home_id" in posted[0][0]
    assert posted[0][2]["Prefer"] == "resolution=merge-duplicates"


def test_engine_does_not_import_persist_homes():
    offenders = [
        path.as_posix()
        for path in (ROOT / "server" / "engine").rglob("*.py")
        if "persist_homes" in path.read_text()
    ]
    assert offenders == []
