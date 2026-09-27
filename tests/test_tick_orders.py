"""Per-tick order timelines: the loop writes var/fleet/tick_orders.json, /v1/live/orders serves it."""
import json
from pathlib import Path

from fastapi.testclient import TestClient

import server.api.v1 as v1
import server.engine.loop as loop
from server.app import create_app
from server.engine.order_log import order_timelines

ZONES = {"Houston": "48201", "North": "48113", "South": "48355", "West": "48329"}
SETTINGS = {"margin_pct": 15, "lookahead_hours": 6, "fleet_size": 20, "home_kwh": 20.0,
            "home_max_kw": 5.0, "home_start_soc_min_pct": 45.0, "home_start_soc_max_pct": 75.0,
            "base_reserve_pct": 30.0, "storm_reserve_pct": 60.0, "tick_minutes": 5, "zones": ZONES}
ROOT = Path(__file__).resolve().parent.parent


def write_tape(path, frames):
    path.write_text(json.dumps({"label": "orders", "frames": frames}))
    return path


def frame(tick, ts, events=None):
    return {"tick": tick, "ts": ts, "target_mw": 0.05, "target_label": "synthetic",
            "price_usd_mwh": 35.0, "price_label": "synthetic", "events": events or {}}


def capture_cycles(monkeypatch):
    cycles = []
    real = loop.orchestrate_tick

    def spy(*args, **kwargs):
        cycle = real(*args, **kwargs)
        cycles.append(cycle)
        return cycle

    monkeypatch.setattr(loop, "orchestrate_tick", spy)
    return cycles


def test_loop_writes_tick_orders_beside_tick_emit(tmp_path, monkeypatch):
    monkeypatch.chdir(ROOT)
    cycles = capture_cycles(monkeypatch)
    tape = write_tape(tmp_path / "orders.json", [frame(1, "2026-09-25T12:00:00-05:00")])

    loop.run(str(tape), SETTINGS, log_dir=tmp_path / "logs", runs_dir=tmp_path / "runs")

    fleet_dir = tmp_path / "runs" / ".." / "fleet"
    assert (fleet_dir / "tick_emit.json").exists()
    body = json.loads((fleet_dir / "tick_orders.json").read_text())
    assert set(body) == {"tick", "ts", "orders"}
    assert body["tick"] == 1 and body["ts"] == "2026-09-25T12:00:00-05:00"

    # Exactly what order_timelines makes from that tick's orchestration events.
    (cycle,) = cycles
    expected = order_timelines(cycle.events, cycle.allocation.per_home_kw)
    assert expected, "an AUTO tick with a target should send orders"
    assert body["orders"] == json.loads(json.dumps(expected))
    for rows in body["orders"].values():
        for row in rows:
            assert len(row) == 4 and row[3] in ("own", "r")


def test_tick_orders_holds_the_last_tick_only(tmp_path, monkeypatch):
    monkeypatch.chdir(ROOT)
    cycles = capture_cycles(monkeypatch)
    tape = write_tape(tmp_path / "orders.json", [
        frame(1, "2026-09-25T12:00:00-05:00"),
        frame(2, "2026-09-25T12:05:00-05:00", {"operator": "HOLD"}),
    ])

    loop.run(str(tape), SETTINGS, log_dir=tmp_path / "logs", runs_dir=tmp_path / "runs")

    body = json.loads((tmp_path / "fleet" / "tick_orders.json").read_text())
    assert body["tick"] == 2 and body["ts"] == "2026-09-25T12:05:00-05:00"
    # HOLD sends nothing, so the last tick has no orders to animate.
    assert body["orders"] == order_timelines(cycles[-1].events, cycles[-1].allocation.per_home_kw) == {}


def client():
    return TestClient(create_app())


def test_live_orders_serves_the_file(tmp_path, monkeypatch):
    body = {"tick": 7, "ts": "2026-09-26T17:05:00-05:00",
            "orders": {"home-001": [[0.0, "sent", 2.5, "own"], [3.1, "conf", 2.5, "own"]]}}
    path = tmp_path / "tick_orders.json"
    path.write_text(json.dumps(body))
    monkeypatch.setattr(v1, "TICK_ORDERS_PATH", path)

    response = client().get("/v1/live/orders")

    assert response.status_code == 200
    assert response.json() == body


def test_live_orders_404_when_no_tick_has_run(tmp_path, monkeypatch):
    monkeypatch.setattr(v1, "TICK_ORDERS_PATH", tmp_path / "missing.json")

    response = client().get("/v1/live/orders")

    assert response.status_code == 404
    body = response.json()
    assert set(body) == {"error", "brief"}
    assert body["error"] == "no_tick_orders"
    assert body["brief"]
