"""End-to-end run of the tick loop on a 3-frame tape."""
import json
from pathlib import Path

from storm_prep.engine import run

ROOT = Path(__file__).parent.parent
TAPE = ROOT / "tests" / "fixtures" / "tape_tiny.json"
# Example simulation settings, not Base specs.
SETTINGS = {"margin_pct": 15, "lookahead_hours": 6, "fleet_size": 100, "home_kwh": 20,
            "home_max_kw": 5, "base_reserve_pct": 30, "storm_reserve_pct": 60, "tick_minutes": 5}


def test_tiny_tape_calm_then_storm_then_missing_signal(tmp_path, monkeypatch):
    # The tape's risk_fixture paths are relative to the repo root.
    monkeypatch.chdir(ROOT)
    record = run(TAPE, SETTINGS, log_dir=tmp_path / "logs", runs_dir=tmp_path / "runs")
    ticks = record["ticks"]
    assert [t["tick"] for t in ticks] == [1, 2, 3]
    assert [t["reserve_pct"] for t in ticks] == [30, 60, 60]
    assert [t["policy_reason"] for t in ticks] == ["normal", "storm_risk_high", "signal_unavailable"]
    assert all(t["breaches"] == 0 for t in ticks)
    saved = json.loads((tmp_path / "runs" / f"{record['run_id']}.json").read_text())
    assert len(saved["ticks"]) == 3
    assert saved == json.loads((tmp_path / "runs" / "latest.json").read_text())
