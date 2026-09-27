"""Archived NWS alerts and shadow JEV readings on the /flow page. Offline: reads committed fixtures only."""
import json
from datetime import datetime
from pathlib import Path

import pytest

from server.engine.loop import with_fleet_defaults
from server.engine.scenario import ALERT_DIR, JEV_DIR, Session, alert_zones, load_alert, load_catalog

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


@pytest.mark.parametrize("path", sorted(JEVS.glob("*.json")), ids=lambda p: p.stem)
def test_recorded_jev_reading_matches_an_alert_and_the_page_shape(path):
    reading = json.loads(path.read_text())
    assert path.stem in EXPECTED_ZONES
    assert reading["recorded"] is True and reading["alert_id"] == path.stem
    assert reading["answer"] == ("yes" if reading["probability"] >= 0.5 else "no")
    assert 0.0 <= reading["probability"] <= 1.0
    assert reading["model"] and reading["latency_ms"] > 0
    assert datetime.fromisoformat(reading["called_at"]).tzinfo is not None
    assert reading["input_label"].startswith("archived NWS alert ")


def heather_session(tmp_path, jev_dir=JEVS):
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


def run_ticks(s, steps):
    frames = []
    for _ in range(steps):
        s.step()
        frames.append((floors(s), [(h["id"], h["kw"], h["soc_pct"]) for h in s.last["homes"]]))
    return frames


def test_jev_reading_is_attached_and_never_changes_a_floor_or_kw(tmp_path):
    reading = json.loads((JEVS / f"{HARRIS_FREEZE}.json").read_text())
    with_jev = heather_session(tmp_path)
    without_jev = heather_session(tmp_path, jev_dir=tmp_path / "no-jev")
    for s in (with_jev, without_jev):
        s.step()
        s.send_alert(HARRIS_FREEZE)
    assert with_jev.active_alerts[0]["jev"] == reading
    assert without_jev.active_alerts[0]["jev"] is None
    assert run_ticks(with_jev, 40) == run_ticks(without_jev, 40)
    assert with_jev.history == without_jev.history
