"""Task 14B fix round 1: `state.last_seek` tells the page a seek it sent has been applied, by request seq, so the page
never waits on a landing tick or a `seeking` write it may not see between two polls (at day pace both fit inside one
250 ms poll gap). No network; the worker runs on a fake clock in a temp folder, never var/."""
import importlib.util
import json
from pathlib import Path

import pytest

from server.engine import scenario as store
from server.engine.scenario import Session, load_catalog

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("scenario_session_last_seek", ROOT / "scripts" / "scenario_session.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

SETTINGS = {
    "margin_pct": 15, "lookahead_hours": 6, "fleet_size": 100, "home_kwh": 25.0, "home_max_kw": 11.4,
    "base_reserve_pct": 30.0, "storm_reserve_pct": 60.0, "tick_minutes": 5,
    "telemetry_feed": True, "telemetry_every_s": 10.0, "stale_after_s": 180.0, "dead_after_s": 600.0,
}


class Stop(Exception):
    pass


def session(tmp_path):
    return Session(dict(SETTINGS), load_catalog(ROOT / "tapes" / "scenarios" / "catalog.json"), log_dir=tmp_path / "logs")


def test_state_reports_no_seek_before_the_first():
    s = Session(dict(SETTINGS), load_catalog(ROOT / "tapes" / "scenarios" / "catalog.json"))
    assert s.state()["last_seek"] is None


def test_a_moving_seek_records_where_it_landed_and_its_request_seq(tmp_path):
    s = session(tmp_path)
    s.start("operator-hold", 1)
    for _ in range(5):
        s.step()
    s.apply({"seq": 41, "kind": "seek", "body": {"tick": 2}})
    assert s.state()["last_seek"] == {"to": 2, "seq": 41}
    s.apply({"seq": 42, "kind": "seek", "body": {"tick": 9}})
    assert s.state()["last_seek"] == {"to": 9, "seq": 42}


def test_a_no_op_or_refused_seek_is_answered_too_so_the_page_never_waits_on_it(tmp_path):
    s = session(tmp_path)
    s.start("operator-hold", 1)
    s.step()
    s.apply({"seq": 7, "kind": "seek", "body": {"tick": 1}})
    assert s.state()["last_seek"] == {"to": 1, "seq": 7}
    s.apply({"seq": 8, "kind": "seek", "body": {"tick": "x"}})
    assert s.state()["last_seek"] == {"to": 1, "seq": 8}
    assert "refused seek" in s.messages[-1]["text"]


def run_worker(tmp_path, script, until, speed=None):
    now = [0.0]
    pending = sorted(script.items())
    written = []

    def sleep(dt):
        while pending and pending[0][0] <= now[0]:
            for kind, body in pending.pop(0)[1]:
                store.append_request(kind, body, "op-test", tmp_path)
        if now[0] >= until:
            raise Stop
        now[0] += max(min(dt, 0.01), 1e-6)

    def write(state, scenario_dir):
        written.append((now[0], json.loads(json.dumps(state))))
        store.write_state(state, scenario_dir)

    if speed is not None:
        store.append_request("speed", {"x": speed}, "op-test", tmp_path)
    original = worker.write_state
    worker.write_state = write
    try:
        with pytest.raises(Stop):
            worker.run(scenario_dir=tmp_path, scenario="operator-hold", seed=3, settings=dict(SETTINGS),
                       clock=lambda: now[0], sleep=sleep, ignore_old_requests=False)
    finally:
        worker.write_state = original
    return written


def test_worker_answers_the_seek_by_seq_even_when_the_landing_tick_is_gone_by_the_next_poll(tmp_path):
    # At 1 min per day a tick lasts 0.21 s. A page polling every 250 ms can miss both the seeking write and tick N;
    # last_seek still says the seek it sent (seq 2: speed was seq 1) was applied, and where it landed.
    written = run_worker(tmp_path, {2.0: [("seek", {"tick": 3})]}, until=2.6, speed=1440)
    after = [s for t, s in written if t > 2.0 and not s.get("seeking")]
    assert after and after[0]["last_seek"] == {"to": 3, "seq": 2}
    # By the end the run has played on past the landing tick; the answer is still there.
    assert written[-1][1]["tick_index"] > 3
    assert written[-1][1]["last_seek"] == {"to": 3, "seq": 2}


def test_worker_answers_only_the_last_of_several_seeks_in_one_poll(tmp_path):
    written = run_worker(tmp_path, {1.0: [("seek", {"tick": 1}), ("seek", {"tick": 2})]}, until=1.2)
    assert written[-1][1]["last_seek"] == {"to": 2, "seq": 2}
