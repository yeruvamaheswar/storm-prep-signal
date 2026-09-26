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


def seen_at(t):
    hs, stats = tm.HomeState("home-001", 20.0), tm.new_stats()
    tm.ingest(hs, reading(1, ts=t), t, stats)
    return hs


def test_stale_after_180_seconds_and_dead_after_600():
    hs, s = seen_at(0.0), settings()
    assert tm.data_status(hs, 180.0, s) == "live"
    assert tm.data_status(hs, 181.0, s) == "stale"
    assert tm.data_status(hs, 600.0, s) == "stale"
    assert tm.data_status(hs, 601.0, s) == "dead"


def test_a_new_reading_revives_a_home_that_was_only_silent():
    hs, s = seen_at(0.0), settings()
    assert tm.data_status(hs, 700.0, s) == "dead"
    tm.ingest(hs, reading(2, ts=700.0), 700.0, tm.new_stats())
    assert tm.data_status(hs, 700.0, s) == "live"


def test_suspect_is_sticky_even_with_fresh_readings():
    hs, s = seen_at(0.0), settings()
    hs.suspect = True
    assert tm.data_status(hs, 1.0, s) == "suspect"


def test_status_ignores_device_clock():
    hs, stats = tm.HomeState("home-001", 20.0), tm.new_stats()
    tm.ingest(hs, reading(1, ts=99999.0), 0.0, stats)   # battery clock far ahead of ours
    assert tm.data_status(hs, 181.0, settings()) == "stale"


def test_tape_dead_never_revives_and_suspect_plans_as_stale():
    assert tm.plan_status("dead", "live") == "dead"
    assert tm.plan_status("stale", "live") == "stale"
    assert tm.plan_status("live", "live") == "live"
    assert tm.plan_status("live", "dead") == "dead"
    assert tm.plan_status("live", "suspect") == "stale"
    assert tm.view_status("live", "suspect") == "suspect"
    assert tm.view_status("dead", "live") == "dead"


def fleet_and_state(seed=7, **over):
    s = settings(**{**QUIET, **over})
    homes = new_fleet(s)
    return s, homes, tm.TelemetryState(homes, s, seed)


def test_every_home_is_registered_and_live_before_the_first_tick():
    s, homes, state = fleet_and_state()
    assert len(state.homes) == 100
    copies = state.reported_homes(homes)
    assert all(c.status == "live" for c in copies)
    assert [c.soc_kwh for c in copies] == [h.soc_kwh for h in homes]


def test_reported_homes_are_new_objects_and_never_the_simulator():
    s, homes, state = fleet_and_state()
    copies = state.reported_homes(homes)
    assert all(c is not h for c, h in zip(copies, homes))
    copies[0].soc_kwh = 0.0
    copies[0].status = "dead"
    assert homes[0].soc_kwh > 0.0 and homes[0].status == "live"


def test_reported_copy_uses_the_reported_charge_not_the_truth():
    s, homes, state = fleet_and_state()
    homes[0].soc_kwh -= 3.0                      # truth moved; no reading yet
    assert state.reported_homes(homes)[0].soc_kwh == homes[0].soc_kwh + 3.0


def test_tape_status_combines_with_data_status():
    s, homes, state = fleet_and_state()
    apply_events(homes, {"dead": ["home-002"]})
    state.homes["home-003"].suspect = True
    by_id = {c.home_id: c for c in state.reported_homes(homes)}
    assert by_id["home-002"].status == "dead"
    assert by_id["home-003"].status == "stale"
    state.base_s = 700.0                         # nobody has reported for 710 s
    copies = state.reported_homes(homes)
    assert all(c.status == "dead" for c in copies if c.home_id != "home-003")
    assert {c.home_id: c.status for c in copies}["home-003"] == "stale"   # suspect beats age


def test_reported_homes_rejects_unknown_home():
    s, homes, state = fleet_and_state()
    stranger = Home("home-999", 20.0, 10.0, 5.0, zone="Houston")
    with pytest.raises(ValueError, match="home-999"):
        state.reported_homes(homes + [stranger])


def test_the_seed_plants_one_liar_and_about_five_percent_outages():
    s = settings()
    homes = new_fleet(s)
    a, b = tm.TelemetryState(homes, s, 3), tm.TelemetryState(homes, s, 3)
    assert len(a.liar_ids) == 1 and a.liar_ids == b.liar_ids
    assert len(a.outages) == 5 and a.outages == b.outages


def test_explicit_outage_window():
    s, homes, state = fleet_and_state(telemetry_outages={"home-001": [(0.0, 50.0)]})
    assert state.offline("home-001", 10.0) and not state.offline("home-001", 50.0)
    assert not state.offline("home-002", 10.0)
