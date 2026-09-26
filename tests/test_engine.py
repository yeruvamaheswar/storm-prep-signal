"""End-to-end runs of the tick loop: a 3-frame tape, and --live with a faked failed fetch."""
import json
from pathlib import Path

import requests

from server.engine.loop import run

ROOT = Path(__file__).parent.parent
TAPE = ROOT / "tests" / "fixtures" / "tape_tiny.json"
# Example simulation settings, not Base specs.
SETTINGS = {"margin_pct": 15, "lookahead_hours": 6, "fleet_size": 100, "home_kwh": 20,
            "home_max_kw": 5, "base_reserve_pct": 30, "storm_reserve_pct": 60, "tick_minutes": 5}


def test_tiny_tape_calm_then_storm_then_missing_signal(tmp_path, monkeypatch):
    # The tape's risk_fixture paths are relative to the repo root.
    monkeypatch.chdir(ROOT)
    record = run(TAPE, SETTINGS, log_dir=tmp_path / "logs", runs_dir=tmp_path / "runs")
    assert record["source"] == "scenario"
    ticks = record["ticks"]
    assert [t["tick"] for t in ticks] == [1, 2, 3]
    assert [t["reserve_pct"] for t in ticks] == [30, 60, 60]
    assert [t["policy_reason"] for t in ticks] == ["normal", "storm_risk_high", "signal_unavailable"]
    assert all(t["breaches"] == 0 for t in ticks)
    saved = json.loads((tmp_path / "runs" / f"{record['run_id']}.json").read_text())
    assert len(saved["ticks"]) == 3
    assert saved == json.loads((tmp_path / "runs" / "latest.json").read_text())


def test_live_with_failed_fetch_keeps_the_storm_floor_on_every_tick(tmp_path, monkeypatch):
    for name in ("ERCOT_USERNAME", "ERCOT_PASSWORD", "ERCOT_SUBSCRIPTION_KEY"):
        monkeypatch.setenv(name, "fake")
    calls = []

    def timeout(url, **kwargs):
        calls.append(url)
        raise requests.Timeout("read timed out")

    monkeypatch.setattr(requests, "post", timeout)
    settings = {**SETTINGS, "fetch_timeout_s": 3, "stale_after_min": 90}
    record = run(None, settings, log_dir=tmp_path / "logs", runs_dir=tmp_path / "runs", live=True)
    assert len(calls) == 1
    assert (record["source"], record["tape"]) == ("live", "synthetic")
    ticks = record["ticks"]
    assert len(ticks) == 12
    assert all(t["reserve_pct"] == 60 for t in ticks)
    assert all(t["policy_reason"] == "signal_unavailable" for t in ticks)
    assert all((t["target_mw"], t["target_label"]) == (0.2, "synthetic") for t in ticks)
    [log_file] = (tmp_path / "logs").glob("*.jsonl")
    events = [json.loads(line) for line in log_file.read_text().splitlines()]
    [failed] = [e for e in events if e["stage"] == "compute_risk"]
    assert (failed["event"], failed["ok"]) == ("failed", False)
    assert failed["reason"] == "ERCOT did not answer within 3 s"
