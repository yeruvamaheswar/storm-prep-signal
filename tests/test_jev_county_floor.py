"""JEV gates the alert floor per county: yes raises, no keeps base, no reading fails safe."""
import json
from pathlib import Path

import pytest

from server.engine.contracts import Home
from server.engine.fleet import floor_kwh, home_label, zone_counties
from server.engine.policy import reserve_policy
from server.engine.risk import RiskResult
from server.engine.scenario import ALERT_DIR, JEV_DIR, Session, load_catalog

ROOT = Path(__file__).resolve().parent.parent
SETTINGS = {"base_reserve_pct": 30, "storm_reserve_pct": 60,   # example, not Base specs
            "zones": {"Houston": "48201", "North": "48113", "South": "48355", "West": "48329"}}
HARRIS, FORT_BEND, BRAZORIA, GALVESTON, MONTGOMERY = "48201", "48157", "48039", "48167", "48339"
HOUSTON = (HARRIS, FORT_BEND, BRAZORIA, GALVESTON, MONTGOMERY)
HARRIS_FREEZE = "heather-harris-hard-freeze-warning"
BERYL = "beryl-harris-tropical-storm-warning"


def make_risk(level):
    return RiskResult(level=level, peak_mw=0, peak_hour=1, baseline_mw=0, trigger_mw=0,
                      margin_mw=0, peak_lead=0, driving_zone="North", zone_mw={})


def home(county, zone="Houston"):
    return Home("home-001", 25.0, 20.0, 11.4, zone=zone, county=county)


@pytest.mark.parametrize("probability, pct, reason", [
    (0.8, 60, "weather_alert_jev_yes"),
    (0.5, 60, "weather_alert_jev_yes"),
    (0.49, 30, "jev_no"),
    (None, 60, "weather_alert_no_jev"),
])
def test_one_county_floor_follows_its_jev_reading(probability, pct, reason):
    policy = reserve_policy(make_risk("LOW"), SETTINGS, county_alerts={FORT_BEND: probability})
    # The zone's other counties get their own base floor; other zones get no county rows.
    assert policy.county_reserve_pct == {**dict.fromkeys(HOUSTON, 30), FORT_BEND: pct}
    assert policy.county_reasons == {**dict.fromkeys(HOUSTON, "not_in_alert"), FORT_BEND: reason}
    raised = reason != "jev_no"
    assert policy.zone_reasons["Houston"] == ("weather_alert" if raised else "normal")
    assert policy.zone_reserve_pct["Houston"] == (60 if raised else 30)
    assert {z: policy.zone_reasons[z] for z in ("North", "South", "West")} == dict.fromkeys(("North", "South", "West"), "normal")
    assert floor_kwh(home(FORT_BEND), policy) == pytest.approx(25.0 * pct / 100)


@pytest.mark.parametrize("risk, reason", [(make_risk("HIGH"), "storm_risk_high"), (None, "signal_unavailable")])
def test_fleet_wide_reason_outranks_a_jev_no(risk, reason):
    policy = reserve_policy(risk, SETTINGS, county_alerts={HARRIS: 0.1, FORT_BEND: 0.9})
    # The county table reports the floor each home really keeps: the fleet's 60%.
    assert policy.county_reserve_pct == dict.fromkeys(HOUSTON, 60)
    assert policy.county_reasons == dict.fromkeys(HOUSTON, reason)
    assert set(policy.zone_reasons.values()) == {reason}
    assert floor_kwh(home(HARRIS), policy) == pytest.approx(15.0)


def test_partly_raised_zone_never_sells_on_price_and_keeps_each_county_floor():
    policy = reserve_policy(make_risk("LOW"), {**SETTINGS, "charge_threshold_usd_mwh": 25,
                                               "discharge_threshold_usd_mwh": 60},
                            price_usd_mwh=200.0, price_label="synthetic", zone_prices={"Houston": 200.0},
                            county_alerts={HARRIS: 0.1, FORT_BEND: 0.9})
    assert policy.county_reasons == {HARRIS: "jev_no", FORT_BEND: "weather_alert_jev_yes", BRAZORIA: "not_in_alert",
                                     GALVESTON: "not_in_alert", MONTGOMERY: "not_in_alert"}
    assert (policy.zone_reserve_pct["Houston"], policy.zone_reasons["Houston"]) == (60, "weather_alert")
    assert policy.zone_intent["Houston"] == "hold"
    assert floor_kwh(home(HARRIS), policy) == pytest.approx(7.5)
    assert floor_kwh(home(FORT_BEND), policy) == pytest.approx(15.0)
    # A county the alert did not name keeps its own base floor, not the zone's raised one.
    assert floor_kwh(home(BRAZORIA), policy) == pytest.approx(7.5)
    # A home in another zone has no county row and keeps its zone floor.
    assert floor_kwh(home("48113", zone="North"), policy) == pytest.approx(7.5)


def test_zone_whose_alerted_counties_all_say_no_stays_normal():
    policy = reserve_policy(make_risk("LOW"), SETTINGS, county_alerts={HARRIS: 0.1, FORT_BEND: 0.2})
    assert (policy.zone_reserve_pct["Houston"], policy.zone_reasons["Houston"]) == (30, "normal")


def test_whole_zone_tape_alert_is_not_lowered_by_a_jev_no():
    policy = reserve_policy(make_risk("LOW"), SETTINGS, {"Houston": "tape"}, county_alerts={HARRIS: 0.1})
    assert policy.county_reasons == dict.fromkeys(HOUSTON, "weather_alert")
    assert floor_kwh(home(HARRIS), policy) == pytest.approx(15.0)
    assert floor_kwh(home(BRAZORIA), policy) == pytest.approx(15.0)


def test_no_county_alerts_leave_the_policy_unchanged():
    assert reserve_policy(make_risk("LOW"), SETTINGS) == reserve_policy(make_risk("LOW"), SETTINGS, county_alerts={})


# --- the /flow session with hand-written readings (test fixtures, not recorded Jev answers) ---

TEST_READINGS = {HARRIS: 0.1, FORT_BEND: 0.8, GALVESTON: 0.3, MONTGOMERY: 0.6}   # Brazoria has none


SESSION_SETTINGS = {"margin_pct": 15, "lookahead_hours": 6, "fleet_size": 100, "home_kwh": 25.0,
                    "home_max_kw": 11.4, "base_reserve_pct": 30.0, "storm_reserve_pct": 60.0, "tick_minutes": 5,
                    "telemetry_feed": False}


def test_beryl_raises_only_the_harris_homes_on_the_recorded_jev_yes(tmp_path):
    reading = json.loads((ROOT / JEV_DIR / BERYL / f"{HARRIS}.json").read_text())
    assert reading["probability"] >= 0.5          # the recorded Beryl answer this test relies on
    s = Session(dict(SESSION_SETTINGS), load_catalog(), log_dir=tmp_path / "logs")
    s.start("beryl-landfall", 7)
    s.step()
    s.send_alert(BERYL)
    for _ in range(20):
        s.step()
        tick = s.last["result"]
        assert tick["policy_reason"] == "normal" and tick["breaches"] == 0
        assert tick["county_reasons"] == {HARRIS: "weather_alert_jev_yes", **dict.fromkeys(HOUSTON[1:], "not_in_alert")}
        assert (tick["zone_reserve_pct"]["Houston"], tick["zone_reasons"]["Houston"]) == (60.0, "weather_alert")
        houston = [row for row in s.last["homes"] if row["zone"] == "Houston"]
        harris = [row for row in houston if row["county"] == HARRIS]
        assert len(harris) == 5 and all(row["floor_pct"] == 60.0 for row in harris)
        assert all((row["floor_pct"], row["floor_reason"]) == (30.0, "not_in_alert")
                   for row in houston if row["county"] != HARRIS)
        assert all(row["floor_pct"] == 30.0 for row in s.last["homes"] if row["zone"] != "Houston")
        # Every Harris home is kept at or refilled toward 60%: none sells below it.
        assert all(row["kw"] <= 0 for row in harris if row["soc_pct"] < 60.0)


def session_with_test_readings(tmp_path):
    jev_dir = tmp_path / "jev"
    (jev_dir / HARRIS_FREEZE).mkdir(parents=True)
    for fips, probability in TEST_READINGS.items():
        (jev_dir / HARRIS_FREEZE / f"{fips}.json").write_text(json.dumps({
            "probability": probability, "answer": "yes" if probability >= 0.5 else "no",
            "input_label": "test fixture, not a Jev answer", "recorded": False}))
    catalog_path = tmp_path / "catalog.json"
    catalog_path.write_text(json.dumps({"scenarios": [{
        "id": "heather-alerts", "name": "Heather with archived alerts (test catalog)",
        "tape": str(ROOT / "tapes" / "heather.json"),
        "baseline": str(ROOT / "data" / "fixtures" / "heather" / "baseline.json"),
        "provenance": None, "alerts": [HARRIS_FREEZE], "grid_down_overlay": False,
    }]}))
    settings = {"margin_pct": 15, "lookahead_hours": 6, "fleet_size": 100, "home_kwh": 25.0, "home_max_kw": 11.4,
                "base_reserve_pct": 30.0, "storm_reserve_pct": 60.0, "tick_minutes": 5, "telemetry_feed": False}
    s = Session(settings, load_catalog(catalog_path), log_dir=tmp_path / "logs", alert_dir=ROOT / ALERT_DIR,
                jev_dir=jev_dir)
    s.start("heather-alerts", 42)
    return s


def test_homes_get_a_county_round_robin_and_a_display_name(tmp_path):
    s = session_with_test_readings(tmp_path)
    houston = [h for h in s.homes if h.zone == "Houston"]
    assert [h.county for h in houston[:5]] == [HARRIS, FORT_BEND, BRAZORIA, GALVESTON, MONTGOMERY]
    assert {h.county for h in houston[5:10]} == {HARRIS, FORT_BEND, BRAZORIA, GALVESTON, MONTGOMERY}
    assert home_label(next(h for h in s.homes if h.home_id == "home-005")) == "Houston-FortBend-005"
    state = s.state()
    assert state["counties"] == [{"zone": z, "fips": f, "name": n} for z, f, n in zone_counties(s.settings)]
    row = next(r for r in state["homes"] if r["id"] == "home-005")
    assert (row["name"], row["county"], row["county_name"], row["floor_reason"]) == \
        ("Houston-FortBend-005", FORT_BEND, "Fort Bend", "normal")


def test_session_gates_each_county_floor_on_its_test_reading(tmp_path):
    s = session_with_test_readings(tmp_path)
    s.step()                                  # 07:00 CT, storm rule LOW
    s.send_alert(HARRIS_FREEZE)
    alert = s.state()["alerts"][0]
    assert alert["jev"]["probability"] == 0.1
    assert {f: row["decision"] for f, row in alert["jev_by_county"].items()} == {
        HARRIS: "keep_base", FORT_BEND: "raise", BRAZORIA: "raise_no_reading",
        GALVESTON: "keep_base", MONTGOMERY: "raise"}
    assert alert["jev_by_county"][FORT_BEND]["county_name"] == "Fort Bend"
    assert alert["jev_by_county"][FORT_BEND]["zone"] == "Houston"

    expected = {HARRIS: (30.0, "jev_no"), FORT_BEND: (60.0, "weather_alert_jev_yes"),
                BRAZORIA: (60.0, "weather_alert_no_jev"), GALVESTON: (30.0, "jev_no"),
                MONTGOMERY: (60.0, "weather_alert_jev_yes")}
    for _ in range(30):                       # alert live, storm rule LOW
        s.step()
        tick = s.last["result"]
        assert tick["breaches"] == 0
        assert {f: (tick["county_reserve_pct"][f], tick["county_reasons"][f]) for f in expected} == expected
        assert (tick["zone_reserve_pct"]["Houston"], tick["zone_reasons"]["Houston"]) == (60.0, "weather_alert")
        assert tick["zone_reasons"]["North"] == "normal"
        for row in s.last["homes"]:
            if row["zone"] == "Houston":
                assert (row["floor_pct"], row["floor_reason"]) == expected[row["county"]]
            else:
                assert (row["floor_pct"], row["floor_reason"]) == (30.0, "normal")
    assert s.last["zones"]["Houston"]["reserve_pct"] == 60.0
