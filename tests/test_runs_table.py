"""Empty public.runs is not a run. The snapshot file stays the source of truth."""

import json

from fastapi.testclient import TestClient

from server.app import create_app
from server.api.fixtures import FixtureStore
from server.api.snapshot import fetch_runs_table, load_latest_run, run_from_table_rows


ENGINE = {
    "run_id": "engine-run",
    "decision_line": None,
    "source": "live",
    "ticks": [
        {
            "tick": 1,
            "ts": "2026-09-26T12:00:00-05:00",
            "mode": "AUTO",
            "target_mw": 0.2,
            "target_label": "synthetic",
            "delivered_mw": 0.2,
            "missed_mw": 0.0,
            "price_usd_mwh": 48,
            "price_label": "synthetic",
            "reserve_pct": 30,
            "policy_reason": "normal",
            "risk_level": "LOW",
            "live_homes": 100,
            "stale_homes": 0,
            "dead_homes": 0,
            "breaches": 0,
            "reasons": [],
            "brief": "engine brief",
        }
    ],
}

LAYOUT = {**ENGINE, "run_id": "layout-fixture", "source": "fixture"}
TABLE_RUN = {**ENGINE, "run_id": "table-run"}


def test_empty_runs_table_is_not_a_run():
    assert run_from_table_rows([]) is None
    assert run_from_table_rows(None) is None
    assert run_from_table_rows([{}]) is None
    assert run_from_table_rows([{"run_id": "x", "result": []}]) is None
    assert run_from_table_rows([{"run_id": "x", "result": "var/runs/latest.json"}]) is None


def test_runs_table_row_with_result_is_a_run():
    assert run_from_table_rows([{"run_id": "table-run", "result": TABLE_RUN}])["run_id"] == "table-run"
    assert run_from_table_rows([{"run_id": "table-run", "source": "live", "result": TABLE_RUN["ticks"]}])[
        "run_id"
    ] == "table-run"


def test_load_latest_run_keeps_file_when_table_is_empty(tmp_path, monkeypatch):
    latest = tmp_path / "latest.json"
    latest.write_text(json.dumps(ENGINE), encoding="utf-8")
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", latest)
    monkeypatch.setattr("server.api.snapshot.fetch_runs_table", lambda: [])
    assert load_latest_run()["run_id"] == "engine-run"


def test_load_latest_run_keeps_file_when_table_has_rows(tmp_path, monkeypatch):
    latest = tmp_path / "latest.json"
    latest.write_text(json.dumps(ENGINE), encoding="utf-8")
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", latest)
    monkeypatch.setattr("server.api.snapshot.fetch_runs_table", lambda: [{"result": TABLE_RUN}])
    assert load_latest_run()["run_id"] == "engine-run"


def test_load_latest_run_uses_table_only_when_file_missing(tmp_path, monkeypatch):
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", tmp_path / "missing.json")
    monkeypatch.setattr("server.api.snapshot.LAYOUT_RUN", tmp_path / "layout.json")
    (tmp_path / "layout.json").write_text(json.dumps(LAYOUT), encoding="utf-8")
    monkeypatch.setattr("server.api.snapshot.fetch_runs_table", lambda: [{"result": TABLE_RUN}])
    assert load_latest_run()["run_id"] == "table-run"


def test_load_latest_run_falls_back_to_layout_when_table_empty(tmp_path, monkeypatch):
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", tmp_path / "missing.json")
    monkeypatch.setattr("server.api.snapshot.LAYOUT_RUN", tmp_path / "layout.json")
    (tmp_path / "layout.json").write_text(json.dumps(LAYOUT), encoding="utf-8")
    monkeypatch.setattr("server.api.snapshot.fetch_runs_table", lambda: [])
    assert load_latest_run()["run_id"] == "layout-fixture"


def test_fetch_runs_table_skips_without_config():
    def refuse(*_args, **_kwargs):
        raise AssertionError("empty config must not GET PostgREST /runs")

    assert fetch_runs_table(get=refuse, url="", key="") is None


def test_get_latest_run_keeps_file_when_postgrest_is_empty(tmp_path, monkeypatch):
    latest = tmp_path / "latest.json"
    latest.write_text(json.dumps(ENGINE), encoding="utf-8")
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", latest)
    monkeypatch.setattr("server.api.snapshot.fetch_runs_table", lambda: [])
    body = TestClient(create_app(FixtureStore())).get("/v1/runs/latest").json()
    assert body["run_id"] == "engine-run"
