"""scripts/persist_telemetry.py: last readings onto public.homes. No live network."""
import importlib.util
import json
from pathlib import Path

import pytest

from server.engine.telemetry import HomeState

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    "persist_telemetry", ROOT / "scripts" / "persist_telemetry.py",
)
persist = importlib.util.module_from_spec(spec)
spec.loader.exec_module(persist)

AS_OF = "2026-09-26T21:05:00+00:00"
LAST = {
    "last_seen": "2026-09-26T21:04:50+00:00",
    "charge_state": "DISCHARGING",
    "power_kw": 2.5,
    "boot_id": "1",
    "last_seq": 30,
    "soc_kwh": 12.0,
}


def sample_last(index, **extra):
    row = {
        "last_seen": AS_OF,
        "charge_state": "HOLDING",
        "power_kw": 0.0,
        "boot_id": "1",
        "last_seq": index,
        "soc_kwh": 10.0 + index / 10,
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


def test_row_maps_only_telemetry_columns(no_network):
    row = persist.row_from_last("home-001", LAST)

    assert row["home_id"] == "home-001"
    assert row["last_seen"] == LAST["last_seen"]
    assert row["charge_state"] == "DISCHARGING"
    assert row["power_kw"] == 2.5
    assert row["boot_id"] == "1"
    assert row["last_seq"] == 30
    assert row["soc_kwh"] == 12.0
    assert "zone" not in row
    assert "capacity_kwh" not in row
    assert "status" not in row
    assert "assigned_kw" not in row
    assert "updated_at" not in row


def test_soc_kwh_omitted_when_not_reported(no_network):
    last = {k: v for k, v in LAST.items() if k != "soc_kwh"}
    row = persist.row_from_last("home-002", last)

    assert "soc_kwh" not in row
    assert row["last_seq"] == 30


def test_snapshot_from_home_state_is_keyed_by_home_id(no_network):
    hs = HomeState("home-001", 20.0)
    hs.last = {
        "soc_kwh": 12.0, "power_kw": -1.5, "charge_state": "CHARGING",
        "boot_id": 1, "seq": 4,
    }
    hs.last_seen = 290.0
    hs.boot_id = 1
    hs.last_seq = 4
    silent = HomeState("home-002", 20.0)

    snap = persist.snapshot_from_state(
        {"home-001": hs, "home-002": silent}, as_of=AS_OF, now_s=300.0,
    )

    assert list(snap) == ["home-001"]
    assert snap["home-001"]["last_seen"] == "2026-09-26T21:04:50+00:00"
    assert snap["home-001"]["charge_state"] == "CHARGING"
    assert snap["home-001"]["power_kw"] == -1.5
    assert snap["home-001"]["boot_id"] == "1"
    assert snap["home-001"]["last_seq"] == 4
    assert snap["home-001"]["soc_kwh"] == 12.0


def test_write_snapshot_writes_keyed_file(tmp_path, no_network):
    hs = HomeState("home-001", 20.0)
    hs.last = {
        "soc_kwh": 11.0, "power_kw": 0.0, "charge_state": "HOLDING",
        "boot_id": 1, "seq": 1,
    }
    hs.last_seen = 300.0
    hs.boot_id = 1
    hs.last_seq = 1
    path = tmp_path / "telemetry.json"

    written = persist.write_snapshot({"home-001": hs}, path, as_of=AS_OF, now_s=300.0)
    payload = json.loads(path.read_text())

    assert written == path
    assert list(payload) == ["home-001"]
    assert payload["home-001"]["last_seq"] == 1
    assert persist.rows_from_snapshot(payload)[0]["home_id"] == "home-001"


def test_dry_run_builds_rows_and_sends_nothing(tmp_path, monkeypatch, capsys, no_network):
    path = tmp_path / "telemetry.json"
    path.write_text(json.dumps({"home-001": LAST, "home-002": sample_last(2)}))
    monkeypatch.setattr(persist, "ENV_PATH", tmp_path / "missing.env")
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)

    assert persist.main([str(path), "--dry-run"]) == 0
    assert capsys.readouterr().out == "telemetry_built: 2\n"


def test_missing_config_skips_without_sending(tmp_path, monkeypatch, capsys, no_network):
    path = tmp_path / "telemetry.json"
    path.write_text(json.dumps({"home-001": LAST}))
    monkeypatch.setattr(persist, "ENV_PATH", tmp_path / "missing.env")
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)

    assert persist.main([str(path)]) == 0
    assert capsys.readouterr().out == "telemetry_skipped: no_config\n"


def test_upsert_uses_home_id_conflict_and_keeps_going_on_failure(no_network, monkeypatch):
    sent = []

    def fake_send(rows, url, key, table="ercot_postings", on_conflict="report,posted_at"):
        sent.append((table, on_conflict, url, [row["home_id"] for row in rows], rows[0]["last_seq"]))
        raise persist.BatchFailed("HTTP 503: down")

    monkeypatch.setattr(persist, "send", fake_send)

    status = persist.persist_telemetry(
        {"home-001": LAST}, url="https://example.test", key="secret",
    )

    assert status == "skipped: HTTP 503: down"
    assert sent == [("homes", "home_id", "https://example.test", ["home-001"], 30)]


def test_failed_post_prints_skipped_and_exits_zero(tmp_path, monkeypatch, capsys, no_network):
    path = tmp_path / "telemetry.json"
    path.write_text(json.dumps({"home-001": LAST}))
    monkeypatch.setenv("SUPABASE_URL", "https://example.test")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "secret")
    monkeypatch.setattr(persist, "ENV_PATH", tmp_path / "unused.env")
    monkeypatch.setattr(
        persist, "persist_telemetry",
        lambda *args, **kwargs: "skipped: HTTP 503: down",
    )

    assert persist.main([str(path)]) == 0
    assert capsys.readouterr().out == "telemetry_skipped: HTTP 503: down\n"


def test_batches_are_200_to_500(tmp_path, monkeypatch):
    payload = {f"home-{i:03d}": sample_last(i) for i in range(1, 601)}
    path = tmp_path / "telemetry.json"
    path.write_text(json.dumps(payload))
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


def test_engine_does_not_import_persist_telemetry():
    offenders = [
        path.as_posix()
        for path in (ROOT / "server" / "engine").rglob("*.py")
        if "persist_telemetry" in path.read_text()
    ]
    assert offenders == []


def test_telemetry_module_does_not_import_supabase():
    text = (ROOT / "server" / "engine" / "telemetry.py").read_text()
    assert "supabase" not in text.lower()
    assert "persist_telemetry" not in text
