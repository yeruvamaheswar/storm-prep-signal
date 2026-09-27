"""Task 14B fix round 2: a relative seek. `{delta: n}` is resolved against the worker's LIVE tick index when it is
applied, so a key step sent while playing at day pace (0.21 s per tick, polled every 250 ms) never lands behind the
worker and never rebuilds the run from the seed. No network; the worker runs on a fake clock in a temp folder."""
import importlib.util
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server.api.fixtures import FixtureStore
from server.app import create_app
from server.engine import scenario as store
from server.engine.scenario import Session, load_catalog

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("scenario_session_seek_delta", ROOT / "scripts" / "scenario_session.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

OPERATOR = {"X-Operator-Id": "op-test"}
SETTINGS = {
    "margin_pct": 15, "lookahead_hours": 6, "fleet_size": 100, "home_kwh": 25.0, "home_max_kw": 11.4,
    "base_reserve_pct": 30.0, "storm_reserve_pct": 60.0, "tick_minutes": 5,
    "telemetry_feed": True, "telemetry_every_s": 10.0, "stale_after_s": 180.0, "dead_after_s": 600.0,
}


class Stop(Exception):
    pass


def session(tmp_path):
    return Session(dict(SETTINGS), load_catalog(ROOT / "tapes" / "scenarios" / "catalog.json"), log_dir=tmp_path / "logs")


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.delenv("CONSOLE_SCENE", raising=False)
    monkeypatch.setattr(store, "SCENARIO_DIR", tmp_path)
    return TestClient(create_app(FixtureStore()))


# --- the route ---

def test_seek_route_records_a_delta_for_the_worker(client, tmp_path):
    reply = client.post("/v1/scenario/seek", json={"delta": -1}, headers=OPERATOR)
    assert reply.status_code == 202
    requests = json.loads((tmp_path / "requests.json").read_text())
    assert [(r["kind"], r["body"]) for r in requests] == [("seek", {"delta": -1})]


def test_seek_route_takes_exactly_one_of_tick_and_delta_as_a_whole_number(client, tmp_path):
    for bad in ({}, {"tick": 3, "delta": 1}, {"delta": 1.5}, {"delta": "2"}, {"delta": True}, {"delta": None}):
        assert client.post("/v1/scenario/seek", json=bad, headers=OPERATOR).status_code == 422, bad
    assert not (tmp_path / "requests.json").exists()


# --- the session ---

def test_a_delta_is_resolved_against_the_live_index_when_applied(tmp_path):
    s = session(tmp_path)
    s.start("operator-hold", 1)
    for _ in range(10):
        s.step()
    s.apply({"seq": 5, "kind": "seek", "body": {"delta": 1}})
    assert s.index == 11 and s.state()["last_seek"] == {"to": 11, "seq": 5}
    s.apply({"seq": 6, "kind": "seek", "body": {"delta": -3}})
    assert s.index == 8 and s.state()["last_seek"] == {"to": 8, "seq": 6}
    assert s.playing is True


def test_a_delta_clamps_to_the_tape_like_a_tick(tmp_path):
    s = session(tmp_path)
    s.start("operator-hold", 1)
    s.step()
    s.apply({"seq": 1, "kind": "seek", "body": {"delta": -100}})
    assert s.index == 0
    s.apply({"seq": 2, "kind": "seek", "body": {"delta": 10_000}})
    assert s.index == len(s.frames) - 1


def test_a_forward_delta_on_a_finished_run_never_turns_into_a_step_back(tmp_path):
    s = session(tmp_path)
    s.start("operator-hold", 1)
    while s.index < len(s.frames):
        s.step()
    history = s.history
    s.apply({"seq": 9, "kind": "seek", "body": {"delta": 1}})
    assert s.index == len(s.frames) and s.history is history
    assert s.state()["last_seek"] == {"to": len(s.frames), "seq": 9}
    s.apply({"seq": 10, "kind": "seek", "body": {"delta": -1}})
    assert s.index == len(s.frames) - 1


def test_a_bad_delta_is_refused_on_the_page_and_still_answered(tmp_path):
    s = session(tmp_path)
    s.start("operator-hold", 1)
    s.step()
    for seq, bad in enumerate((1.5, "2", None, True), start=1):
        s.apply({"seq": seq, "kind": "seek", "body": {"delta": bad}})
        assert "refused seek" in s.messages[-1]["text"]
        assert s.index == 1 and s.state()["last_seek"] == {"to": 1, "seq": seq}


# --- the worker ---

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


def test_a_forward_step_while_playing_at_day_pace_lands_one_past_the_live_tick_and_never_rewinds(tmp_path):
    # 1 min per day: 0.21 s per tick. By 2 s the worker is near tick 10; the page's poll may be a tick or two behind,
    # but a delta cannot be behind the worker: it lands one past wherever the worker is when it applies it.
    written = run_worker(tmp_path, {2.0: [("seek", {"delta": 1})]}, until=2.1, speed=1440)
    seeking = [s for t, s in written if s.get("seeking")]
    assert len(seeking) == 1
    live = seeking[0]["tick_index"]
    after = [s for t, s in written if t > 2.0 and not s.get("seeking")]
    assert after[0]["last_seek"] == {"to": live + 1, "seq": 2}
    assert after[0]["tick_index"] == live + 1
    # Every state written from the seek on is at or past the live tick: no rebuild from the seed.
    assert min(s["tick_index"] for t, s in written if t >= 2.0) >= live


def test_two_deltas_in_one_poll_add_up(tmp_path):
    # 12x: 25 s per tick. Ticks 1 and 2 play at 0 s and 25 s; at 30 s two Back-one-tick presses land on tick 0.
    written = run_worker(tmp_path, {30.0: [("seek", {"delta": -1}), ("seek", {"delta": -1})]}, until=31.0)
    last = written[-1][1]
    assert last["tick_index"] == 0
    assert last["last_seek"] == {"to": 0, "seq": 2}


def test_a_delta_after_a_tick_in_one_poll_counts_from_that_tick(tmp_path):
    written = run_worker(tmp_path, {30.0: [("seek", {"tick": 1}), ("seek", {"delta": 1})]}, until=31.0)
    assert written[-1][1]["tick_index"] == 2
    assert written[-1][1]["last_seek"] == {"to": 2, "seq": 2}


def test_a_tick_after_a_delta_in_one_poll_still_replaces_it(tmp_path):
    written = run_worker(tmp_path, {30.0: [("seek", {"delta": -2}), ("seek", {"tick": 1})]}, until=31.0)
    assert len([s for t, s in written if s.get("seeking")]) == 1
    assert written[-1][1]["tick_index"] == 1
