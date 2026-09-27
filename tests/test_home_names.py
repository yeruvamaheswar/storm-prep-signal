"""Task 17: one name and one zone per home everywhere, the engine's.

public.homes rows carry the Supabase seed's zone (South first). For the demo fleet the API reports each
home's zone, county and name from the engine's own assignment (ZONES order, Houston first), the same one
Replay and Live seed with. The table itself is never rewritten. No network.
"""

from fastapi.testclient import TestClient

from server.api.fixtures import FixtureStore
from server.api.homes import list_homes, read_home, table_rollups
from server.app import create_app
from server.engine.fleet import new_fleet
from server.engine.scenario import Session, load_catalog
from tests.test_fleet_scope import SETTINGS, postgrest, row

SESSION_SETTINGS = {"margin_pct": 15, "lookahead_hours": 6, "fleet_size": 100, "home_kwh": 25.0,
                    "home_max_kw": 11.4, "base_reserve_pct": 30.0, "storm_reserve_pct": 60.0, "tick_minutes": 5,
                    "telemetry_feed": False}


def seed_table(n=100, status=lambda i: "live"):
    """Rows as scripts/seed_homes.py wrote them: new_fleet(n) with the seed's South-first zones."""
    return [row(home.home_id, home.zone, status=status(i)) for i, home in enumerate(new_fleet(n), start=1)]


def api(monkeypatch, rows, fleet="100"):
    monkeypatch.setenv("FLEET_SIZE", fleet)
    monkeypatch.delenv("ZONES", raising=False)
    monkeypatch.setattr("server.api.homes.homes_settings", lambda: SETTINGS)
    monkeypatch.setattr("server.api.homes.requests.get", postgrest(rows))
    return TestClient(create_app(FixtureStore()))


def test_a_demo_home_has_the_same_zone_county_and_name_in_the_api_as_in_the_scenario(monkeypatch, tmp_path):
    session = Session(dict(SESSION_SETTINGS), load_catalog(), log_dir=tmp_path / "logs")
    session.start("heather", 7)
    scenario = {home["id"]: home for home in session.state()["homes"]}
    client = api(monkeypatch, seed_table())
    listed = {home["home_id"]: home for home in client.get("/v1/homes", params={"limit": 200}).json()}
    assert set(listed) == set(scenario)
    for home_id, want in scenario.items():
        got = listed[home_id]
        assert (got["zone"], got["county"], got["county_name"], got["name"]) == \
            (want["zone"], want["county"], want["county_name"], want["name"]), home_id
    one = client.get("/v1/homes/home-005").json()
    assert (one["zone"], one["county_name"], one["name"]) == ("Houston", "Fort Bend", "Houston-FortBend-005")
    # home-001 is South in the table (the seed) and Houston in the engine: the engine wins.
    assert listed["home-001"]["zone"] == "Houston" and listed["home-001"]["name"] == "Houston-Harris-001"


def test_a_demo_home_has_the_same_zone_in_the_api_as_in_the_live_engine(monkeypatch):
    # The Live worker (scripts/live_cycle.py) seeds with read_settings() and loop.run -> new_fleet(settings).
    from server.engine.cli import read_settings
    from server.engine.loop import with_fleet_defaults

    client = api(monkeypatch, seed_table())
    live = with_fleet_defaults({**read_settings(), "fleet_size": 100})
    engine = {home.home_id: home.zone for home in new_fleet(live)}
    listed = {home["home_id"]: home for home in client.get("/v1/homes", params={"limit": 200}).json()}
    assert {home_id: home["zone"] for home_id, home in listed.items()} == engine
    for home_id in ("home-001", "home-002", "home-100"):
        assert client.get(f"/v1/homes/{home_id}").json()["zone"] == engine[home_id]


def test_zone_filter_follows_the_engine_zone():
    homes = list_homes(zone="Houston", limit=200, settings=SETTINGS, http_get=postgrest(seed_table()), fleet_size=100)
    ids = [home["home_id"] for home in homes]
    assert len(ids) == 25
    assert ids[:3] == ["home-001", "home-005", "home-009"]
    assert {home["zone"] for home in homes} == {"Houston"}


def test_floor_uses_the_engine_zone():
    home = read_home("home-001", settings=SETTINGS, http_get=postgrest(seed_table()), fleet_size=100,
                     reserve_pct=30.0, zone_reserve_pct={"Houston": 60.0})
    assert home["zone"] == "Houston"
    assert home["floor_kwh"] == 20 * 60 / 100


def test_rollups_count_by_the_engine_zone():
    # Every 4th home from home-001 is dead: all Houston in the engine, all South in the seed's order.
    rows = seed_table(status=lambda i: "dead" if i % 4 == 1 else "live")
    body = table_rollups(settings=SETTINGS, http_get=postgrest(rows), fleet_size=100)
    assert body["n"] == 100
    assert body["zones"]["Houston"]["dead"] == 25 and body["zones"]["Houston"]["live"] == 0
    assert body["zones"]["South"]["dead"] == 0 and body["zones"]["South"]["live"] == 25


def test_rollups_discharging_mw_by_the_engine_zone():
    rows = seed_table()
    for item in rows:
        if item["home_id"] == "home-001":
            item["assigned_kw"] = 4.0
    body = table_rollups(settings=SETTINGS, http_get=postgrest(rows), fleet_size=100)
    assert body["zones"]["Houston"]["discharging"] == 1
    assert body["zones"]["Houston"]["discharging_mw"] == 0.004
    assert body["zones"]["South"]["discharging"] == 0


def test_supabase_rows_are_only_read(monkeypatch):
    rows = seed_table()
    before = [dict(item) for item in rows]
    client = api(monkeypatch, rows)
    client.get("/v1/homes", params={"limit": 200})
    client.get("/v1/fleet/rollups")
    assert rows == before


def test_the_zones_setting_orders_the_zones_as_it_does_for_the_engine(monkeypatch):
    monkeypatch.setenv("ZONES", "North:48113,Houston:48201,South:48355,West:48329")
    home = read_home("home-001", settings=SETTINGS, http_get=postgrest(seed_table()), fleet_size=100)
    assert (home["zone"], home["county_name"], home["name"]) == ("North", "Dallas", "North-Dallas-001")


def test_above_the_id_cap_the_table_zone_stays(monkeypatch):
    # FLEET_SIZE above FLEET_FILTER_MAX_IDS: no id filter, so today's behaviour: the table's zone, no name.
    client = api(monkeypatch, seed_table(2000), fleet="2000")
    homes = {home["home_id"]: home for home in client.get("/v1/homes", params={"limit": 200}).json()}
    assert homes["home-001"]["zone"] == "South"
    assert "name" not in homes["home-001"]
