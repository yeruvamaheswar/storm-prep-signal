"""Archived NWS alerts and recorded per-county JEV readings on the /flow page. Offline: reads committed fixtures only."""
import json
from datetime import datetime
from pathlib import Path

import pytest

from server.engine.fleet import zone_counties
from server.engine.loop import with_fleet_defaults
from server.engine.scenario import (ALERT_DIR, JEV_DIR, Session, alert_counties, alert_zones, load_alert,
                                    load_catalog)

ROOT = Path(__file__).resolve().parent.parent
ALERTS = ROOT / ALERT_DIR
JEVS = ROOT / JEV_DIR
SETTINGS = {
    "margin_pct": 15, "lookahead_hours": 6, "fleet_size": 100, "home_kwh": 25.0, "home_max_kw": 11.4,
    "base_reserve_pct": 30.0, "storm_reserve_pct": 60.0, "tick_minutes": 5, "telemetry_feed": False,
}
EXPECTED_ZONES = {
    "beryl-harris-tropical-storm-warning": ["Houston"],
    "heather-dallas-hard-freeze-warning": ["North"],
    "heather-harris-hard-freeze-warning": ["Houston"],
    "tuning2026-midland-flash-flood-warning": ["West"],
}
REQUIRED = ("event", "headline", "description", "areaDesc", "counties", "onset", "expires", "sent", "sender",
            "source_url", "source_label", "product_id")
HARRIS_FREEZE = "heather-harris-hard-freeze-warning"
DALLAS_FREEZE = "heather-dallas-hard-freeze-warning"   # archived expiry 10:00 CST, inside the tape window


def fixture_ids():
    return sorted(path.stem for path in ALERTS.glob("*.json"))


def test_every_expected_alert_has_a_fixture():
    assert fixture_ids() == sorted(EXPECTED_ZONES)


@pytest.mark.parametrize("alert_id", sorted(EXPECTED_ZONES))
def test_fixture_has_the_page_fields_and_names_its_archive_record(alert_id):
    alert = load_alert(alert_id, ALERTS)
    assert all(alert.get(key) for key in REQUIRED), [key for key in REQUIRED if not alert.get(key)]
    assert alert["source_url"] == f"https://mesonet.agron.iastate.edu/p.php?pid={alert['product_id']}"
    assert alert["source_label"] == "Iowa Environmental Mesonet NWS archive"
    onset, expires, sent = (datetime.fromisoformat(alert[k]) for k in ("onset", "expires", "sent"))
    assert all(t.tzinfo is not None for t in (onset, expires, sent))
    assert onset < expires
    assert all(len(code) == 6 and code.startswith("048") for code in alert["counties"])


@pytest.mark.parametrize("alert_id, zones", sorted(EXPECTED_ZONES.items()))
def test_alert_counties_map_to_the_expected_zone(alert_id, zones):
    mapped, _ = alert_zones(load_alert(alert_id, ALERTS), with_fleet_defaults(SETTINGS))
    assert mapped == zones


def test_readings_live_only_in_the_per_county_layout():
    assert not list(JEVS.glob("*.json"))


@pytest.mark.parametrize("path", sorted(JEVS.glob("*/*.json")), ids=lambda p: f"{p.parent.name}/{p.stem}")
def test_recorded_jev_reading_matches_an_alert_county_and_the_page_shape(path):
    reading = json.loads(path.read_text())
    alert_id, fips = path.parent.name, path.stem
    assert alert_id in EXPECTED_ZONES
    counties, _ = alert_counties(load_alert(alert_id, ALERTS), with_fleet_defaults(SETTINGS))
    assert fips in {f for _, f, _ in counties}
    assert reading.get("county_fips", fips) == fips and f"county {fips}" in reading["input_label"]
    assert reading["recorded"] is True and reading["alert_id"] == alert_id
    assert reading["answer"] == ("yes" if reading["probability"] >= 0.5 else "no")
    assert 0.0 <= reading["probability"] <= 1.0
    assert reading["model"] and reading["latency_ms"] > 0
    assert datetime.fromisoformat(reading["called_at"]).tzinfo is not None
    assert reading["input_label"].startswith("archived NWS alert ")


def heather_session(tmp_path, jev_dir=None):
    # No readings by default: every named county fails safe to the storm reserve, so a test sees the
    # alert's timing alone. Pass JEVS for the recorded readings.
    jev_dir = jev_dir or tmp_path / "no-jev"
    catalog_path = tmp_path / "catalog.json"
    catalog_path.write_text(json.dumps({"scenarios": [{
        "id": "heather-alerts", "name": "Heather with archived alerts (test catalog)",
        "tape": str(ROOT / "tapes" / "heather.json"),
        "baseline": str(ROOT / "data" / "fixtures" / "heather" / "baseline.json"),
        "provenance": None, "alerts": [HARRIS_FREEZE, DALLAS_FREEZE], "grid_down_overlay": False,
    }]}))
    s = Session(dict(SETTINGS), load_catalog(catalog_path), log_dir=tmp_path / "logs", alert_dir=ALERTS,
                jev_dir=jev_dir)
    s.start("heather-alerts", 42)
    return s


def floors(s):
    return {zone: (row["reserve_pct"], row["reason"]) for zone, row in s.last["zones"].items()}


def test_alert_raises_only_its_zone_floor_from_the_next_tick(tmp_path):
    with_alert, without = heather_session(tmp_path), heather_session(tmp_path)
    for _ in range(10):                      # through 07:45 CT, storm rule LOW
        with_alert.step()
        without.step()
    before = floors(with_alert)
    with_alert.send_alert(HARRIS_FREEZE)
    assert floors(with_alert) == before == floors(without)
    assert set(before.values()) == {(30.0, "normal")}

    with_alert.step()
    without.step()
    after = floors(with_alert)
    assert after["Houston"] == (60.0, "weather_alert")
    assert floors(without)["Houston"] == (30.0, "normal")
    assert {z: v for z, v in after.items() if z != "Houston"} == \
        {z: v for z, v in floors(without).items() if z != "Houston"}


def test_alert_stops_applying_after_its_archived_expiry(tmp_path):
    s = heather_session(tmp_path)
    s.send_alert(DALLAS_FREEZE)
    expires = datetime.fromisoformat(load_alert(DALLAS_FREEZE, ALERTS)["expires"])
    seen_before = seen_after = 0
    for _ in range(60):                      # 07:00 to 11:55 CT, storm rule LOW throughout
        s.step()
        ts = datetime.fromisoformat(s.last["result"]["ts"])
        north = floors(s)["North"]
        if ts <= expires:
            seen_before += 1
            assert north == (60.0, "weather_alert"), s.last["result"]["ts"]
        else:
            seen_after += 1
            assert north == (30.0, "normal"), s.last["result"]["ts"]
        assert all(v == (30.0, "normal") for z, v in floors(s).items() if z != "North")
    assert seen_before and seen_after


def expected_county_floor(reading):
    if reading is None:
        return 60.0, "weather_alert_no_jev"
    return (60.0, "weather_alert_jev_yes") if reading["probability"] >= 0.5 else (30.0, "jev_no")


def test_recorded_jev_readings_gate_each_county_floor(tmp_path):
    s = heather_session(tmp_path, jev_dir=JEVS)
    s.step()
    s.send_alert(HARRIS_FREEZE)
    alert = s.active_alerts[0]
    readings = {fips: row["reading"] for fips, row in alert["jev_by_county"].items()}
    assert set(readings) == {fips for zone, fips, _ in zone_counties(s.settings) if zone == "Houston"}
    assert alert["jev"] == readings["48201"]
    expected = {fips: expected_county_floor(reading) for fips, reading in readings.items()}
    raised = any(reason != "jev_no" for _, reason in expected.values())
    for _ in range(20):
        s.step()
        tick = s.last["result"]
        assert tick["breaches"] == 0
        assert {f: (tick["county_reserve_pct"][f], tick["county_reasons"][f]) for f in expected} == expected
        assert floors(s)["Houston"] == ((60.0, "weather_alert") if raised else (30.0, "normal"))
        assert all((h["floor_pct"], h["floor_reason"]) == expected[h["county"]]
                   for h in s.last["homes"] if h["zone"] == "Houston")
