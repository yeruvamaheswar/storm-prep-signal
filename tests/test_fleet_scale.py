"""Live/archive targets follow FLEET_SIZE. The Demo tape stays 100 homes / 0.40 MW."""

from pathlib import Path

import pytest

from server.api.snapshot import IngestError, build_meta, build_snapshot
from server.engine.fleet import (
    call_target_mw,
    current_rollups,
    fleet_cap_mw,
    fleet_rollups,
    new_fleet,
    save_rollups,
    scale_target_mw,
    scale_tick_to_fleet,
)
from server.engine.loop import run


def _settings(n, call=None):
    return {"fleet_size": n, "home_max_kw": 11.4, "call_target_mw": call}


def test_demo_tape_stays_at_100_and_0_40():
    demo = _settings(100)
    assert fleet_cap_mw(demo) == 1.14
    assert call_target_mw(demo) == 0.4
    assert scale_target_mw(0.40, demo) == 0.40
    assert scale_target_mw(0.20, demo) == 0.20


def test_ten_thousand_homes_cap_is_114_mw_not_fixture_0_40():
    live = _settings(10_000)
    assert fleet_cap_mw(live) == 114.0
    assert call_target_mw(live) == 40.0
    assert scale_target_mw(0.40, live) == 40.0
    assert scale_target_mw(0.20, live) == 20.0


def test_call_target_setting_clamps_to_fleet_cap():
    assert call_target_mw(_settings(10_000, call=30)) == 30.0
    assert call_target_mw(_settings(10_000, call=200)) == 114.0
    assert scale_target_mw(0.40, _settings(10_000, call=30)) == 30.0


def test_scale_tick_counts_follow_fleet_size():
    tick = {
        "live_homes": 85, "stale_homes": 0, "dead_homes": 15,
        "target_mw": 0.40, "delivered_mw": 0.31, "missed_mw": 0.09,
        "zone_delivered_mw": {"North": 0.10},
        "zone_acks": {"North": {"acked": 12, "held": 10, "silent": 0, "dead": 3, "unconfirmed": 0}},
    }
    sized = scale_tick_to_fleet(tick, _settings(10_000))
    assert sized["live_homes"] + sized["stale_homes"] + sized["dead_homes"] == 10_000
    assert sized["live_homes"] == 8500
    assert sized["dead_homes"] == 1500
    assert sized["target_mw"] == 40.0
    assert sized["delivered_mw"] == 31.0
    assert sized["missed_mw"] == 9.0
    assert sized["zone_acks"]["North"]["acked"] == 1200


def test_scaled_books_close_when_the_target_hits_the_fleet_cap():
    # 1.0 MW on the 0.40 demo tape is 100 MW at 10k homes / 114 MW call: capped at 114.
    tick = {"live_homes": 100, "stale_homes": 0, "dead_homes": 0,
            "target_mw": 1.0, "delivered_mw": 0.3, "missed_mw": 0.7}
    sized = scale_tick_to_fleet(tick, _settings(10_000, call=114))
    assert sized["target_mw"] == pytest.approx(114.0)
    assert sized["delivered_mw"] == pytest.approx(85.5)
    assert sized["missed_mw"] == pytest.approx(114.0 - 85.5)
    assert sized["delivered_mw"] + sized["missed_mw"] == pytest.approx(sized["target_mw"])


def test_scaled_delivered_never_passes_the_scaled_target():
    tick = {"live_homes": 100, "stale_homes": 0, "dead_homes": 0,
            "target_mw": 1.2, "delivered_mw": 1.2, "missed_mw": 0.0}
    sized = scale_tick_to_fleet(tick, _settings(10_000, call=114))
    assert sized["delivered_mw"] <= sized["target_mw"]
    assert sized["missed_mw"] == pytest.approx(0.0)


def test_scaled_charging_follows_the_same_factor():
    tick = {"live_homes": 100, "stale_homes": 0, "dead_homes": 0,
            "target_mw": 0.0, "delivered_mw": 0.0, "missed_mw": 0.0,
            "charging_mw": 0.12, "zone_charging_mw": {"North": 0.05, "Houston": 0.07}}
    sized = scale_tick_to_fleet(tick, _settings(10_000))
    assert sized["charging_mw"] == pytest.approx(12.0)
    assert sized["zone_charging_mw"] == {"North": pytest.approx(5.0), "Houston": pytest.approx(7.0)}
    assert sized["missed_mw"] == 0.0


def test_scale_tick_is_noop_when_already_sized():
    tick = {"live_homes": 200, "stale_homes": 0, "dead_homes": 0, "target_mw": 0.8}
    assert scale_tick_to_fleet(tick, _settings(200))["target_mw"] == 0.8


def test_archive_run_scales_tape_and_still_misses_on_storm(tmp_path, monkeypatch):
    root = Path(__file__).resolve().parents[1]
    monkeypatch.chdir(root)
    settings = {
        "margin_pct": 15, "lookahead_hours": 6, "fleet_size": 200, "home_kwh": 25,
        "home_max_kw": 11.4, "base_reserve_pct": 30, "storm_reserve_pct": 60, "tick_minutes": 5,
    }
    record = run(
        root / "tests" / "fixtures" / "tape_tiny.json",
        settings,
        log_dir=tmp_path / "logs",
        runs_dir=tmp_path / "runs",
    )
    ticks = record["ticks"]
    assert ticks[0]["live_homes"] == 200
    assert ticks[0]["target_mw"] == 0.4
    assert ticks[1]["target_mw"] == 0.8
    assert ticks[2]["target_mw"] == 0.8
    assert ticks[2]["missed_mw"] > 0
    assert ticks[0]["delivered_mw"] == pytest.approx(ticks[0]["target_mw"])


def test_current_rollups_ignore_stale_n(tmp_path, monkeypatch):
    monkeypatch.setenv("FLEET_SIZE", "40")
    save_rollups(fleet_rollups(new_fleet(12)), tmp_path / "rollups.json")
    body = current_rollups(tmp_path)
    assert body["n"] == 40
    assert "homes" not in body
    assert sum(row["live"] for row in body["zones"].values()) == 40


def test_meta_live_10k_exposes_cap_and_call(tmp_path, monkeypatch):
    latest = tmp_path / "latest.json"
    latest.write_text(
        '{"run_id":"live","source":"live","settings":{"fleet_size":10000},'
        '"ticks":[{"tick":1,"ts":"t","mode":"AUTO","target_mw":0.4,"target_label":"synthetic",'
        '"delivered_mw":0.4,"missed_mw":0,"price_usd_mwh":null,"price_label":"none",'
        '"reserve_pct":30,"policy_reason":"normal","risk_level":"LOW","live_homes":100,'
        '"stale_homes":0,"dead_homes":0,"breaches":0,"reasons":[],"brief":"x"}]}',
        encoding="utf-8",
    )
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", latest)
    meta = build_meta()
    assert meta["fleet_size"] == 10000
    assert meta["fleet_cap_mw"] == 114.0
    assert meta["call_target_mw"] == 40.0


def test_snapshot_counts_follow_fleet_size(tmp_path, monkeypatch):
    latest = tmp_path / "latest.json"
    latest.write_text(
        '{"run_id":"layout-fixture","ticks":[{"tick":12,"ts":"2024-07-08T14:55:00-05:00",'
        '"mode":"AUTO","target_mw":0.2,"target_label":"synthetic","delivered_mw":0.2,'
        '"missed_mw":0.0,"price_usd_mwh":48,"price_label":"synthetic","reserve_pct":30,'
        '"policy_reason":"normal","risk_level":"LOW","live_homes":100,"stale_homes":0,'
        '"dead_homes":0,"breaches":0,"reasons":[],"brief":"tape"}]}',
        encoding="utf-8",
    )
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", latest)
    monkeypatch.setenv("FLEET_SIZE", "10000")
    monkeypatch.setenv("HOME_MAX_KW", "11.4")

    def boom(_now):
        raise IngestError("timeout")

    tick = build_snapshot(ingest=boom)
    assert tick["live_homes"] == 10000
    assert tick["target_mw"] == 20.0
