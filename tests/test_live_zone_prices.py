"""Live NP6-905-CD for all four load zones: fetch, read, stamp on the tick, upsert. No live network."""
import importlib.util
import json
from datetime import datetime
from pathlib import Path

import pytest
import requests

from server.engine import signal
from server.engine.loop import run
from server.engine.signal import (
    CENTRAL,
    ZONE_POINTS,
    SignalUnavailable,
    fetch_zone_prices,
    read_zone_prices,
)

ROOT = Path(__file__).resolve().parent.parent
NP3 = ROOT / "tests" / "fixtures" / "np3_233_cd.json"
NOW = datetime(2026, 9, 25, 12, 0, 47, tzinfo=CENTRAL)
SECRETS = {"ERCOT_USERNAME": "user-SECRET-1", "ERCOT_PASSWORD": "pass-SECRET-2",
           "ERCOT_SUBSCRIPTION_KEY": "key-SECRET-3"}
TOKEN = "token-SECRET-4"
FIELDS = ("deliveryDate", "deliveryHour", "deliveryInterval", "settlementPoint", "settlementPointPrice")
# One newest-interval price per load zone, as ERCOT would answer each settlementPoint GET.
ZONE_USD = {"LZ_HOUSTON": 20.63, "LZ_NORTH": 42.25, "LZ_SOUTH": 291.18, "LZ_WEST": -1.99}
SETTINGS = {
    "margin_pct": 15, "lookahead_hours": 6, "fleet_size": 100, "home_kwh": 20.0,
    "home_max_kw": 5.0, "base_reserve_pct": 30.0, "storm_reserve_pct": 60.0,
    "tick_minutes": 5, "fetch_timeout_s": 3, "stale_after_min": 90,
}

spec = importlib.util.spec_from_file_location("live_cycle", ROOT / "scripts" / "live_cycle.py")
cycle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cycle)


class FakeResponse:
    def __init__(self, status_code, text):
        self.status_code = status_code
        self.text = text


class PinnedClock(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW


def body(point, usd, hour=12, interval=4):
    return {"fields": [{"name": n} for n in FIELDS],
            "data": [["2026-09-25", hour, interval - 1, point, usd - 1.0],
                     ["2026-09-25", hour, interval, point, usd]]}


def fake_ercot(monkeypatch, tmp_path, zone_status=200):
    """Answers each NP6 GET with that settlementPoint's rows; NP3 with the outage fixture."""
    monkeypatch.chdir(tmp_path)
    for name, value in SECRETS.items():
        monkeypatch.setenv(name, value)
    calls = []

    def post(url, **kwargs):
        calls.append(("post", url, kwargs))
        return FakeResponse(200, json.dumps({"id_token": TOKEN}))

    def get(url, **kwargs):
        calls.append(("get", url, kwargs))
        if "np6-905-cd" in url:
            point = kwargs["params"]["settlementPoint"]
            if point != "LZ_NORTH" and zone_status != 200:
                return FakeResponse(zone_status, "{}")
            return FakeResponse(200, json.dumps(body(point, ZONE_USD[point])))
        return FakeResponse(200, NP3.read_text())

    monkeypatch.setattr(requests, "post", post)
    monkeypatch.setattr(requests, "get", get)
    return calls


def test_zone_points_are_the_four_load_zones_and_prices_py_shares_them():
    from server.api.prices import LOAD_ZONE_POINTS
    assert ZONE_POINTS == {"Houston": "LZ_HOUSTON", "North": "LZ_NORTH",
                           "South": "LZ_SOUTH", "West": "LZ_WEST"}
    assert LOAD_ZONE_POINTS is ZONE_POINTS


def test_fetch_zone_prices_asks_each_load_zone_with_one_login(monkeypatch, tmp_path):
    calls = fake_ercot(monkeypatch, tmp_path)
    saved = tmp_path / "latest_np6_zones.json"
    raw = fetch_zone_prices(SETTINGS, NOW, save_to=saved)
    assert [c[0] for c in calls].count("post") == 1
    gets = [c for c in calls if c[0] == "get"]
    assert sorted(c[2]["params"]["settlementPoint"] for c in gets) == sorted(ZONE_POINTS.values())
    assert all(c[1].endswith("/np6-905-cd/spp_node_zone_hub") for c in gets)
    assert all(c[2]["headers"]["Authorization"] == f"Bearer {TOKEN}" for c in gets)
    assert len(raw["data"]) == 8
    assert json.loads(saved.read_text()) == raw


def test_fetch_zone_prices_reuses_a_passed_token(monkeypatch, tmp_path):
    calls = fake_ercot(monkeypatch, tmp_path)
    fetch_zone_prices(SETTINGS, NOW, save_to=tmp_path / "z.json", id_token="given")
    assert not [c for c in calls if c[0] == "post"]


def test_fetch_zone_prices_failure_is_secret_free(monkeypatch, tmp_path):
    fake_ercot(monkeypatch, tmp_path, zone_status=500)
    with pytest.raises(SignalUnavailable) as err:
        fetch_zone_prices(SETTINGS, NOW, save_to=tmp_path / "z.json")
    assert "HTTP 500" in str(err.value)
    assert not any(secret in str(err.value) for secret in [*SECRETS.values(), TOKEN])


def test_read_zone_prices_takes_each_zones_newest_interval():
    merged = {"fields": [{"name": n} for n in FIELDS],
              "data": [row for point, usd in ZONE_USD.items() for row in body(point, usd)["data"]]
              + [["2026-09-25", 12, 4, "LZ_AEN", 999.0]]}
    assert read_zone_prices(merged, NOW) == {"Houston": 20.63, "North": 42.25,
                                            "South": 291.18, "West": -1.99}


def test_read_zone_prices_leaves_out_a_stale_zone():
    rows = body("LZ_NORTH", 42.25)["data"] + body("LZ_WEST", 6.34, hour=10, interval=1)["data"]
    raw = {"fields": [{"name": n} for n in FIELDS], "data": rows}
    assert read_zone_prices(raw, NOW) == {"North": 42.25}


def test_read_zone_prices_rejects_a_broken_body():
    with pytest.raises(SignalUnavailable):
        read_zone_prices({"data": []}, NOW)


def test_live_run_stamps_zone_prices_and_prices_zone_dollars(tmp_path, monkeypatch):
    fake_ercot(monkeypatch, tmp_path)
    monkeypatch.setattr(signal, "datetime", PinnedClock)
    record = run(None, SETTINGS, log_dir=tmp_path / "logs", runs_dir=tmp_path / "runs", live=True)
    tick = record["ticks"][0]
    assert tick["zone_prices"] == {"Houston": 20.63, "North": 42.25, "South": 291.18, "West": -1.99}
    assert tick["zone_price_label"] == "ercot"
    by_zone = record["totals"]["by_zone"]
    assert any(entry["dollars"] not in (None, 0) for entry in by_zone.values())


def test_live_run_with_failed_zone_fetch_keeps_zone_prices_empty(tmp_path, monkeypatch):
    fake_ercot(monkeypatch, tmp_path, zone_status=500)
    monkeypatch.setattr(signal, "datetime", PinnedClock)
    record = run(None, SETTINGS, log_dir=tmp_path / "logs", runs_dir=tmp_path / "runs", live=True)
    tick = record["ticks"][0]
    assert (tick["zone_prices"], tick["zone_price_label"]) == ({}, "none")
    assert tick["price_usd_mwh"] == 42.25


def test_live_worker_upserts_all_four_zones_and_stamps_the_tick(tmp_path, monkeypatch):
    fake_ercot(monkeypatch, tmp_path)
    sent = []

    def fake_send(rows, url, key, table="ercot_postings", on_conflict="report,posted_at"):
        sent.append((table, list(rows)))

    result = cycle.run_cycle(
        SETTINGS, now=NOW, runs_dir=tmp_path / "runs", log_dir=tmp_path / "logs",
        state_path=tmp_path / "state.json", url="https://example.supabase.co", key="test-key",
        persist=False, send=fake_send,
    )
    prices = [row for table, rows in sent if table == "ercot_prices" for row in rows]
    assert {row["settlement_point"] for row in prices} == set(ZONE_POINTS.values())
    assert all(row["event"] == "live" for row in prices)
    tick = result["record"]["ticks"][-1]
    assert tick["zone_prices"]["South"] == 291.18
    assert tick["zone_price_label"] == "ercot"
