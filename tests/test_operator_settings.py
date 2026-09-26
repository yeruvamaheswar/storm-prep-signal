"""public.operator_settings is the shared HOLD/AUTO row. No live network."""
import json
from pathlib import Path

import pytest
import requests

from server.api import operator_settings as settings
from server.engine.fleet_state import load_fleet_mode, write_fleet_mode

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = ROOT / "supabase" / "migrations" / "20260926_operator_settings.sql"


class Reply:
    def __init__(self, rows, ok=True, status_code=200):
        self._rows = rows
        self.ok = ok
        self.status_code = status_code

    def json(self):
        return self._rows


@pytest.fixture
def no_network(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("the test tried to reach the network")
    monkeypatch.setattr(settings.requests, "get", refuse)
    monkeypatch.setattr(settings.requests, "post", refuse)


def test_migration_is_a_singleton_operator_settings_table():
    sql = MIGRATION.read_text()
    folded = " ".join(sql.lower().split())

    assert "create table public.operator_settings" in folded
    assert "mode" in folded
    assert "updated_by" in folded
    assert "updated_at" in folded
    assert "primary key" in folded
    assert "auto" in folded and "hold" in folded
    assert "alter table public.operator_settings enable row level security" in folded
    assert "create policy" not in folded
    assert "insert into public.operator_settings" not in folded


def test_row_maps_mode_and_operator(no_network):
    row = settings.row_for_mode("HOLD", operator_id="op-uma")

    assert row["id"] == "fleet"
    assert row["mode"] == "HOLD"
    assert row["updated_by"] == "op-uma"


def test_persist_mode_upserts_on_id(no_network):
    sent = []

    def fake_post(url, json=None, headers=None, timeout=None):
        sent.append((url, json, headers))
        return Reply([])

    status = settings.persist_mode(
        "HOLD", url="https://example.supabase.co", key="test-key",
        operator_id="op-uma", http_post=fake_post,
    )

    assert status == "ok"
    url, body, headers = sent[0]
    assert url.endswith("/rest/v1/operator_settings?on_conflict=id")
    assert body == [{"id": "fleet", "mode": "HOLD", "updated_by": "op-uma"}]
    assert headers["Prefer"] == "resolution=merge-duplicates"


def test_persist_mode_skips_without_config(no_network):
    assert settings.persist_mode("AUTO", url="", key="") == "skipped: no_config"


def test_load_mode_reads_hold(no_network):
    mode = settings.load_mode(
        url="https://example.supabase.co", key="test-key",
        http_get=lambda *a, **k: Reply([{"mode": "HOLD"}]),
    )
    assert mode == "HOLD"


def test_load_mode_missing_or_bad_is_none(no_network):
    assert settings.load_mode(url="", key="") is None
    assert settings.load_mode(
        url="https://example.supabase.co", key="test-key",
        http_get=lambda *a, **k: Reply([]),
    ) is None
    assert settings.load_mode(
        url="https://example.supabase.co", key="test-key",
        http_get=lambda *a, **k: Reply([{"mode": "RESERVE"}]),
    ) is None


def test_load_mode_network_failure_is_none(no_network):
    def boom(*args, **kwargs):
        raise requests.Timeout("slow")

    assert settings.load_mode(
        url="https://example.supabase.co", key="test-key", http_get=boom,
    ) is None


def test_hydrate_table_hold_wins_over_local_auto(tmp_path, no_network):
    path = tmp_path / "state.json"
    write_fleet_mode("AUTO", path)

    mode = settings.hydrate_local_mode(
        path, url="https://example.supabase.co", key="test-key",
        http_get=lambda *a, **k: Reply([{"mode": "HOLD"}]),
    )

    assert mode == "HOLD"
    assert load_fleet_mode(path) == "HOLD"
    assert json.loads(path.read_text()) == {"mode": "HOLD"}


def test_hydrate_keeps_local_when_table_silent(tmp_path, no_network):
    path = tmp_path / "state.json"
    write_fleet_mode("HOLD", path)

    mode = settings.hydrate_local_mode(
        path, url="https://example.supabase.co", key="test-key",
        http_get=lambda *a, **k: Reply([]),
    )

    assert mode == "HOLD"
    assert load_fleet_mode(path) == "HOLD"
