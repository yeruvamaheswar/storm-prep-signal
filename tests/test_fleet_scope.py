"""Task 13: /v1/homes and /v1/fleet/rollups read only the configured demo fleet from public.homes.

public.homes may hold 10,000 seeded rows (home-001 .. home-10000). The API shows only the first
FLEET_SIZE of them, by engine id (new_fleet order, so home-1000 is not "before" home-101), and the
filter is in the PostgREST query. The console fixture fallback is labelled with a header. No network.
"""

import re

from fastapi.testclient import TestClient

from server.api.fixtures import FixtureStore
from server.api.homes import fleet_filter, list_homes, read_home, table_rollups
from server.app import create_app
from server.engine.fleet import new_fleet

SETTINGS = {"url": "https://example.supabase.co", "key": "test-key", "timeout_s": 3}
IN_FLEET = re.compile(r"^\(home_id\.in\.\((?P<ids>[^)]*)\)\)$")


class Reply:
    def __init__(self, rows, status_code=200, content_range=None):
        self._rows = rows
        self.ok = True
        self.status_code = status_code
        self.headers = {} if content_range is None else {"content-range": content_range}

    def json(self):
        return self._rows


def row(home_id, zone="South", status="live", assigned_kw=0):
    return {
        "home_id": home_id, "zone": zone, "capacity_kwh": 20, "soc_kwh": 12.0, "max_kw": 5,
        "status": status, "assigned_kw": assigned_kw, "last_seen": "2026-09-26T12:00:00+00:00",
    }


def seeded_table(n=10_000):
    """The real seed: new_fleet(10000) ids, so home-001 .. home-10000."""
    return [row(home.home_id, "South" if i % 2 else "Houston", assigned_kw=1 if i % 5 == 0 else 0)
            for i, home in enumerate(new_fleet(n))]


def postgrest(rows, calls=None):
    """A PostgREST fake that honours and=(home_id.in.(...)), eq filters, order, paging and count=exact."""

    def http_get(url, params=None, headers=None, timeout=None):
        params = dict(params or {})
        headers = headers or {}
        if calls is not None:
            calls.append(params)
        if not url.endswith("/homes"):
            return Reply([])
        out = list(rows)
        if "and" in params:
            match = IN_FLEET.match(params["and"])
            assert match, params["and"]
            allowed = set(match.group("ids").split(","))
            out = [item for item in out if item["home_id"] in allowed]
        for key in ("zone", "status"):
            if params.get(key, "").startswith("eq."):
                out = [item for item in out if item[key] == params[key][3:]]
        if params.get("assigned_kw", "").startswith("gt."):
            out = [item for item in out if float(item["assigned_kw"]) > float(params["assigned_kw"][3:])]
        if params.get("home_id", "").startswith("eq."):
            out = [item for item in out if item["home_id"] == params["home_id"][3:]]
        if params.get("home_id", "").startswith("ilike."):
            needle = params["home_id"][6:].strip("*").lower()
            out = [item for item in out if needle in item["home_id"].lower()]
        if "count=exact" in headers.get("Prefer", ""):
            total = len(out)
            return Reply(out[:1], 206 if out else 200, f"0-0/{total}" if out else f"*/{total}")
        out.sort(key=lambda item: item["home_id"])
        offset = int(params.get("offset") or 0)
        limit = int(params.get("limit") or len(out))
        return Reply(out[offset:offset + limit])

    return http_get


def test_fleet_filter_names_the_engine_ids_in_order():
    body = IN_FLEET.match(fleet_filter(100)["and"]).group("ids").split(",")
    assert body == [home.home_id for home in new_fleet(100)]
    assert body[0] == "home-001" and body[-1] == "home-100"
    assert "home-1000" not in body


def test_list_homes_returns_only_the_fleet_from_a_10k_table():
    calls = []
    homes = list_homes(limit=200, settings=SETTINGS, http_get=postgrest(seeded_table(), calls), fleet_size=100)
    ids = [home["home_id"] for home in homes]
    assert len(ids) == 100
    assert set(ids) == {home.home_id for home in new_fleet(100)}
    # Filtered by the query, not by fetching 10,000 rows and trimming them here.
    assert all("and" in params for params in calls)
    assert all(int(params.get("limit", "0")) <= 200 for params in calls)


def test_list_homes_search_stays_inside_the_fleet():
    homes = list_homes(q="100", limit=200, settings=SETTINGS, http_get=postgrest(seeded_table()), fleet_size=100)
    # home-1000 .. home-1009 and home-10000 exist in the table but are outside the 100-home fleet.
    assert [home["home_id"] for home in homes] == ["home-100"]


def test_list_homes_fleet_size_defaults_to_env(monkeypatch):
    monkeypatch.setenv("FLEET_SIZE", "12")
    homes = list_homes(limit=200, settings=SETTINGS, http_get=postgrest(seeded_table(200)))
    assert len(homes) == 12


def test_read_home_outside_the_fleet_is_none():
    get = postgrest(seeded_table())
    assert read_home("home-1000", settings=SETTINGS, http_get=get, fleet_size=100) is None
    assert read_home("home-101", settings=SETTINGS, http_get=get, fleet_size=100) is None
    assert read_home("home-100", settings=SETTINGS, http_get=get, fleet_size=100)["home_id"] == "home-100"


def test_table_rollups_count_only_the_fleet():
    calls = []
    body = table_rollups(settings=SETTINGS, http_get=postgrest(seeded_table(), calls), fleet_size=100)
    assert body["n"] == 100
    assert body["zones"]["South"]["live"] + body["zones"]["Houston"]["live"] == 100
    assert all("and" in params for params in calls)


def api(monkeypatch, rows, fleet="100"):
    monkeypatch.setenv("FLEET_SIZE", fleet)
    monkeypatch.setattr("server.api.homes.homes_settings", lambda: SETTINGS)
    monkeypatch.setattr("server.api.homes.requests.get", postgrest(rows))
    return TestClient(create_app(FixtureStore()))


def test_homes_route_serves_the_fleet_and_says_supabase(monkeypatch):
    client = api(monkeypatch, seeded_table())
    reply = client.get("/v1/homes", params={"limit": 200})
    assert reply.status_code == 200
    assert isinstance(reply.json(), list)
    assert len(reply.json()) == 100
    assert reply.headers["x-homes-source"] == "supabase"
    assert reply.headers["x-fleet-size"] == "100"
    assert reply.headers["x-homes-total"] == "100"
    assert client.get("/v1/homes/home-007").status_code == 200
    assert client.get("/v1/homes/home-1000").status_code == 404
    assert client.get("/v1/fleet/rollups").json()["n"] == 100


def test_homes_total_counts_fleet_homes_present_in_the_table(monkeypatch):
    # Only 40 of the 100 fleet homes have a row yet: the header says 40, never 100.
    client = api(monkeypatch, seeded_table(40))
    reply = client.get("/v1/homes", params={"limit": 200})
    assert reply.headers["x-homes-total"] == "40"
    assert reply.headers["x-fleet-size"] == "100"


# M2 (Task 13 fix 1): above FLEET_FILTER_MAX_IDS no id filter is sent, so the rows are the whole
# table, not the fleet. Nothing may then claim an N-home fleet scope.

def test_unfiltered_homes_route_claims_no_fleet_scope(monkeypatch):
    client = api(monkeypatch, seeded_table(), fleet="2000")
    reply = client.get("/v1/homes", params={"limit": 200})
    assert reply.status_code == 200
    assert reply.headers["x-homes-source"] == "supabase"
    # "10000 of 2000 homes" would be false: no fleet size, no fleet total.
    assert "x-fleet-size" not in reply.headers
    assert "x-homes-total" not in reply.headers


def test_unfiltered_read_home_still_answers_only_fleet_ids(monkeypatch):
    client = api(monkeypatch, seeded_table(), fleet="2000")
    assert client.get("/v1/homes/home-1500").status_code == 200
    assert client.get("/v1/homes/home-2001").status_code == 404
    assert client.get("/v1/homes/home-9999").status_code == 404


def test_unfiltered_rollups_count_the_fleet_not_the_table(monkeypatch, tmp_path):
    monkeypatch.setattr("server.engine.fleet.FLEET_DIR", tmp_path)
    client = api(monkeypatch, seeded_table(), fleet="2000")
    body = client.get("/v1/fleet/rollups").json()
    # The table holds 10,000 rows; the fleet is 2,000. The table cannot be scoped by id here,
    # so the route answers the engine's own 2,000-home rollup instead of counting the table.
    assert body["n"] == 2000


def test_fixture_fallback_is_labelled(monkeypatch):
    monkeypatch.setenv("FLEET_SIZE", "100")
    monkeypatch.setattr("server.api.homes.homes_settings", lambda: {"url": "", "key": "", "timeout_s": 3})
    reply = TestClient(create_app(FixtureStore())).get("/v1/homes")
    assert reply.status_code == 200
    assert isinstance(reply.json(), list)
    assert reply.headers["x-homes-source"] == "fixture"
    assert reply.headers["x-fleet-size"] == "100"
    assert "x-homes-total" not in reply.headers


def test_cross_origin_page_can_read_the_source_headers(monkeypatch):
    monkeypatch.setenv("CORS_ORIGINS", "https://wall.example")
    monkeypatch.setattr("server.api.homes.homes_settings", lambda: {"url": "", "key": "", "timeout_s": 3})
    reply = TestClient(create_app(FixtureStore())).get("/v1/homes", headers={"Origin": "https://wall.example"})
    exposed = reply.headers.get("access-control-expose-headers", "").lower()
    for name in ("x-homes-source", "x-fleet-size", "x-homes-total"):
        assert name in exposed


# Item 7: counties. public.homes has no county column, so the API derives it with the engine's own
# deterministic rule (fleet.assign_county, round-robin by place within the zone), add-only on each row.

def test_fleet_counties_follow_the_scenario_seed_rule():
    from server.engine.cli import read_settings
    from server.engine.fleet import fleet_counties
    from server.engine.loop import with_fleet_defaults
    from server.engine.scenario import seed_fleet

    settings = with_fleet_defaults({**read_settings(), "fleet_size": 100, "home_kwh": 25.0, "home_max_kw": 11.4})
    seeded = {home.home_id: (home.zone, home.county) for home in seed_fleet(settings, 7)}
    assert fleet_counties(settings) == seeded


def test_live_fleet_counties_use_the_live_zones():
    from server.engine.fleet import ZONE_COUNTIES, fleet_counties, seed_settings

    counties = fleet_counties(seed_settings(100))
    assert [home.home_id for home in new_fleet(100)] == list(counties)
    for home in new_fleet(100):
        zone, fips = counties[home.home_id]
        assert zone == home.zone
        assert fips in {f for f, _ in ZONE_COUNTIES[zone]}
    # Every roster county gets homes in a 100-home fleet (25 per zone over 4 or 5 counties).
    used = {fips for _zone, fips in counties.values()}
    assert used == {f for rows in ZONE_COUNTIES.values() for f, _ in rows}


def test_homes_rows_carry_a_derived_county(monkeypatch):
    from server.engine.fleet import fleet_counties, seed_settings

    client = api(monkeypatch, [row(home.home_id, home.zone) for home in new_fleet(100)])
    homes = client.get("/v1/homes", params={"limit": 200}).json()
    expected = fleet_counties(seed_settings(100))
    assert len(homes) == 100
    for home in homes:
        assert home["county"] == expected[home["home_id"]][1]
        assert home["county_name"]
    one = client.get("/v1/homes/home-005").json()
    assert (one["county"], one["county_name"]) == ("48029", "Bexar")


def test_row_in_a_zone_the_engine_did_not_give_it_has_no_county(monkeypatch):
    # home-001 is South in the Supabase seed. A table row that says North is not relabelled with a guess.
    client = api(monkeypatch, [row("home-001", "North")])
    home = client.get("/v1/homes").json()[0]
    assert home["county"] is None and home["county_name"] is None


def test_fleet_counties_route_is_the_roster(monkeypatch):
    from server.engine.fleet import ZONE_COUNTIES

    monkeypatch.setattr("server.api.homes.homes_settings", lambda: {"url": "", "key": "", "timeout_s": 3})
    body = TestClient(create_app(FixtureStore())).get("/v1/fleet/counties").json()
    assert body == [{"zone": zone, "fips": fips, "name": name}
                    for zone, rows in ZONE_COUNTIES.items() for fips, name in rows]
