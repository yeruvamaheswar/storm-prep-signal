"""Replay playback pace: slower speeds down to real time, one-tick steps, and speed changes mid-tick."""
import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server.api.fixtures import FixtureStore
from server.app import create_app
from server.engine import scenario as store
from server.engine.scenario import Session, load_catalog

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("scenario_session_playback", ROOT / "scripts" / "scenario_session.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

OPERATOR = {"X-Operator-Id": "op-test"}
SETTINGS = {
    "margin_pct": 15, "lookahead_hours": 6, "fleet_size": 100, "home_kwh": 25.0, "home_max_kw": 11.4,
    "base_reserve_pct": 30.0, "storm_reserve_pct": 60.0, "tick_minutes": 5, "telemetry_feed": False,
}


def session(tmp_path):
    return Session(dict(SETTINGS), load_catalog(ROOT / "tapes" / "scenarios" / "catalog.json"),
                   log_dir=tmp_path / "logs")


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.delenv("CONSOLE_SCENE", raising=False)
    monkeypatch.setattr(store, "SCENARIO_DIR", tmp_path)
    return TestClient(create_app(FixtureStore()))


def write_live_state(tmp_path, status):
    store.write_state({"status": status, "updated_at": datetime.now(timezone.utc).isoformat()}, tmp_path)


# --- speeds ---

def test_slow_speeds_are_added_and_the_old_ones_kept():
    assert {2.4, 4.8, 12} <= set(store.SPEEDS)
    assert {15, 30, 60, 150, 300, 600} <= set(store.SPEEDS)
    assert list(store.SPEEDS) == sorted(store.SPEEDS)


def test_default_speed_is_about_25_seconds_per_tick(tmp_path):
    assert store.DEFAULT_SPEED == 12
    s = session(tmp_path)
    assert s.speed == 12
    assert s.step_seconds() == pytest.approx(25.0)


def test_real_time_plays_the_125_second_order_window_at_true_speed(tmp_path):
    s = session(tmp_path)
    s.set_speed(2.4)
    assert s.step_seconds() == pytest.approx(125.0)


def test_session_refuses_a_speed_it_does_not_offer(tmp_path):
    s = session(tmp_path)
    with pytest.raises(ValueError):
        s.set_speed(7)


def test_speed_route_accepts_non_integer_speeds(client, tmp_path):
    for x in (2.4, 4.8, 12, 300):
        assert client.post("/v1/scenario/speed", json={"x": x}, headers=OPERATOR).status_code == 202
    requests = json.loads((tmp_path / "requests.json").read_text())
    assert [request["body"]["x"] for request in requests] == [2.4, 4.8, 12, 300]


def test_speed_route_rejects_a_bad_speed(client, tmp_path):
    for x in (7, 2.5, 0, -12):
        reply = client.post("/v1/scenario/speed", json={"x": x}, headers=OPERATOR)
        assert reply.status_code == 422
    assert not (tmp_path / "requests.json").exists()


def test_scenarios_list_reports_the_new_speeds_and_default(client):
    reply = client.get("/v1/scenarios").json()
    assert reply["speeds"] == list(store.SPEEDS)
    assert reply["default_speed"] == 12


# --- one-tick steps ---

def test_step_plays_exactly_one_tick_and_stays_paused(tmp_path):
    s = session(tmp_path)
    s.start("heather", 7)
    s.set_playing(False)
    s.apply({"kind": "step", "body": {}})
    assert s.index == 1 and s.playing is False and s.status() == "paused"
    s.apply({"kind": "step", "body": {}})
    assert s.index == 2 and s.playing is False
    assert [p["tick"] for p in s.history] == [s.frames[0].tick, s.frames[1].tick]


def test_step_is_refused_while_playing_or_with_no_scenario(tmp_path):
    idle = session(tmp_path)
    idle.apply({"kind": "step", "body": {}})
    assert idle.index == 0 and idle.messages[-1]["text"].startswith("refused step")
    playing = session(tmp_path)
    playing.start("heather", 7)
    playing.apply({"kind": "step", "body": {}})
    assert playing.index == 0 and playing.messages[-1]["text"].startswith("refused step")


def test_step_is_refused_after_the_last_tick(tmp_path):
    s = session(tmp_path)
    s.start("heather", 7)
    while s.step():
        pass
    count = s.index
    s.apply({"kind": "step", "body": {}})
    assert s.index == count and s.messages[-1]["text"].startswith("refused step")


def test_step_is_a_request_kind():
    assert "step" in store.REQUEST_KINDS


def test_step_route_records_a_request_only_when_paused(client, tmp_path):
    assert client.post("/v1/scenario/step", json={}).status_code == 401
    # No worker, no scenario: refused, nothing recorded.
    refused = client.post("/v1/scenario/step", json={}, headers=OPERATOR)
    assert refused.status_code == 409
    write_live_state(tmp_path, "playing")
    assert client.post("/v1/scenario/step", json={}, headers=OPERATOR).status_code == 409
    write_live_state(tmp_path, "idle")
    assert client.post("/v1/scenario/step", json={}, headers=OPERATOR).status_code == 409
    assert not (tmp_path / "requests.json").exists()
    write_live_state(tmp_path, "paused")
    ok = client.post("/v1/scenario/step", json={}, headers=OPERATOR)
    assert ok.status_code == 202 and ok.json()["kind"] == "step"
    assert [r["kind"] for r in json.loads((tmp_path / "requests.json").read_text())] == ["step"]


# --- the worker loop ---

class Stop(Exception):
    pass


def drive(tmp_path, actions, until, states=None):
    """Run the worker on a fake clock ticking 0.25 s per loop; `actions` maps a time to a request.
    `states`, when given, collects {time: the whole state.json} at each loop."""
    now = [0.0]
    seen = []

    def sleep(_):
        state = json.loads((tmp_path / "state.json").read_text())
        seen.append((now[0], state["tick_index"], state["status"]))
        if states is not None:
            states[now[0]] = state
        now[0] = round(now[0] + 0.25, 2)
        for kind, body in actions.pop(now[0], []):
            store.append_request(kind, body, "op-test", tmp_path)
        if now[0] > until:
            raise Stop

    with pytest.raises(Stop):
        worker.run(scenario_dir=tmp_path, scenario="heather", seed=7, settings=dict(SETTINGS),
                   clock=lambda: now[0], sleep=sleep, ignore_old_requests=False)
    return seen


def first_time_at(seen, tick_index):
    return next(t for t, index, _ in seen if index >= tick_index)


def test_worker_waits_25_seconds_per_tick_by_default(tmp_path):
    seen = drive(tmp_path, {}, until=30)
    assert first_time_at(seen, 1) == 0.0
    assert first_time_at(seen, 2) == 25.0


def test_speed_change_mid_tick_keeps_the_progress_already_played(tmp_path):
    # Halfway through a 25 s tick, switch to 1 s per tick: the other half takes 0.5 s, not 24.5 s.
    seen = drive(tmp_path, {12.5: [("speed", {"x": 300})]}, until=14)
    assert first_time_at(seen, 2) == 13.0


def test_slowing_down_mid_tick_does_not_step_early(tmp_path):
    # Halfway through a 25 s tick, switch to real time (125 s): the other half takes 62.5 s.
    seen = drive(tmp_path, {12.5: [("speed", {"x": 2.4})]}, until=80)
    assert first_time_at(seen, 2) == 75.0


def test_worker_step_request_plays_one_tick_while_paused(tmp_path):
    seen = drive(tmp_path, {1.0: [("play", {"playing": False})], 2.0: [("step", {})]}, until=40)
    assert first_time_at(seen, 2) == 2.0
    assert max(index for _, index, _ in seen) == 2
    assert seen[-1][2] == "paused"


# --- pause and resume keep the rest of the tick ---

def test_pause_mid_tick_then_play_resumes_the_rest_of_the_tick(tmp_path):
    # Tick 2 is due at 25 s. Pause at 12.5 s for 60 s: 12.5 s are left, so tick 2 plays at 12.5 + 60 + 12.5.
    seen = drive(tmp_path, {12.5: [("play", {"playing": False})], 72.5: [("play", {"playing": True})]}, until=90)
    assert max(index for t, index, _ in seen if t < 85.0) == 1
    assert first_time_at(seen, 2) == 85.0


def test_a_short_pause_is_not_counted_as_play_time(tmp_path):
    # Pause at 10 s for 5 s: tick 2 plays at 30 s, not 25 s.
    seen = drive(tmp_path, {10.0: [("play", {"playing": False})], 15.0: [("play", {"playing": True})]}, until=35)
    assert first_time_at(seen, 2) == 30.0


def test_a_speed_change_while_paused_rescales_the_rest_of_the_tick(tmp_path):
    # Paused halfway through a 25 s tick, switch to 1 s per tick: the other half takes 0.5 s after play.
    seen = drive(tmp_path, {12.5: [("play", {"playing": False})], 20.0: [("speed", {"x": 300})],
                            30.0: [("play", {"playing": True})]}, until=35)
    assert first_time_at(seen, 2) == 30.5


def test_play_during_a_stepped_tick_lets_that_tick_finish(tmp_path):
    # Paused at 1 s, step at 2 s (tick 2), play at 10 s. The page plays the stepped tick from 2 s, so tick 3
    # waits until that tick's 25 s are up (27 s): not cut short at 10 s, and no dead wait after it either.
    seen = drive(tmp_path, {1.0: [("play", {"playing": False})], 2.0: [("step", {})],
                            10.0: [("play", {"playing": True})]}, until=40)
    assert first_time_at(seen, 2) == 2.0
    assert max(index for t, index, _ in seen if t < 27.0) == 2
    assert first_time_at(seen, 3) == 27.0


def test_play_long_after_a_step_plays_the_next_tick_at_once(tmp_path):
    # The stepped tick's 25 s ran out while paused; Play goes straight on.
    seen = drive(tmp_path, {1.0: [("play", {"playing": False})], 2.0: [("step", {})],
                            60.0: [("play", {"playing": True})]}, until=62)
    assert max(index for t, index, _ in seen if t < 60.0) == 2
    assert first_time_at(seen, 3) == 60.0


def test_reset_while_paused_mid_tick_does_not_carry_the_old_tick_over(tmp_path):
    # Paused halfway through tick 2; reset; Play starts the new run with its first tick right away.
    seen = drive(tmp_path, {12.5: [("play", {"playing": False})], 20.0: [("reset", {"seed": 7})],
                            30.0: [("play", {"playing": True})]}, until=31)
    assert {index for t, index, _ in seen if 20.0 <= t < 30.0} == {0}
    assert first_time_at([s for s in seen if s[0] >= 30.0], 1) == 30.0


def test_next_tick_and_play_in_one_poll_give_the_stepped_tick_a_fresh_step(tmp_path):
    # Paused at 12.5 s with 12.5 s left of tick 1. Next tick and Play land in one poll at 20 s: tick 2 plays
    # then, and tick 3 waits its full 25 s (45 s), not the old tick's 12.5 s left over (32.5 s).
    seen = drive(tmp_path, {12.5: [("play", {"playing": False})],
                            20.0: [("step", {}), ("play", {"playing": True})]}, until=50)
    assert first_time_at(seen, 2) == 20.0
    assert max(index for t, index, _ in seen if t < 45.0) == 2
    assert first_time_at(seen, 3) == 45.0


def test_state_publishes_the_time_left_in_the_tick(tmp_path):
    # The page anchors its playhead on this when it opens mid-tick or resumes a tick it never saw start.
    states = {}
    drive(tmp_path, {12.5: [("play", {"playing": False})], 20.0: [("step", {})]}, until=22, states=states)
    assert states[5.0]["status"] == "playing" and states[5.0]["tick_left_s"] == pytest.approx(20.0)
    # Paused: the remainder the pause kept, unchanged while paused.
    assert states[13.0]["status"] == "paused" and states[13.0]["tick_left_s"] == pytest.approx(12.5)
    assert states[19.0]["tick_left_s"] == pytest.approx(12.5)
    # After Next tick nothing is frozen: the stepped tick runs its window.
    assert states[21.0]["tick_index"] == 2 and states[21.0]["tick_left_s"] is None


def test_state_has_no_time_left_once_the_scenario_is_finished(tmp_path):
    states = {}
    # Heather has 145 ticks; at 600 (0.5 s per tick) it finishes by about 73 s.
    drive(tmp_path, {0.25: [("speed", {"x": 600})]}, until=80, states=states)
    last = states[max(states)]
    assert last["status"] == "finished" and last["tick_left_s"] is None


def test_step_route_names_a_stopped_worker_before_asking_for_a_pause(client, tmp_path):
    reply = client.post("/v1/scenario/step", json={}, headers=OPERATOR)
    assert reply.status_code == 409
    assert reply.json()["error"] == "worker_not_running"
    stale = datetime(2020, 1, 1, tzinfo=timezone.utc).isoformat()
    store.write_state({"status": "paused", "updated_at": stale}, tmp_path)
    reply = client.post("/v1/scenario/step", json={}, headers=OPERATOR)
    assert reply.status_code == 409
    assert reply.json()["error"] == "worker_not_running"
    assert not (tmp_path / "requests.json").exists()


# --- Day view (Task 14): 1, 2 and 5 min per scenario day, and the fields the day bar reads ---

def test_day_view_speeds_are_offered_sorted_and_the_default_is_kept():
    # 5, 2 and 1 min per 24-hour day at 5-minute ticks.
    assert {288, 720, 1440} <= set(store.SPEEDS)
    assert {2.4, 4.8, 12, 15, 30, 60, 150, 300, 600} <= set(store.SPEEDS)
    assert list(store.SPEEDS) == sorted(store.SPEEDS)
    assert store.DEFAULT_SPEED == 12


def test_one_minute_per_day_is_about_a_fifth_of_a_second_per_tick(tmp_path):
    s = session(tmp_path)
    s.set_speed(1440)
    assert s.step_seconds() == pytest.approx(0.2083, abs=1e-4)
    s.set_speed(720)
    assert s.step_seconds() == pytest.approx(0.4167, abs=1e-4)
    s.set_speed(288)
    assert s.step_seconds() == pytest.approx(1.0417, abs=1e-4)


def drive_by_sleep(tmp_path, speed, ticks):
    """Run the worker on a fake clock that moves by exactly what the worker asks to sleep.
    Returns the fake time at which each tick index first appeared in state.json."""
    now = [0.0]
    first_seen = {}
    store.append_request("speed", {"x": speed}, "op-test", tmp_path)

    def sleep(dt):
        state = json.loads((tmp_path / "state.json").read_text())
        first_seen.setdefault(state["tick_index"], now[0])
        if state["tick_index"] >= ticks:
            raise Stop
        # A floor so float round-off can never stall the fake clock.
        now[0] += max(dt, 1e-6)

    with pytest.raises(Stop):
        worker.run(scenario_dir=tmp_path, scenario="heather", seed=7, settings=dict(SETTINGS),
                   clock=lambda: now[0], sleep=sleep, ignore_old_requests=False)
    return first_seen


def test_worker_keeps_one_minute_per_day_when_a_tick_is_due_before_the_next_poll(tmp_path):
    # 0.2083 s per tick is under the 0.25 s poll: the worker sleeps only until the tick is due.
    seen = drive_by_sleep(tmp_path, 1440, ticks=12)
    gaps = [seen[i + 1] - seen[i] for i in range(1, 11)]
    assert all(gap == pytest.approx(300 / 1440, abs=1e-3) for gap in gaps), gaps


def test_worker_still_steps_on_time_at_slow_speeds(tmp_path):
    # 1.0417 s per tick: several 0.25 s polls, then a short sleep to land on the tick.
    seen = drive_by_sleep(tmp_path, 288, ticks=4)
    gaps = [seen[i + 1] - seen[i] for i in range(1, 3)]
    assert all(gap == pytest.approx(300 / 288, abs=1e-3) for gap in gaps), gaps


def test_history_points_carry_the_frames_price_mode_and_events(tmp_path):
    s = session(tmp_path)
    s.start("operator-hold", 1)
    for _ in range(22):
        s.step()
    by_tick = {point["tick"]: point for point in s.history}
    frames = {frame.tick: frame for frame in s.frames}
    assert by_tick[4]["mode"] == "HOLD" and by_tick[21]["mode"] == "HOLD"
    assert by_tick[3]["mode"] == "AUTO" and by_tick[22]["mode"] == "AUTO"
    for tick in (1, 4, 22):
        assert by_tick[tick]["price_usd_mwh"] == frames[tick].price_usd_mwh
        assert by_tick[tick]["price_label"] == frames[tick].price_label
        assert by_tick[tick]["events"] == sorted(frames[tick].events)


def test_history_events_name_the_faults_overlay_ticks(tmp_path):
    s = session(tmp_path)
    s.start("faults", 1)
    while s.index < len(s.frames) and s.frames[s.index].tick <= 157:
        s.step()
    by_tick = {point["tick"]: point for point in s.history}
    assert "crash" in by_tick[139]["events"] and "network" in by_tick[139]["events"]
    assert "crash" not in by_tick[138]["events"]
    assert by_tick[157]["events"] == ["live"]
    assert by_tick[132]["events"] == []


def test_history_events_include_the_alert_counties_the_engine_applied(tmp_path):
    s = session(tmp_path)
    s.start("beryl-landfall", 42)
    s.step()
    s.send_alert("beryl-harris-tropical-storm-warning")
    s.step()
    assert s.history[0]["events"] == []
    assert s.history[1]["events"] == ["weather_counties"]


def test_state_names_the_first_and_last_timestamp_of_the_tape(tmp_path):
    s = session(tmp_path)
    s.start("storm-rule-night", 1)
    scenario = s.state()["scenario"]
    assert scenario["first_ts"] == s.frames[0].ts == "2026-09-22T16:00:00-05:00"
    assert scenario["last_ts"] == s.frames[-1].ts == "2026-09-23T04:00:00-05:00"
    assert session(tmp_path).state()["scenario"] is None


def test_honest_limits_pack_line_uses_session_settings_without_trailing_zeroes(tmp_path):
    default = session(tmp_path).state()["honest_limits"]
    assert "Pack: 25 kWh, 11.4 kW (example settings, not Base specs), shown in time-lapse." in default

    custom_settings = {**SETTINGS, "home_kwh": 20.0, "home_max_kw": 5.0}
    custom = Session(custom_settings, load_catalog(ROOT / "tapes" / "scenarios" / "catalog.json"),
                     log_dir=tmp_path / "custom-logs").state()["honest_limits"]
    assert "Pack: 20 kWh, 5 kW (example settings, not Base specs), shown in time-lapse." in custom
    # Only the pack line changes: same length, same order, every other line untouched.
    assert len(custom) == len(default)
    assert [line for line in custom if not line.startswith("Pack:")] == \
        [line for line in default if not line.startswith("Pack:")]
    assert sum(line.startswith("Pack:") for line in custom) == 1


def test_every_scenario_tape_is_evenly_spaced_at_tick_minutes():
    # The day bar places ticks by their real ts; an uneven tape would need a different bar.
    for entry in load_catalog(ROOT / "tapes" / "scenarios" / "catalog.json"):
        frames = json.loads((ROOT / entry["tape"]).read_text())["frames"]
        stamps = [datetime.fromisoformat(frame["ts"]) for frame in frames]
        gaps = {(b - a).total_seconds() for a, b in zip(stamps, stamps[1:])}
        assert gaps == {SETTINGS["tick_minutes"] * 60}, (entry["id"], gaps)
