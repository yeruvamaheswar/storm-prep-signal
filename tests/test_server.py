"""The /v1 scaffold follows docs/agents/plans/operator-console.md."""

import pytest
from fastapi.testclient import TestClient

from server.app import create_app
from server.fixtures import FixtureStore

OPERATOR = {"X-Operator-Id": "op-test"}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("CONSOLE_SCENE", raising=False)
    return TestClient(create_app(FixtureStore()))


def scene_client(monkeypatch, scene):
    monkeypatch.setenv("CONSOLE_SCENE", scene)
    return TestClient(create_app(FixtureStore()))


def test_health(client):
    assert client.get("/health").json() == {"ok": True}


def test_reads_return_fixtures(client):
    assert client.get("/v1/zone").json()["zone_id"] == "NP3"
    assert client.get("/v1/live").json()["tick_id"] == "tick_live_ok"
    assert client.get("/v1/playback").json() is None
    assert client.get("/v1/tapes").json()[0]["tape_id"] == "demo-stress"


def test_homes_filter_and_lookup(client):
    homes = client.get("/v1/homes", params={"status": "unconfirmed"}).json()
    assert [h["home_id"] for h in homes] == ["home-014"]
    assert client.get("/v1/homes/home-001").json()["status"] == "live"
    assert client.get("/v1/homes/home-999").status_code == 404


def test_ticks_by_range_and_id(client):
    rng = {"from": "2026-07-08T19:00:00-05:00", "to": "2026-07-08T20:00:00-05:00"}
    assert len(client.get("/v1/ticks", params=rng).json()) == 5
    empty = {"from": "2026-07-10T00:00:00Z", "to": "2026-07-10T01:00:00Z"}
    assert client.get("/v1/ticks", params=empty).json() == []
    naive = {"from": "2026-07-08T19:00:00", "to": "2026-07-08T20:00:00-05:00"}
    assert client.get("/v1/ticks", params=naive).status_code == 422
    assert client.get("/v1/ticks/tick_bad_feed").json()["mode"] == "RESERVE"


def test_stream_sends_one_tick_frame(client):
    body = client.get("/v1/live/stream").text
    assert body.startswith("event: tick\ndata: {")
    assert body.endswith("\n\n")


def test_writes_need_an_operator(client):
    res = client.post("/v1/fleet/mode", json={"mode": "HOLD"})
    assert res.status_code == 401
    assert res.json()["error"] == "operator_required"


def test_mode_is_recorded_and_refused_during_playback(client):
    assert client.post("/v1/fleet/mode", json={"mode": "HOLD"}, headers=OPERATOR).status_code == 202
    assert client.post("/v1/playback", json={"tape_id": "demo-stress"}, headers=OPERATOR).status_code == 202
    res = client.post("/v1/fleet/mode", json={"mode": "AUTO"}, headers=OPERATOR)
    assert res.status_code == 409
    assert res.json()["error"] == "playback_running"


def test_playback_start_stop(client):
    start = client.post("/v1/playback", json={"tape_id": "demo-stress"}, headers=OPERATOR)
    assert start.json() == {"tape_id": "demo-stress", "tick_index": 0, "tick_count": 12}
    assert client.get("/v1/live").json()["source"] == "playback"
    again = client.post("/v1/playback", json={"tape_id": "demo-stress"}, headers=OPERATOR)
    assert again.status_code == 409
    assert client.post("/v1/playback/stop", json={}, headers=OPERATOR).status_code == 202
    assert client.get("/v1/playback").json() is None
    assert client.get("/v1/live").json()["source"] == "live"


def test_unknown_tape_is_refused(client):
    res = client.post("/v1/playback", json={"tape_id": "nope"}, headers=OPERATOR)
    assert res.status_code == 409


def test_retry_can_be_used_once(monkeypatch):
    client = scene_client(monkeypatch, "bad-feed")
    att_id = client.get("/v1/live").json()["attention"]["attention_id"]
    url = f"/v1/attention/{att_id}"
    assert client.post(url, json={"choice": "retry"}, headers=OPERATOR).status_code == 202
    attention = client.get("/v1/live").json()["attention"]
    assert attention["retry_spent"] is True
    assert attention["choices"] == ["approve", "skip"]
    second = client.post(url, json={"choice": "retry"}, headers=OPERATOR)
    assert second.status_code == 409
    assert second.json()["error"] == "retry_spent"


def test_attention_answer_never_leaves_reserve(monkeypatch):
    client = scene_client(monkeypatch, "bad-feed")
    att_id = client.get("/v1/live").json()["attention"]["attention_id"]
    client.post(f"/v1/attention/{att_id}", json={"choice": "approve"}, headers=OPERATOR)
    assert client.get("/v1/live").json()["mode"] == "RESERVE"


def test_unknown_attention_is_refused(client):
    res = client.post("/v1/attention/att_missing", json={"choice": "approve"}, headers=OPERATOR)
    assert res.status_code == 409
    assert res.json()["error"] == "unknown_attention"


def test_bad_scene_fails_at_startup(monkeypatch):
    with pytest.raises(ValueError):
        scene_client(monkeypatch, "not-a-scene")
