"""A county an alert names keeps the storm reserve; the zone's other counties keep the base floor."""
from pathlib import Path

import pytest

from server.engine.contracts import Home
from server.engine.fleet import floor_kwh, home_label, zone_counties
from server.engine.loop import with_fleet_defaults
from server.engine.policy import reserve_policy
from server.engine.risk import RiskResult
from server.engine.scenario import ALERT_DIR, Session, alert_counties, load_alert, load_catalog

ROOT = Path(__file__).resolve().parent.parent
SETTINGS = {"base_reserve_pct": 30, "storm_reserve_pct": 60,   # example, not Base specs
            "zones": {"Houston": "48201", "North": "48113", "South": "48355", "West": "48329"}}
HARRIS, FORT_BEND, BRAZORIA, GALVESTON, MONTGOMERY = "48201", "48157", "48039", "48167", "48339"
HOUSTON = (HARRIS, FORT_BEND, BRAZORIA, GALVESTON, MONTGOMERY)
NORTH = ("48113", "48439", "48085", "48121")   # Dallas, Tarrant, Collin, Denton
MIDLAND, ECTOR, TOM_GREEN, TAYLOR = "48329", "48135", "48451", "48441"
HARRIS_FREEZE = "heather-harris-hard-freeze-warning"
BERYL = "beryl-harris-tropical-storm-warning"
DALLAS_HEAT = "tuning2026-dallas-heat-advisory"
MIDLAND_FLOOD = "tuning2026-midland-flash-flood-warning"


def make_risk(level):
    return RiskResult(level=level, peak_mw=0, peak_hour=1, baseline_mw=0, trigger_mw=0,
                      margin_mw=0, peak_lead=0, driving_zone="North", zone_mw={})


def home(county, zone="Houston"):
    return Home("home-001", 25.0, 20.0, 11.4, zone=zone, county=county)


def named_by(alert_id):
    """The frame's weather_counties for one archived alert: each named roster county to its event."""
    alert = load_alert(alert_id, ROOT / ALERT_DIR)
    counties, _ = alert_counties(alert, with_fleet_defaults(dict(SETTINGS)))
    return {fips: alert["event"] for _, fips, _ in counties}


def test_one_named_county_keeps_the_storm_reserve_and_its_neighbours_keep_base():
    policy = reserve_policy(make_risk("LOW"), SETTINGS, county_alerts={FORT_BEND: "Flash Flood Warning"})
    # The zone's other counties get their own base floor; other zones get no county rows.
    assert policy.county_reserve_pct == {**dict.fromkeys(HOUSTON, 30), FORT_BEND: 60}
    assert policy.county_reasons == {**dict.fromkeys(HOUSTON, "not_in_alert"), FORT_BEND: "weather_alert"}
    assert (policy.zone_reserve_pct["Houston"], policy.zone_reasons["Houston"]) == (60, "weather_alert")
    assert {z: policy.zone_reasons[z] for z in ("North", "South", "West")} == dict.fromkeys(("North", "South", "West"), "normal")
    assert floor_kwh(home(FORT_BEND), policy) == pytest.approx(15.0)
    assert floor_kwh(home(HARRIS), policy) == pytest.approx(7.5)


@pytest.mark.parametrize("alert_id, zone, expected", [
    (BERYL, "Houston", {HARRIS: 60, **dict.fromkeys(HOUSTON[1:], 30)}),
    (HARRIS_FREEZE, "Houston", dict.fromkeys(HOUSTON, 60)),
    (DALLAS_HEAT, "North", dict.fromkeys(NORTH, 60)),
    (MIDLAND_FLOOD, "West", {MIDLAND: 60, ECTOR: 60, TOM_GREEN: 30, TAYLOR: 30}),
])
def test_archived_alert_raises_exactly_the_counties_it_names(alert_id, zone, expected):
    policy = reserve_policy(make_risk("LOW"), SETTINGS, county_alerts=named_by(alert_id))
    assert policy.county_reserve_pct == expected
    assert policy.county_reasons == {f: "weather_alert" if pct == 60 else "not_in_alert" for f, pct in expected.items()}
    assert (policy.zone_reserve_pct[zone], policy.zone_reasons[zone]) == (60, "weather_alert")
    assert all(policy.zone_reasons[z] == "normal" for z in SETTINGS["zones"] if z != zone)


@pytest.mark.parametrize("risk, reason", [(make_risk("HIGH"), "storm_risk_high"), (None, "signal_unavailable")])
def test_fleet_wide_reason_outranks_the_county_rule(risk, reason):
    policy = reserve_policy(risk, SETTINGS, county_alerts=named_by(BERYL))
    # The county table reports the floor each home really keeps: the fleet's 60%, even where unnamed.
    assert policy.county_reserve_pct == dict.fromkeys(HOUSTON, 60)
    assert policy.county_reasons == dict.fromkeys(HOUSTON, reason)
    assert set(policy.zone_reasons.values()) == {reason}
    assert floor_kwh(home(BRAZORIA), policy) == pytest.approx(15.0)


def test_partly_named_zone_never_sells_on_price_and_keeps_each_county_floor():
    policy = reserve_policy(make_risk("LOW"), {**SETTINGS, "charge_threshold_usd_mwh": 25,
                                               "discharge_threshold_usd_mwh": 60},
                            price_usd_mwh=200.0, price_label="synthetic", zone_prices={"Houston": 200.0},
                            county_alerts=named_by(BERYL))
    assert (policy.zone_reserve_pct["Houston"], policy.zone_reasons["Houston"]) == (60, "weather_alert")
    assert policy.zone_intent["Houston"] == "hold"
    assert floor_kwh(home(HARRIS), policy) == pytest.approx(15.0)
    # A county the alert did not name keeps its own base floor, not the zone's raised one.
    assert floor_kwh(home(BRAZORIA), policy) == pytest.approx(7.5)
    # A home in another zone has no county row and keeps its zone floor.
    assert floor_kwh(home("48113", zone="North"), policy) == pytest.approx(7.5)


def test_whole_zone_tape_alert_outranks_the_county_rule():
    policy = reserve_policy(make_risk("LOW"), SETTINGS, {"Houston": "tape"}, county_alerts=named_by(BERYL))
    assert policy.county_reasons == dict.fromkeys(HOUSTON, "weather_alert")
    assert floor_kwh(home(HARRIS), policy) == pytest.approx(15.0)
    assert floor_kwh(home(BRAZORIA), policy) == pytest.approx(15.0)


def test_no_county_alerts_leave_the_policy_unchanged():
    assert reserve_policy(make_risk("LOW"), SETTINGS) == reserve_policy(make_risk("LOW"), SETTINGS, county_alerts={})


# --- the /flow session with the archived alerts ---

SESSION_SETTINGS = {"margin_pct": 15, "lookahead_hours": 6, "fleet_size": 100, "home_kwh": 25.0,
                    "home_max_kw": 11.4, "base_reserve_pct": 30.0, "storm_reserve_pct": 60.0, "tick_minutes": 5,
                    "telemetry_feed": False}


def session(tmp_path, scenario_id):
    s = Session(dict(SESSION_SETTINGS), load_catalog(), log_dir=tmp_path / "logs")
    s.start(scenario_id, 7)
    s.step()
    return s


def test_beryl_raises_only_the_harris_homes(tmp_path):
    s = session(tmp_path, "beryl-landfall")
    s.send_alert(BERYL)
    alert = s.state()["alerts"][0]
    assert alert["named_counties"] == [{"fips": HARRIS, "county_name": "Harris", "zone": "Houston"}]
    assert alert["zones"] == ["Houston"] and alert["event"] == "Tropical Storm Warning"
    assert "jev" not in alert and "jev_by_county" not in alert
    for _ in range(20):
        s.step()
        tick = s.last["result"]
        assert tick["policy_reason"] == "normal" and tick["breaches"] == 0
        assert s.last["provenance"]["events"]["weather_counties"] == {HARRIS: "Tropical Storm Warning"}
        assert tick["county_reasons"] == {HARRIS: "weather_alert", **dict.fromkeys(HOUSTON[1:], "not_in_alert")}
        assert (tick["zone_reserve_pct"]["Houston"], tick["zone_reasons"]["Houston"]) == (60.0, "weather_alert")
        houston = [row for row in s.last["homes"] if row["zone"] == "Houston"]
        harris = [row for row in houston if row["county"] == HARRIS]
        assert len(harris) == 5 and all(row["floor_pct"] == 60.0 for row in harris)
        assert all((row["floor_pct"], row["floor_reason"]) == (30.0, "not_in_alert")
                   for row in houston if row["county"] != HARRIS)
        assert all(row["floor_pct"] == 30.0 for row in s.last["homes"] if row["zone"] != "Houston")
        # Every Harris home is kept at or refilled toward 60%: none sells below it.
        assert all(row["kw"] <= 0 for row in harris if row["soc_pct"] < 60.0)


def test_heather_harris_freeze_names_every_houston_county(tmp_path):
    s = session(tmp_path, "heather")               # 07:00 CT, storm rule LOW
    s.send_alert(HARRIS_FREEZE)
    alert = s.state()["alerts"][0]
    assert [row["fips"] for row in alert["named_counties"]] == list(HOUSTON)
    assert alert["named_counties"][1] == {"fips": FORT_BEND, "county_name": "Fort Bend", "zone": "Houston"}
    for _ in range(30):
        s.step()
        tick = s.last["result"]
        assert tick["policy_reason"] == "normal" and tick["breaches"] == 0
        assert {f: (tick["county_reserve_pct"][f], tick["county_reasons"][f]) for f in HOUSTON} == \
            dict.fromkeys(HOUSTON, (60.0, "weather_alert"))
        assert (tick["zone_reserve_pct"]["Houston"], tick["zone_reasons"]["Houston"]) == (60.0, "weather_alert")
        for row in s.last["homes"]:
            expected = (60.0, "weather_alert") if row["zone"] == "Houston" else (30.0, "normal")
            assert (row["floor_pct"], row["floor_reason"]) == expected
    assert s.last["zones"]["Houston"]["reserve_pct"] == 60.0


def test_dallas_heat_advisory_holds_every_north_county_at_the_storm_reserve(tmp_path):
    s = session(tmp_path, "price-spike")
    s.send_alert(DALLAS_HEAT)
    for _ in range(6):                        # 17:50 to 18:15 CT: advisory live, LZ_NORTH $225 to $855
        s.step()
        tick = s.last["result"]
        assert tick["policy_reason"] == "normal" and tick["breaches"] == 0
        assert tick["county_reasons"] == dict.fromkeys(NORTH, "weather_alert")
        assert (tick["zone_reserve_pct"]["North"], tick["zone_reasons"]["North"]) == (60.0, "weather_alert")
        assert all(row["floor_pct"] == 60.0 for row in s.last["homes"] if row["zone"] == "North")


def test_midland_flash_flood_raises_midland_and_ector_only(tmp_path):
    s = session(tmp_path, "storm-rule-night")
    s.send_alert(MIDLAND_FLOOD)
    expected = {MIDLAND: (60.0, "weather_alert"), ECTOR: (60.0, "weather_alert"),
                TOM_GREEN: (30.0, "not_in_alert"), TAYLOR: (30.0, "not_in_alert")}
    live = 0
    for _ in range(12):                       # 16:05 to 17:00 CT, alert live until 17:30
        s.step()
        tick = s.last["result"]
        assert tick["breaches"] == 0
        if tick["policy_reason"] != "normal":
            continue                          # a fleet-wide reason outranks, tested above
        live += 1
        assert {f: (tick["county_reserve_pct"][f], tick["county_reasons"][f]) for f in expected} == expected
        assert all((row["floor_pct"], row["floor_reason"]) == expected[row["county"]]
                   for row in s.last["homes"] if row["zone"] == "West")
    assert live


def test_homes_get_a_county_round_robin_and_a_display_name(tmp_path):
    s = session(tmp_path, "heather")
    houston = [h for h in s.homes if h.zone == "Houston"]
    assert [h.county for h in houston[:5]] == [HARRIS, FORT_BEND, BRAZORIA, GALVESTON, MONTGOMERY]
    assert {h.county for h in houston[5:10]} == {HARRIS, FORT_BEND, BRAZORIA, GALVESTON, MONTGOMERY}
    assert home_label(next(h for h in s.homes if h.home_id == "home-005")) == "Houston-FortBend-005"
    state = s.state()
    assert state["counties"] == [{"zone": z, "fips": f, "name": n} for z, f, n in zone_counties(s.settings)]
    row = next(r for r in state["homes"] if r["id"] == "home-005")
    assert (row["name"], row["county"], row["county_name"], row["floor_reason"]) == \
        ("Houston-FortBend-005", FORT_BEND, "Fort Bend", "normal")
