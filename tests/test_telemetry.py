"""Tests for server/engine/telemetry.py: the battery feed, the intake, and the VPP's view of each home."""
import math

import pytest

from server.engine.contracts import Home, Policy, TapeFrame
from server.engine.fleet import apply_events, floor_kwh, new_fleet
from server.engine import telemetry as tm

ZONES = {"Houston": "48201", "North": "48113", "South": "48355", "West": "48329"}
QUIET = {"telemetry_outage_rate": 0.0, "telemetry_dup_rate": 0.0, "telemetry_late_rate": 0.0,
         "telemetry_liar_ids": ()}
FAST = {"channel_delay_s": (1.0, 5.0), "worker_delay_s": (1.0, 5.0)}


def settings(**over):
    base = {"fleet_size": 100, "home_kwh": 20.0, "home_max_kw": 5.0,
            "home_start_soc_min_pct": 45.0, "home_start_soc_max_pct": 75.0,
            "base_reserve_pct": 30.0, "storm_reserve_pct": 60.0, "tick_minutes": 5, "zones": ZONES}
    base.update(over)
    return base


def policy(pct=30.0):
    return Policy(pct, "normal", "LOW", zone_reserve_pct={z: pct for z in ZONES},
                  zone_reasons={z: "normal" for z in ZONES})


def frame(target_mw, events=None, tick=1):
    return TapeFrame(tick, "2026-09-25T12:00:00-05:00", target_mw, "synthetic", 40.0, "synthetic",
                     events=events or {})


def reading(seq, soc=10.0, boot=1, home_id="home-001", ts=0.0):
    return {"command_id": f"telemetry:{home_id}:{boot}:{seq}", "home_id": home_id, "boot_id": boot,
            "seq": seq, "device_ts": ts, "soc_kwh": soc, "power_kw": 0.0, "charge_state": "HOLDING",
            "grid": "connected", "health": "ok"}


def test_accepts_a_new_reading_and_records_arrival_time():
    hs, stats = tm.HomeState("home-001", 20.0), tm.new_stats()
    assert tm.ingest(hs, reading(1, soc=12.5), 42.0, stats) == "accepted"
    assert hs.last["soc_kwh"] == 12.5 and hs.last["ingest_ts"] == 42.0 and hs.last_seen == 42.0
    assert stats["received"] == 1 and stats["accepted"] == 1


def test_skips_a_repeat_of_the_same_boot_and_seq():
    hs, stats = tm.HomeState("home-001", 20.0), tm.new_stats()
    tm.ingest(hs, reading(1), 1.0, stats)
    assert tm.ingest(hs, reading(1, soc=3.0), 2.0, stats) == "duplicate"
    assert hs.last["soc_kwh"] == 10.0 and hs.last_seen == 1.0
    assert hs.dups == 1 and stats["duplicates"] == 1


def test_an_older_reading_is_late_and_never_replaces_a_newer_one():
    hs, stats = tm.HomeState("home-001", 20.0), tm.new_stats()
    tm.ingest(hs, reading(5, soc=9.0), 50.0, stats)
    assert tm.ingest(hs, reading(4, soc=11.0), 60.0, stats) == "late"
    assert hs.last["seq"] == 5 and hs.last_seen == 50.0 and stats["late"] == 1


def test_rejects_impossible_charge():
    hs, stats = tm.HomeState("home-001", 20.0), tm.new_stats()
    assert tm.ingest(hs, reading(1, soc=-0.1), 1.0, stats) == "rejected"
    assert tm.ingest(hs, reading(2, soc=20.1), 1.0, stats) == "rejected"
    assert hs.last is None and stats["rejected"] == 2


def test_a_new_boot_restarts_seq_without_being_a_duplicate():
    hs, stats = tm.HomeState("home-001", 20.0), tm.new_stats()
    tm.ingest(hs, reading(40, boot=1), 1.0, stats)
    assert tm.ingest(hs, reading(1, boot=2), 2.0, stats) == "accepted"
    assert hs.boot_id == 2 and hs.last_seq == 1


def test_otel_view_uses_the_hardware_metric_names_and_units():
    home = Home("home-014", 20.0, 12.0, 5.0, zone="Houston")
    r = reading(1, soc=12.0, home_id="home-014", ts=4121.8)
    r["power_kw"] = 2.1
    view = tm.to_otel(r, home)
    assert view["resource"]["hw.id"] == "home-014"
    assert view["resource"]["ercot.load_zone"] == "Houston"
    assert view["resource"]["data.label"] == "synthetic"
    metrics = {m["name"]: m for m in view["metrics"]}
    assert metrics["hw.battery.charge"]["unit"] == "1"
    assert metrics["hw.battery.charge"]["value"] == pytest.approx(0.6)
    assert metrics["hw.power"]["unit"] == "W" and metrics["hw.power"]["value"] == pytest.approx(2100.0)
    assert metrics["hw.status"]["attributes"] == {"hw.state": "ok"}
    assert metrics["hw.battery.charge"]["time_unix_nano"] == 4121800000000
