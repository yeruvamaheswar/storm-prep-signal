"""scripts/persist_run.py: map a local run file onto public.runs. No live network."""
import importlib.util
import json
from pathlib import Path

import pytest
import requests

ROOT = Path(__file__).resolve().parent.parent
TAPE = ROOT / "tests" / "fixtures" / "tape_tiny.json"
spec = importlib.util.spec_from_file_location("persist_run", ROOT / "scripts" / "persist_run.py")
persist = importlib.util.module_from_spec(spec)
spec.loader.exec_module(persist)

LAST = {
    "tick": 3, "ts": "2026-09-25T12:10:00-05:00", "mode": "AUTO",
    "target_mw": 0.4, "delivered_mw": 0.185, "missed_mw": 0.215,
    "reserve_pct": 60, "risk_level": None, "policy_reason": "signal_unavailable",
    "live_homes": 100, "stale_homes": 0, "dead_homes": 0, "breaches": 0,
    "price_usd_mwh": 250.0, "price_label": "synthetic", "brief": "held",
}
RECORD = {
    "run_id": "20260926-120000-000001",
    "tape": str(TAPE),
    "source": "scenario",
    "settings": {"fleet_size": 100},
    "ticks": [
        {**LAST, "tick": 1, "reserve_pct": 30, "risk_level": "LOW", "policy_reason": "normal"},
        LAST,
    ],
    "totals": {},
}


@pytest.fixture
def no_network(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("the test tried to reach the network")
    monkeypatch.setattr(persist.requests, "post", refuse)
    monkeypatch.setattr(persist.requests, "get", refuse)


def test_row_maps_openapi_runs_shape(no_network):
    row = persist.row_from_record(RECORD, git_sha="abc123", posting_ids=[9378])

    assert row["run_id"] == "20260926-120000-000001"
    assert row["source"] == "scenario"
    assert row["tape_label"] == "tiny: calm, storm, missing signal"
    assert row["git_sha"] == "abc123"
    assert row["ercot_posting_ids"] == [9378]
    assert row["result"] == RECORD["ticks"]
    assert row["summary"]["tick"] == 3
    assert row["summary"]["delivered_mw"] == 0.185
    assert row["summary"]["tick_count"] == 2
    assert "created_at" not in row


def test_missing_source_is_fixture(no_network):
    row = persist.row_from_record({"run_id": "layout-fixture", "ticks": [LAST]})

    assert row["source"] == "fixture"
    assert row["tape_label"] == "layout-fixture"
    assert row["result"] == [LAST]


def test_live_synthetic_tape_label(no_network):
    row = persist.row_from_record({
        "run_id": "live-1", "tape": "synthetic", "source": "live", "ticks": [LAST],
    })

    assert (row["source"], row["tape_label"]) == ("live", "synthetic")


def test_posting_refs_come_from_tape_fixtures(no_network):
    refs = persist.posting_refs(RECORD)

    assert ("NP3-233-CD", "2026-09-25T12:00:47-05:00") in refs
    # The synthetic spike is a hand-edit of the same posting time; keep one id per posting.
    assert [posted for report, posted in refs if report == "NP3-233-CD"].count(
        "2026-09-25T12:00:47-05:00") == 1


def test_missing_config_skips_without_sending(tmp_path, monkeypatch, capsys, no_network):
    monkeypatch.setattr(persist, "ENV_PATH", tmp_path / "missing.env")
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)
    (tmp_path / "latest.json").write_text(json.dumps(RECORD))

    assert persist.main([str(tmp_path / "latest.json")]) == 0
    assert capsys.readouterr().out == "runs_skipped: no_config\n"


def test_upsert_uses_run_id_conflict_and_keeps_going_on_failure(no_network, monkeypatch):
    sent = []

    def fake_send(rows, url, key, table="ercot_postings", on_conflict="report,posted_at"):
        sent.append((table, on_conflict, url, rows[0]["run_id"], rows[0]["result"]))
        raise persist.BatchFailed("HTTP 503: down")

    monkeypatch.setattr(persist, "send", fake_send)
    monkeypatch.setattr(persist, "lookup_posting_ids", lambda refs, url, key: [9378])

    status = persist.persist_record(RECORD, url="https://example.test", key="secret", git_sha="abc")

    assert status == "skipped: HTTP 503: down"
    assert sent == [("runs", "run_id", "https://example.test", RECORD["run_id"], RECORD["ticks"])]


def test_persist_after_run_prints_status(monkeypatch, capsys, no_network):
    monkeypatch.setattr(persist, "persist_latest", lambda: "ok")

    persist.persist_after_run()

    assert capsys.readouterr().out == "runs_ok\n"


def test_engine_entry_persists_after_main_returns(monkeypatch, no_network):
    order = []
    from server.engine import __main__ as entry
    monkeypatch.setattr(entry, "main", lambda argv=None: order.append("run") or 0)
    monkeypatch.setattr(entry, "persist_after_run", lambda: order.append("persist"))

    assert entry.run_then_persist() == 0
    assert order == ["run", "persist"]
