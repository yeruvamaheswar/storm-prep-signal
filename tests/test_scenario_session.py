"""/flow scenario sessions: seeded random fleets, one engine tick per step, requests via files."""
import importlib.util
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server.api.fixtures import FixtureStore
from server.app import create_app
from server.engine import scenario as store
from server.engine.scenario import SOC_RANGE_PCT, Session, load_catalog, read_state

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("scenario_session", ROOT / "scripts" / "scenario_session.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

OPERATOR = {"X-Operator-Id": "op-test"}
SETTINGS = {
    "margin_pct": 15, "lookahead_hours": 6, "fleet_size": 100, "home_kwh": 25.0, "home_max_kw": 11.4,
    "base_reserve_pct": 30.0, "storm_reserve_pct": 60.0, "tick_minutes": 5, "telemetry_feed": False,
}


def session(tmp_path, **kwargs):
    return Session(dict(SETTINGS), load_catalog(ROOT / "tapes" / "scenarios" / "catalog.json"),
                   log_dir=tmp_path / "logs", **kwargs)


def play(tmp_path, seed, steps):
    s = session(tmp_path)
    s.start("heather", seed)
    for _ in range(steps):
        s.step()
    return s


def test_same_seed_gives_same_fleet_and_same_ticks(tmp_path):
    a, b = play(tmp_path, 7, 20), play(tmp_path, 7, 20)
    assert [h.soc_kwh for h in a.homes] == [h.soc_kwh for h in b.homes]
    assert a.start_summary == b.start_summary
    assert [p["delivered_mw"] for p in a.history] == [p["delivered_mw"] for p in b.history]
    c = play(tmp_path, 8, 0)
    assert c.start_summary["histogram"] != a.start_summary["histogram"]


def test_state_carries_replay_orders_before_soc_and_richer_history(tmp_path):
    s = play(tmp_path, 7, 1)
    state = s.state()
    assert state["orders"] == s.last["orders"]
    assert state["orders"]
    assert all("soc_before_pct" in home for home in state["homes"])
    assert {"missed_mw", "unconfirmed_mw", "reserve_pct", "risk_level", "reasons"} <= set(state["history"][-1])


def test_history_rows_carry_the_engine_breach_count(tmp_path):
    s = play(tmp_path, 7, 3)
    history = s.state()["history"]
    assert len(history) == 3
    assert all(isinstance(point["breaches"], int) for point in history)
    assert history[-1]["breaches"] == s.state()["tick"]["breaches"]


def test_starting_charge_is_spread_wide_and_some_start_under_the_floor(tmp_path):
    s = play(tmp_path, 42, 0)
    pcts = [100 * h.soc_kwh / h.capacity_kwh for h in s.homes]
    assert len(s.homes) == 100
    assert SOC_RANGE_PCT[0] <= min(pcts) and max(pcts) <= SOC_RANGE_PCT[1]
    assert sum(s.start_summary["below_base_floor"].values()) == sum(p < 30 for p in pcts) > 0
    assert sum(s.start_summary["histogram"]) == 100


def test_engine_never_drains_a_battery_below_its_floor(tmp_path):
    s = play(tmp_path, 42, 80)   # 13:35 CT: inside the 13:05-14:00 HIGH window
    assert all(z["reserve_pct"] == 60 for z in s.last["zones"].values())
    assert "selling" not in {h["state"] for h in s.last["homes"] if h["soc_pct"] < 60}
    while s.step():
        pass
    assert s.status() == "finished"
    assert s.board["breaches"] == 0
    assert all(z["reserve_pct"] == 30 for z in s.last["zones"].values())


def test_a_battery_under_its_floor_either_started_there_or_saw_the_floor_rise(tmp_path):
    s = play(tmp_path, 42, 1)
    # Under the floor by charge, whatever the state: a refilling battery reads "charging".
    def under(h):
        return h["soc_pct"] < h["floor_pct"] - 0.5
    early = [h for h in s.last["homes"] if under(h)]
    assert early and {h["under_floor_why"] for h in early} == {"started_under"}
    assert all(h["under_floor_why"] is None for h in s.last["homes"] if not under(h))
    for _ in range(79):          # tick 80, 13:35 CT: the storm floor is 60%
        s.step()
    raised = [h for h in s.last["homes"] if h["under_floor_why"] == "floor_raised"]
    assert raised and all(h["soc_pct"] >= 29.5 for h in raised)


def test_drained_batteries_sit_at_the_floor_and_are_not_called_holding(tmp_path):
    s = play(tmp_path, 42, 70)   # the ask has drained the spare charge before the storm floor rises
    at_floor = [h for h in s.last["homes"] if h["state"] == "at_floor"]
    assert at_floor
    assert all(abs(h["soc_pct"] - h["floor_pct"]) <= 0.5 for h in at_floor)
    assert all(h["soc_pct"] > h["floor_pct"] + 0.5 for h in s.last["homes"] if h["state"] == "holding")


def test_provenance_names_the_posting_rating_and_prices(tmp_path):
    s = play(tmp_path, 1, 76)   # 13:15 CT, after the 13:03:35 posting
    prov = s.last["provenance"]
    assert prov["posting"]["posted_at"] == "2024-01-15T13:03:35"
    assert prov["posting"]["file"].endswith("np3_233_cd_20240115T130335.json")
    assert prov["rating"]["level"] == "HIGH"
    assert set(prov["zone_prices"]["zones"]) == {"Houston", "North", "South", "West"}
    assert prov["target"]["label"] == "synthetic"
    assert prov["baseline"]["postings"] == 720


def test_bad_request_is_noted_not_raised(tmp_path):
    s = session(tmp_path)
    s.apply({"kind": "reset", "body": {}})
    s.apply({"kind": "start", "body": {"scenario": "nope"}})
    assert s.status() == "idle"
    assert [m["text"] for m in s.messages] == ["refused reset: pick a scenario first",
                                               "refused start: no scenario 'nope'"]


def test_read_state_names_a_missing_or_stopped_worker(tmp_path):
    assert read_state(tmp_path)["status"] == "worker_not_running"
    store.write_state({"status": "playing", "updated_at": datetime.now(timezone.utc).isoformat()}, tmp_path)
    assert read_state(tmp_path)["status"] == "playing"
    later = datetime.now(timezone.utc) + timedelta(seconds=store.STALE_AFTER_S + 5)
    assert read_state(tmp_path, now=later)["status"] == "worker_not_running"


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.delenv("CONSOLE_SCENE", raising=False)
    monkeypatch.setattr(store, "SCENARIO_DIR", tmp_path)
    return TestClient(create_app(FixtureStore()))


def test_verify_reads_supabase_by_the_tape_rules(client, monkeypatch):
    """Posting: newest at or before the clock. Price: the 15-minute interval that holds the clock."""
    from server.api import archive

    asked = []

    def fake_rows(table, params, settings=None, http_get=None):
        asked.append((table, params))
        if table == "ercot_postings":
            return [{"posted_at": "2024-01-15T14:02:53+00:00", "payload": [{"hour": 1}]}]
        if params.get("settlement_point") == "eq.LZ_NORTH":
            return [{"settlement_point": "LZ_NORTH", "interval_ending": "2024-01-15T15:00:00+00:00",
                     "delivery_date": "01/15/2024", "delivery_hour": 9, "delivery_interval": 4, "price_usd_mwh": 253.89}]
        return [{"settlement_point": "LZ_HOUSTON", "interval_ending": "2024-01-15T15:00:00+00:00",
                 "delivery_date": "01/15/2024", "delivery_hour": 9, "delivery_interval": 4, "price_usd_mwh": 123.63}]

    monkeypatch.setattr(archive, "fetch_rows", fake_rows)
    reply = client.get("/v1/scenario/verify", params={"event": "heather", "clock": "2024-01-15T08:50:00-06:00"})
    assert reply.status_code == 200
    body = reply.json()
    assert body["posted_at"] == "2024-01-15T08:02:53"
    assert body["interval_ending"] == "2024-01-15T09:00:00"
    assert body["zone_prices"] == {"North": 253.89, "Houston": 123.63}
    posting_params = asked[0][1]
    north_params = asked[1][1]
    assert posting_params["posted_at"] == "lte.2024-01-15T08:50:00-06:00"
    assert north_params["interval_ending"] == "lte.2024-01-15T09:05:00-06:00"


def test_verify_names_an_unconfigured_archive(client, monkeypatch):
    from server.api import archive

    monkeypatch.setattr(archive, "archive_settings", lambda: {"url": "", "key": "", "timeout_s": 1.0})
    reply = client.get("/v1/scenario/verify", params={"event": "heather", "clock": "2024-01-15T08:50:00-06:00"})
    assert reply.status_code == 503
    assert reply.json()["error"] == "archive_unavailable"


def test_writes_need_an_operator_and_a_known_scenario(client, tmp_path):
    assert client.post("/v1/scenario/start", json={"scenario": "heather"}).status_code == 401
    refused = client.post("/v1/scenario/start", json={"scenario": "nope"}, headers=OPERATOR)
    assert refused.status_code == 409 and refused.json()["error"] == "unknown_scenario"
    assert client.post("/v1/scenario/speed", json={"x": 7}, headers=OPERATOR).status_code == 422
    assert not (tmp_path / "requests.json").exists()


def test_speed_accepts_slow_replay_values(client, tmp_path):
    assert client.post("/v1/scenario/speed", json={"x": 15}, headers=OPERATOR).status_code == 202
    assert client.post("/v1/scenario/speed", json={"x": 30}, headers=OPERATOR).status_code == 202
    assert client.post("/v1/scenario/speed", json={"x": 7}, headers=OPERATOR).status_code == 422
    requests = json.loads((tmp_path / "requests.json").read_text())
    assert [request["body"]["x"] for request in requests] == [15, 30]


def test_api_only_records_requests_and_the_worker_applies_them(client, tmp_path):
    scenario_list = client.get("/v1/scenarios").json()
    assert "heather" in [s["id"] for s in scenario_list["scenarios"]]
    # Task 11 added the slow Replay speeds (2.4 is real time) and made 12 the default.
    assert scenario_list["speeds"] == [2.4, 4.8, 12, 15, 30, 60, 150, 300, 600]
    assert scenario_list["default_speed"] == 12
    assert client.get("/v1/scenario/state").json()["status"] == "worker_not_running"
    ok = client.post("/v1/scenario/start", json={"scenario": "heather", "seed": 5}, headers=OPERATOR)
    assert ok.status_code == 202
    assert client.post("/v1/scenario/speed", json={"x": 600}, headers=OPERATOR).status_code == 202
    # Nothing ran yet: the route wrote a request, not a state.
    assert not (tmp_path / "state.json").exists()
    assert [r["kind"] for r in json.loads((tmp_path / "requests.json").read_text())] == ["start", "speed"]

    s = worker.run(scenario_dir=tmp_path, steps=3, settings=dict(SETTINGS), poll_s=0.0, sleep=lambda _: None,
                   ignore_old_requests=False)
    assert s.seed == 5 and s.speed == 600 and s.index == 3
    state = client.get("/v1/scenario/state").json()
    assert state["status"] == "playing"
    assert state["tick_index"] == 3 and len(state["homes"]) == 100
    assert state["provenance"]["posting"]["report"] == "NP3-233-CD"


def test_history_points_carry_the_ticks_own_intent(tmp_path):
    s = session(tmp_path)
    s.start("heather", 42)
    for _ in range(80):
        s.step()
        tick, point = s.last["result"], s.history[-1]
        assert point["intent"] == tick["intent"]
        assert point["intent_reason"] == tick["intent_reason"]
    assert "charge" in {p["intent"] for p in s.history}


def test_home_rows_carry_the_status_the_planner_used(tmp_path):
    # Without a feed the planner reads the engine's own homes, so both statuses agree.
    s = play(tmp_path, 42, 5)
    assert all(h["plan_status"] == h["status"] for h in s.last["homes"])
    # With the feed the planner reads the reports: the stale and dead counts in the reasons are its view.
    s = Session({**SETTINGS, "telemetry_feed": True},
                load_catalog(ROOT / "tapes" / "scenarios" / "catalog.json"), log_dir=tmp_path / "feed")
    s.start("heather", 42)
    differs = 0
    for _ in range(80):
        s.step()
        reasons = s.last["result"]["reasons"]
        for status in ("stale", "dead"):
            code = next((r for r in reasons if r.startswith(f"homes_{status}:")), None)
            count = int(code.split(":")[1]) if code else 0
            assert sum(h["plan_status"] == status for h in s.last["homes"]) == count
        differs += sum(h["plan_status"] != h["status"] for h in s.last["homes"])
    assert differs > 0
