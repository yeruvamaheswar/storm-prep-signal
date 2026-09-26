"""Live stream rollups and per-cycle latest.json. No 10k-home payloads."""

import json

from server.api.v1 import feeds_event, home_rollup
from server.engine.loop import write_run_files


def test_home_rollup_uses_fleet_counts_not_home_ids():
    tick = {
        "fleet": {"live": 70, "stale": 10, "dead": 18, "unconfirmed": 2, "breaches": 0},
        "home_id": "should-not-copy",
    }
    rollup = home_rollup(tick)
    assert rollup == {"live": 70, "stale": 10, "dead": 18, "unconfirmed": 2, "breaches": 0}
    assert "home_id" not in rollup


def test_home_rollup_reads_tickview_counts():
    assert home_rollup({"live_homes": 100, "stale_homes": 1, "dead_homes": 2, "breaches": 0}) == {
        "live": 100,
        "stale": 1,
        "dead": 2,
        "unconfirmed": 0,
        "breaches": 0,
    }


def test_feeds_event_carries_quality_and_as_of():
    assert feeds_event({"quality": "stale", "as_of": "23:00 CT", "feed": "LIVE"}) == {
        "quality": "stale",
        "as_of": "23:00 CT",
        "feed": "LIVE",
        "rows": [],
    }


def test_write_run_files_updates_latest_each_cycle(tmp_path):
    first = {"run_id": "r1", "ticks": [{"tick": 1}]}
    write_run_files(tmp_path, "r1", first)
    second = {"run_id": "r1", "ticks": [{"tick": 1}, {"tick": 2}]}
    write_run_files(tmp_path, "r1", second)
    latest = json.loads((tmp_path / "latest.json").read_text(encoding="utf-8"))
    assert latest["ticks"][-1]["tick"] == 2
    assert json.loads((tmp_path / "r1.json").read_text(encoding="utf-8")) == latest