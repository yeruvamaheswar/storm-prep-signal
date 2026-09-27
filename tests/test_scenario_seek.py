"""Rewind and fast-forward (Task 16A): seek re-runs the engine with the same seed and the operator's actions at
their logged ticks, so every tick on screen stays a real engine tick."""
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
spec = importlib.util.spec_from_file_location("scenario_session_seek", ROOT / "scripts" / "scenario_session.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

OPERATOR = {"X-Operator-Id": "op-test"}
SETTINGS = {
    "margin_pct": 15, "lookahead_hours": 6, "fleet_size": 100, "home_kwh": 25.0, "home_max_kw": 11.4,
    "base_reserve_pct": 30.0, "storm_reserve_pct": 60.0, "tick_minutes": 5,
    # The feed is on in the real worker (TELEMETRY_FEED defaults to on), so determinism is tested with it.
    "telemetry_feed": True, "telemetry_every_s": 10.0, "stale_after_s": 180.0, "dead_after_s": 600.0,
}
BERYL_ALERT = "beryl-harris-tropical-storm-warning"
# Fields that are wall-clock or process facts, not engine output.
VOLATILE = ("updated_at", "pid", "log")


class Stop(Exception):
    pass


def session(tmp_path, **over):
    return Session({**SETTINGS, **over}, load_catalog(ROOT / "tapes" / "scenarios" / "catalog.json"),
                   log_dir=tmp_path / "logs")


def snapshot(s):
    """Everything the page reads about the current tick, minus clock facts and the action log (kept by a seek)."""
    state = s.state()
    for key in VOLATILE + ("actions", "seeking"):
        state.pop(key, None)
    return json.loads(json.dumps(state))


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.delenv("CONSOLE_SCENE", raising=False)
    monkeypatch.setattr(store, "SCENARIO_DIR", tmp_path)
    return TestClient(create_app(FixtureStore()))


# --- the request and the route ---

def test_seek_is_a_request_kind():
    assert "seek" in store.REQUEST_KINDS


def test_seek_route_records_the_tick_for_the_worker(client, tmp_path):
    reply = client.post("/v1/scenario/seek", json={"tick": 20}, headers=OPERATOR)
    assert reply.status_code == 202
    assert reply.json() == {"accepted": 1, "kind": "seek"}
    requests = json.loads((tmp_path / "requests.json").read_text())
    assert [(r["kind"], r["body"], r["operator"]) for r in requests] == [("seek", {"tick": 20}, "op-test")]
    # Nothing ran: the route only records.
    assert not (tmp_path / "state.json").exists()


def test_seek_route_needs_an_operator_and_a_whole_tick(client, tmp_path):
    assert client.post("/v1/scenario/seek", json={"tick": 20}).status_code in (401, 403)
    for bad in (2.5, "x", None, True):
        assert client.post("/v1/scenario/seek", json={"tick": bad}, headers=OPERATOR).status_code == 422
    assert not (tmp_path / "requests.json").exists()


# --- the session ---

def test_seek_clamps_to_the_tape(tmp_path):
    s = session(tmp_path)
    s.start("operator-hold", 1)
    s.seek(-5)
    assert s.index == 0 and s.history == []
    s.seek(10_000)
    assert s.index == len(s.frames) - 1
    assert s.history[-1]["tick"] == s.frames[-2].tick


def test_a_bad_seek_is_logged_on_the_page_and_never_raised(tmp_path):
    s = session(tmp_path)
    s.apply({"kind": "seek", "body": {"tick": 3}})
    assert "refused seek" in s.messages[-1]["text"]
    s.start("operator-hold", 1)
    for bad in (2.5, "7", None, True):
        s.apply({"kind": "seek", "body": {"tick": bad}})
        assert "refused seek" in s.messages[-1]["text"]
        assert s.index == 0


def test_seek_to_the_current_tick_does_nothing(tmp_path):
    s = session(tmp_path)
    s.start("operator-hold", 1)
    for _ in range(5):
        s.step()
    last, history = s.last, s.history
    s.seek(5)
    assert s.last is last and s.history is history


def test_seek_keeps_the_seed_and_leaves_playing_alone(tmp_path):
    s = session(tmp_path)
    s.start("operator-hold", 7)
    for _ in range(10):
        s.step()
    s.seek(3)
    assert s.seed == 7 and s.playing is True and s.index == 3
    s.set_playing(False)
    s.seek(8)
    assert s.seed == 7 and s.playing is False and s.index == 8


def test_state_reports_the_action_log_and_not_seeking(tmp_path):
    s = session(tmp_path)
    assert s.state()["actions"] == [] and s.state()["seeking"] is False
    s.start("beryl-landfall", 42)
    for _ in range(10):
        s.step()
    s.send_alert(BERYL_ALERT)
    for _ in range(5):
        s.step()
    s.set_grid_down("Houston", True)
    actions = s.state()["actions"]
    assert [(a["kind"], a["index"], a["tick"]) for a in actions] == [("alert", 10, 11), ("grid_down", 15, 16)]
    assert actions[0]["alert_id"] == BERYL_ALERT
    assert (actions[1]["zone"], actions[1]["down"]) == ("Houston", True)


def test_start_and_reset_clear_the_action_log_and_seek_keeps_it(tmp_path):
    s = session(tmp_path)
    s.start("beryl-landfall", 42)
    s.step()
    s.send_alert(BERYL_ALERT)
    s.step()
    s.seek(0)
    assert len(s.actions) == 1
    s.reset(42)
    assert s.actions == []
    s.step()
    s.send_alert(BERYL_ALERT)
    s.start("beryl-landfall", 42)
    assert s.actions == []


def test_operator_hold_mode_comes_from_the_tape_not_the_action_log(tmp_path):
    s = session(tmp_path)
    s.start("operator-hold", 1)
    for _ in range(22):
        s.step()
    assert s.actions == []
    s.seek(10)
    assert s.mode == "HOLD" and s.history[-1]["mode"] == "HOLD"


def test_rewinding_before_an_alert_removes_it_and_playing_on_sends_it_again_at_its_tick(tmp_path):
    s = session(tmp_path)
    s.start("beryl-landfall", 42)
    for _ in range(10):
        s.step()
    s.send_alert(BERYL_ALERT)
    for _ in range(20):
        s.step()
    sent_at = s.active_alerts[0]["sent_at_tick"]
    s.seek(5)
    # History and alerts are rebuilt by the re-run: nothing past tick 5 is left.
    assert s.active_alerts == [] and s.history[-1]["tick"] == s.frames[4].tick
    assert all(point["events"] == [] for point in s.history)
    for _ in range(4):
        s.step()
    assert s.index == 9 and s.active_alerts == []
    # Reaching index 10 sends it again, exactly where the operator sent it; it applies from the next tick.
    s.step()
    assert [a["sent_at_tick"] for a in s.active_alerts] == [sent_at]
    assert s.history[-1]["events"] == []
    s.step()
    assert s.history[-1]["events"] == ["weather_counties"]
    # The replayed alert is not logged a second time.
    assert len(s.actions) == 1


def test_an_alert_sent_again_earlier_replaces_its_later_log_entry(tmp_path):
    s = session(tmp_path)
    s.start("beryl-landfall", 42)
    for _ in range(10):
        s.step()
    s.send_alert(BERYL_ALERT)
    s.step()
    s.seek(4)
    s.send_alert(BERYL_ALERT)
    assert [(a["kind"], a["index"]) for a in s.actions] == [("alert", 4)]
    for _ in range(10):
        s.step()
    assert not any("refused" in m["text"] or "already" in m["text"] for m in s.messages)


# --- determinism: a seek reproduces every tick exactly ---

def play_recording(s, until, actions):
    """Play to `until`, applying {index: callable} operator actions, and snapshot every index."""
    snaps = {0: snapshot(s)}
    while s.index < until:
        if s.index in actions:
            actions[s.index](s)
            snaps[s.index] = snapshot(s)
        s.step()
        snaps[s.index] = snapshot(s)
    return snaps


def differences(a, b, path=""):
    if isinstance(a, dict) and isinstance(b, dict):
        out = []
        for key in sorted(set(a) | set(b)):
            out += differences(a.get(key, "<missing>"), b.get(key, "<missing>"), f"{path}.{key}")
        return out
    if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        out = []
        for k, (x, y) in enumerate(zip(a, b)):
            out += differences(x, y, f"{path}[{k}]")
        return out
    return [] if a == b else [f"{path}: {json.dumps(a)[:80]} != {json.dumps(b)[:80]}"]


CASES = {
    "alert at tick 10": ("beryl-landfall", 42, {10: lambda s: s.send_alert(BERYL_ALERT)}),
    "grid down at tick 15": ("beryl-landfall", 42, {15: lambda s: s.set_grid_down("Houston", True)}),
    "faults": ("faults", 1, {}),
}


@pytest.mark.parametrize("case", sorted(CASES))
def test_seek_reproduces_every_tick_exactly(tmp_path, case):
    scenario, seed, actions = CASES[case]
    s = session(tmp_path)
    s.start(scenario, seed)
    first = play_recording(s, 60, actions)

    s.seek(20)
    assert differences(first[20], snapshot(s)) == []
    s.seek(60)
    assert differences(first[60], snapshot(s)) == []

    # Every tick in between, stepping on from a rewind to 0: the logged actions come back at their ticks.
    s.seek(0)
    assert differences(first[0], snapshot(s)) == []
    while s.index < 60:
        s.step()
        assert differences(first[s.index], snapshot(s)) == [], s.index


# --- the worker ---

def run_worker(tmp_path, script, clock_step=0.05, until=30.0, scenario="operator-hold", seed=3):
    """Run the worker on a fake clock. `script` maps a fake time to requests to append then. Returns every state
    written, with the fake time it was written at."""
    now = [0.0]
    pending = sorted(script.items())
    written = []

    def sleep(dt):
        while pending and pending[0][0] <= now[0]:
            for kind, body in pending.pop(0)[1]:
                store.append_request(kind, body, "op-test", tmp_path)
        if now[0] >= until:
            raise Stop
        now[0] += max(min(dt, clock_step), 1e-6)

    def write(state, scenario_dir):
        written.append((now[0], json.loads(json.dumps(state))))
        store.write_state(state, scenario_dir)

    original = worker.write_state
    worker.write_state = write
    try:
        with pytest.raises(Stop):
            worker.run(scenario_dir=tmp_path, scenario=scenario, seed=seed, settings=dict(SETTINGS),
                       clock=lambda: now[0], sleep=sleep, ignore_old_requests=False)
    finally:
        worker.write_state = original
    return written


def test_worker_says_seeking_before_a_seek_then_writes_the_new_tick(tmp_path):
    # 12x: 25 s per tick. Ticks 1 and 2 play at 0 s and 25 s; the seek to 1 lands at 30 s.
    written = run_worker(tmp_path, {30.0: [("seek", {"tick": 1})]}, until=31.0)
    seeking = [(t, s) for t, s in written if s.get("seeking")]
    assert len(seeking) == 1
    t, state = seeking[0]
    assert t == pytest.approx(30.0, abs=0.1) and state["tick_index"] == 2
    after = [s for at, s in written if at >= t and not s.get("seeking")]
    assert after and after[0]["seeking"] is False


def first_seen_after(written, since):
    """The fake time each tick index was first written (not a seeking state) after `since`. A request appended at
    `since` is read on the next loop, so a heartbeat written at exactly `since` is still the old state."""
    seen = {}
    for t, state in written:
        if t > since + 0.001 and not state.get("seeking"):  # the fake clock drifts by float round-off
            seen.setdefault(state["tick_index"], t)
    return seen


def test_worker_lands_on_the_seek_tick_for_a_full_tick_window_while_playing(tmp_path):
    # Ruling (fix round 1): the page lands ON tick N. A seek at 30 s to tick 1 shows tick 1 from 30 s, and tick 2
    # plays one full window (25 s at 12x) later, at 55 s.
    written = run_worker(tmp_path, {30.0: [("seek", {"tick": 1})]}, until=60.0)
    seen = first_seen_after(written, 30.0)
    assert seen[1] == pytest.approx(30.0, abs=0.1)
    assert seen[2] == pytest.approx(55.0, abs=0.1)
    assert [s["tick_left_s"] for t, s in written if t == seen[1] and s["tick_index"] == 1][-1] == pytest.approx(25.0, abs=0.1)


def test_a_no_op_or_refused_seek_does_not_cut_the_current_tick_short(tmp_path):
    # Tick 2 played at 25 s and tick 3 is due at 50 s. A seek to the current tick (2) and a refused seek change
    # nothing, so tick 3 still plays at 50 s.
    written = run_worker(tmp_path, {30.0: [("seek", {"tick": 2})], 35.0: [("seek", {"tick": "x"})]}, until=52.0)
    seen = first_seen_after(written, 30.0)
    assert seen[2] == pytest.approx(30.0, abs=0.1)
    assert seen[3] == pytest.approx(50.0, abs=0.1)
    assert "refused seek" in written[-1][1]["log"][-1]["text"] or any(
        "refused seek" in line["text"] for line in written[-1][1]["log"])


def test_several_seeks_in_one_poll_run_only_the_last(tmp_path):
    written = run_worker(tmp_path, {30.0: [("seek", {"tick": 1}), ("seek", {"tick": 0}), ("seek", {"tick": 1})]},
                         until=31.0)
    assert len([s for t, s in written if s.get("seeking")]) == 1
    last = written[-1][1]
    assert last["tick_index"] == 1
    assert sum("moved to tick" in line["text"] for line in last["log"]) == 1


def test_seeks_with_only_a_speed_change_between_still_run_once(tmp_path):
    written = run_worker(tmp_path, {30.0: [("seek", {"tick": 0}), ("speed", {"x": 30}), ("seek", {"tick": 1})]},
                         until=31.0)
    assert len([s for t, s in written if s.get("seeking")]) == 1
    last = written[-1][1]
    assert last["tick_index"] == 1 and last["speed"] == 30
    assert sum("moved to tick" in line["text"] for line in last["log"]) == 1


def test_a_play_between_two_seeks_keeps_the_first_seek_so_a_finished_run_is_not_reset(tmp_path):
    # Beryl at 1 min per day (0.21 s per tick) finishes its 193 ticks by about 41 s, with the alert logged at t=1.
    # Play on a finished tape resets the run (new fleet, log cleared). In [seek 10, play, seek 20] the play must be
    # judged after seek 10, not against the finished tick, so nothing resets and the action log survives.
    written = run_worker(tmp_path, {
        0.0: [("speed", {"x": 1440})],
        1.0: [("alert", {"alert_id": BERYL_ALERT})],
        45.0: [("seek", {"tick": 10}), ("play", {"playing": True}), ("seek", {"tick": 20})],
    }, until=45.2, scenario="beryl-landfall", seed=42)
    before = [s for t, s in written if t <= 45.0][-1]
    assert before["status"] == "finished" and before["tick_index"] == 193
    assert len(before["actions"]) == 1
    assert len([s for t, s in written if s.get("seeking")]) == 2
    after = [s for t, s in written if t > 45.001 and not s.get("seeking")]
    first = after[0]
    assert first["seed"] == 42 and first["tick_index"] == 20 and first["status"] == "playing"
    assert [(a["kind"], a["index"]) for a in first["actions"]] == [(a["kind"], a["index"]) for a in before["actions"]]
    assert not any("fleet seeded" in line["text"] for line in first["log"][-3:])


def test_a_tick_that_crashes_mid_seek_stops_playback_and_says_where(tmp_path, monkeypatch):
    s = session(tmp_path)
    s.start("operator-hold", 1)
    for _ in range(10):
        s.step()
    assert s.playing is True
    real_step = Session.step
    calls = []

    def crash_on_the_fourth(self):
        calls.append(1)
        if len(calls) == 4:
            raise RuntimeError("test crash")
        return real_step(self)

    monkeypatch.setattr(Session, "step", crash_on_the_fourth)
    s.seek(5)
    assert s.playing is False
    assert s.error == "RuntimeError: test crash"
    assert s.index == 3
    text = s.messages[-1]["text"]
    assert "moved to tick" not in text
    assert "stopped at tick 3" in text and "test crash" in text


def test_a_seek_marks_the_event_log_before_the_re_run(tmp_path):
    s = session(tmp_path)
    s.start("operator-hold", 1)
    for _ in range(12):
        s.step()
    s.seek(4)
    events = [json.loads(line) for path in sorted((tmp_path / "logs").glob("*.jsonl"))
              for line in path.read_text().splitlines()]
    marks = [e for e in events if e["event"] == "seek"]
    assert len(marks) == 1
    assert marks[0]["stage"] == "scenario" and marks[0]["data"] == {"from": 12, "to": 4}
    # A tape run writes no per-tick events today (only live fetches log), so the marker is the only line; any event
    # a later tick writes lands after it.
    assert events[-1] == marks[0]


def test_worker_clears_a_paused_tick_after_a_seek(tmp_path):
    # Paused 10 s into tick 2 (15 s kept); a seek drops the frozen remainder.
    written = run_worker(tmp_path, {35.0: [("play", {"playing": False})], 40.0: [("seek", {"tick": 1})]}, until=42.0)
    paused = [s for t, s in written if 36.0 <= t < 40.0]
    assert paused and paused[-1]["tick_left_s"] == pytest.approx(15.0, abs=0.1)
    last = written[-1][1]
    assert last["tick_index"] == 1 and last["status"] == "paused" and last["tick_left_s"] is None


def test_worker_restarts_the_tick_window_on_start_even_at_tick_zero(tmp_path, monkeypatch):
    # The known edge: the old run's first tick crashed, so it sits at tick 0 with its next tick due at 25 s. A start
    # at 7 s does not move the index (0 to 0), and it must still play the new run's first tick now, not at 25 s.
    real_step = Session.step
    crashed = []

    def step_once_crashing(self):
        if not crashed:
            crashed.append(True)
            raise RuntimeError("test crash")
        return real_step(self)

    monkeypatch.setattr(Session, "step", step_once_crashing)
    written = run_worker(tmp_path, {7.0: [("start", {"scenario": "faults", "seed": 1})]}, until=8.0)
    assert written[0][1]["tick_index"] == 0 and written[0][1]["status"] == "error"
    started = [(t, s) for t, s in written if s["scenario"] and s["scenario"]["id"] == "faults" and s["tick_index"] == 1]
    assert started and started[0][0] == pytest.approx(7.0, abs=0.1)
