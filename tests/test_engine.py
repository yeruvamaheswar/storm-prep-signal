"""End-to-end runs of the tick loop: a 3-frame tape, and --live with a faked failed fetch."""
import json
from datetime import datetime
from pathlib import Path

import requests

from server.engine import signal
from server.engine.loop import run
from server.engine.signal import CENTRAL

ROOT = Path(__file__).parent.parent
TAPE = ROOT / "tests" / "fixtures" / "tape_tiny.json"
NP3 = ROOT / "tests" / "fixtures" / "np3_233_cd.json"
NP6 = ROOT / "tests" / "fixtures" / "np6_905_cd.json"
# Example simulation settings, not Base specs.
SETTINGS = {"margin_pct": 15, "lookahead_hours": 6, "fleet_size": 100, "home_kwh": 20,
            "home_max_kw": 5, "base_reserve_pct": 30, "storm_reserve_pct": 60, "tick_minutes": 5}
LIVE_SETTINGS = {**SETTINGS, "fetch_timeout_s": 3, "stale_after_min": 90}
NOW = datetime(2026, 9, 25, 12, 0, 47, tzinfo=CENTRAL)
TAPE_185 = {
    "label": "live price overlay",
    "frames": [{
        "tick": 1, "ts": "2026-09-25T12:00:00-05:00",
        "target_mw": 0.2, "target_label": "synthetic",
        "price_usd_mwh": 185, "price_label": "synthetic", "events": {},
    }],
}


class FakeResponse:
    def __init__(self, status_code, text):
        self.status_code = status_code
        self.text = text


class PinnedClock(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW


def _write_tape(path):
    path.write_text(json.dumps(TAPE_185))
    return path


def _fake_live(monkeypatch, tmp_path, price_status=200):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(signal, "datetime", PinnedClock)
    for name in ("ERCOT_USERNAME", "ERCOT_PASSWORD", "ERCOT_SUBSCRIPTION_KEY"):
        monkeypatch.setenv(name, "fake")

    def post(url, **kwargs):
        return FakeResponse(200, json.dumps({"id_token": "token"}))

    def get(url, **kwargs):
        if "np6-905-cd" in url:
            return FakeResponse(price_status, NP6.read_text() if price_status == 200 else "{}")
        return FakeResponse(200, NP3.read_text())

    monkeypatch.setattr(requests, "post", post)
    monkeypatch.setattr(requests, "get", get)
    return tmp_path / "tape_185.json"


def test_tiny_tape_calm_then_storm_then_missing_signal(tmp_path, monkeypatch):
    # The tape's risk_fixture paths are relative to the repo root.
    monkeypatch.chdir(ROOT)
    record = run(TAPE, SETTINGS, log_dir=tmp_path / "logs", runs_dir=tmp_path / "runs")
    assert record["source"] == "scenario"
    ticks = record["ticks"]
    assert [t["tick"] for t in ticks] == [1, 2, 3]
    assert [t["reserve_pct"] for t in ticks] == [30, 60, 60]
    assert [t["policy_reason"] for t in ticks] == ["normal", "storm_risk_high", "signal_unavailable"]
    # Mid-band LOW, HIGH+expensive, and fail-safe+expensive all hold. Allocate still discharges.
    assert [t["intent"] for t in ticks] == ["hold", "hold", "hold"]
    assert [t["price_usd_mwh"] for t in ticks] == [35.0, 250.0, 250.0]
    assert ticks[0]["delivered_mw"] > 0
    assert all(t["breaches"] == 0 for t in ticks)
    saved = json.loads((tmp_path / "runs" / f"{record['run_id']}.json").read_text())
    assert len(saved["ticks"]) == 3
    assert saved == json.loads((tmp_path / "runs" / "latest.json").read_text())


def test_heather_replay_raises_the_floor_only_after_the_high_posting(tmp_path, monkeypatch):
    monkeypatch.chdir(ROOT)
    baseline = ROOT / "data" / "fixtures" / "heather" / "baseline.json"
    record = run(ROOT / "tapes" / "heather.json", SETTINGS, log_dir=tmp_path / "logs",
                 runs_dir=tmp_path / "runs", baseline_path=baseline)
    assert record["baseline"].endswith("data/fixtures/heather/baseline.json")
    ticks = record["ticks"]
    assert len(ticks) == 145
    before = [t for t in ticks if t["ts"][11:16] < "13:05"]
    storm = [t for t in ticks if "13:05" <= t["ts"][11:16] <= "14:00"]
    after = [t for t in ticks if t["ts"][11:16] > "14:00"]
    assert (len(before), len(storm), len(after)) == (73, 12, 60)
    assert all(t["reserve_pct"] == 30 for t in before + after)
    assert all((t["reserve_pct"], t["policy_reason"]) == (60, "storm_risk_high") for t in storm)
    assert all(t["breaches"] == 0 for t in ticks)


def test_live_with_failed_fetch_keeps_the_storm_floor_on_every_tick(tmp_path, monkeypatch):
    for name in ("ERCOT_USERNAME", "ERCOT_PASSWORD", "ERCOT_SUBSCRIPTION_KEY"):
        monkeypatch.setenv(name, "fake")
    calls = []

    def timeout(url, **kwargs):
        calls.append(url)
        raise requests.Timeout("read timed out")

    monkeypatch.setattr(requests, "post", timeout)
    settings = {**SETTINGS, "fetch_timeout_s": 3, "stale_after_min": 90}
    record = run(None, settings, log_dir=tmp_path / "logs", runs_dir=tmp_path / "runs", live=True)
    assert len(calls) == 1
    assert (record["source"], record["tape"]) == ("live", "synthetic")
    ticks = record["ticks"]
    assert len(ticks) == 12
    assert all(t["reserve_pct"] == 60 for t in ticks)
    assert all(t["policy_reason"] == "signal_unavailable" for t in ticks)
    assert all((t["target_mw"], t["target_label"]) == (0.2, "synthetic") for t in ticks)
    [log_file] = (tmp_path / "logs").glob("*.jsonl")
    events = [json.loads(line) for line in log_file.read_text().splitlines()]
    [failed] = [e for e in events if e["stage"] == "compute_risk"]
    assert (failed["event"], failed["ok"]) == ("failed", False)
    assert failed["reason"] == "ERCOT did not answer within 3 s"


def test_live_run_stamps_ercot_price_not_tape_185(tmp_path, monkeypatch):
    tape = _write_tape(_fake_live(monkeypatch, tmp_path))
    record = run(tape, LIVE_SETTINGS, log_dir=tmp_path / "logs", runs_dir=tmp_path / "runs", live=True)
    ticks = record["ticks"]
    assert [t["price_usd_mwh"] for t in ticks] == [42.25]
    assert [t["price_label"] for t in ticks] == ["ercot"]
    assert all(t["price_as_of"].startswith("2026-09-25T12:00:00") for t in ticks)
    assert 185 not in [t["price_usd_mwh"] for t in ticks]


def test_live_price_failure_does_not_paint_185(tmp_path, monkeypatch):
    tape = _write_tape(_fake_live(monkeypatch, tmp_path, price_status=500))
    record = run(tape, LIVE_SETTINGS, log_dir=tmp_path / "logs", runs_dir=tmp_path / "runs", live=True)
    ticks = record["ticks"]
    assert [t["price_usd_mwh"] for t in ticks] == [None]
    assert [t["price_label"] for t in ticks] == ["none"]
    assert all(t["price_as_of"] is None for t in ticks)
    assert 185 not in [t["price_usd_mwh"] for t in ticks]


def _one_frame_tape(path, events=None, tick=1, ts="2026-09-25T12:00:00-05:00"):
    path.write_text(json.dumps({
        "label": "mode persist",
        "frames": [{
            "tick": tick, "ts": ts,
            "target_mw": 0.2, "target_label": "synthetic",
            "price_usd_mwh": 35.0, "price_label": "synthetic",
            "events": events or {},
        }],
    }))
    return path


def test_run_low_expensive_intents_discharge(tmp_path, monkeypatch):
    monkeypatch.chdir(ROOT)
    tape = tmp_path / "discharge.json"
    tape.write_text(json.dumps({
        "label": "low expensive",
        "frames": [{
            "tick": 1, "ts": "2026-09-25T12:00:00-05:00",
            "target_mw": 0.2, "target_label": "synthetic",
            "price_usd_mwh": 80.0, "price_label": "synthetic",
            "risk_fixture": "tests/fixtures/np3_233_cd.json",
            "events": {},
        }],
    }))
    record = run(tape, SETTINGS, log_dir=tmp_path / "logs", runs_dir=tmp_path / "runs")
    tick = record["ticks"][0]
    assert tick["intent"] == "discharge"
    assert tick["intent_reason"] == ""
    assert tick["breaches"] == 0
    assert tick["delivered_mw"] > 0


def test_run_hold_from_state_delivers_zero(tmp_path, monkeypatch):
    monkeypatch.chdir(ROOT)
    tape = _one_frame_tape(tmp_path / "hold.json")
    state = tmp_path / "state.json"
    state.write_text(json.dumps({"mode": "HOLD"}))
    record = run(tape, SETTINGS, log_dir=tmp_path / "logs", runs_dir=tmp_path / "runs", state_path=state)
    tick = record["ticks"][0]
    assert tick["mode"] == "HOLD"
    assert tick["delivered_mw"] == 0.0
    assert tick["reasons"] == ["operator_hold"]
    assert tick["intent"] == "hold"
    assert tick["intent_reason"] == "operator_hold"


def test_run_operator_event_sticks_and_persists(tmp_path, monkeypatch):
    monkeypatch.chdir(ROOT)
    tape = tmp_path / "sticky.json"
    tape.write_text(json.dumps({
        "label": "operator sticky",
        "frames": [
            {
                "tick": 1, "ts": "2026-09-25T12:00:00-05:00",
                "target_mw": 0.2, "target_label": "synthetic",
                "price_usd_mwh": 35.0, "price_label": "synthetic",
                "events": {"operator": "HOLD"},
            },
            {
                "tick": 2, "ts": "2026-09-25T12:05:00-05:00",
                "target_mw": 0.2, "target_label": "synthetic",
                "price_usd_mwh": 35.0, "price_label": "synthetic",
                "events": {},
            },
            {
                "tick": 3, "ts": "2026-09-25T12:10:00-05:00",
                "target_mw": 0.2, "target_label": "synthetic",
                "price_usd_mwh": 35.0, "price_label": "synthetic",
                "events": {"operator": "AUTO"},
            },
        ],
    }))
    state = tmp_path / "state.json"
    record = run(tape, SETTINGS, log_dir=tmp_path / "logs", runs_dir=tmp_path / "runs", state_path=state)
    assert [t["mode"] for t in record["ticks"]] == ["HOLD", "HOLD", "AUTO"]
    assert record["ticks"][0]["delivered_mw"] == 0.0
    assert record["ticks"][1]["delivered_mw"] == 0.0
    assert record["ticks"][1]["reasons"] == ["operator_hold"]
    assert json.loads(state.read_text())["mode"] == "AUTO"
