"""latest.json and tick_orders.json are replaced whole: the API never reads a half-written file."""
import json
import os
from pathlib import Path

import pytest

import server.engine.loop as loop

ROOT = Path(__file__).resolve().parent.parent
ZONES = {"Houston": "48201", "North": "48113", "South": "48355", "West": "48329"}
SETTINGS = {"margin_pct": 15, "lookahead_hours": 6, "fleet_size": 20, "home_kwh": 20.0,
            "home_max_kw": 5.0, "home_start_soc_min_pct": 45.0, "home_start_soc_max_pct": 75.0,
            "base_reserve_pct": 30.0, "storm_reserve_pct": 60.0, "tick_minutes": 5, "zones": ZONES}


def spy_replace(monkeypatch):
    """Record every os.replace the loop makes as (temp folder, final path), then do it."""
    replaced = []
    real = os.replace

    def spy(src, dst):
        replaced.append((str(Path(src).parent), str(dst)))
        real(src, dst)

    monkeypatch.setattr(loop.os, "replace", spy)
    return replaced


def test_write_run_files_replaces_latest_atomically(tmp_path, monkeypatch):
    replaced = spy_replace(monkeypatch)
    loop.write_run_files(tmp_path, "run-1", {"ticks": [1]})
    assert json.loads((tmp_path / "latest.json").read_text()) == {"ticks": [1]}
    # The temp file sits in the same folder, so os.replace is a same-disk rename.
    assert (str(tmp_path), str(tmp_path / "latest.json")) in replaced
    assert sorted(p.name for p in tmp_path.iterdir()) == ["latest.json", "run-1.json"]


def test_a_failed_replace_keeps_the_old_latest_and_leaves_no_temp(tmp_path, monkeypatch):
    (tmp_path / "latest.json").write_text('{"old": true}')

    def broken(src, dst):
        raise OSError("disk full")

    monkeypatch.setattr(loop.os, "replace", broken)
    with pytest.raises(OSError):
        loop.write_run_files(tmp_path, "run-2", {"new": True})
    assert json.loads((tmp_path / "latest.json").read_text()) == {"old": True}
    assert not [p for p in tmp_path.iterdir() if p.name not in ("latest.json", "run-2.json")]


def test_a_tick_writes_its_orders_atomically(tmp_path, monkeypatch):
    monkeypatch.chdir(ROOT)
    replaced = spy_replace(monkeypatch)
    tape = tmp_path / "orders.json"
    tape.write_text(json.dumps({"label": "orders", "frames": [
        {"tick": 1, "ts": "2026-09-25T12:00:00-05:00", "target_mw": 0.05, "target_label": "synthetic",
         "price_usd_mwh": 35.0, "price_label": "synthetic", "events": {}},
    ]}))
    loop.run(str(tape), SETTINGS, log_dir=tmp_path / "logs", runs_dir=tmp_path / "runs")
    finals = [Path(dst).name for _, dst in replaced]
    assert "tick_orders.json" in finals
    assert "latest.json" in finals
    assert json.loads((tmp_path / "fleet" / "tick_orders.json").read_text())["tick"] == 1
