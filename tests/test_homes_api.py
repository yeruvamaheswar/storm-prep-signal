"""Paged /v1/homes and zone rollups from public.homes. No network."""

import requests
from fastapi.testclient import TestClient

from server.api.fixtures import FixtureStore
from server.api.homes import (
    HomesUnavailable,
    as_console_home,
    list_homes,
    read_home,
    table_rollups,
)
from server.app import create_app

SETTINGS = {"url": "https://example.supabase.co", "key": "test-key", "timeout_s": 3}

CONSOLE_KEYS = (
    "home_id", "status", "capacity_kwh", "soc_kwh", "floor_kwh", "max_kw",
    "assigned_kw", "eligible", "skip_reason", "last_seen", "last_command",
)


class Reply:
    def __init__(self, rows, ok=True, status_code=200, content_range=None):
        self._rows = rows
        self.ok = ok
        self.status_code = status_code
        self.headers = {} if content_range is None else {"content-range": content_range}

    def json(self):
        return self._rows


def row(home_id, zone="South", status="live", assigned_kw=0, soc_kwh=12.0):
    return {
        "home_id": home_id,
        "zone": zone,
        "capacity_kwh": 20,
        "soc_kwh": soc_kwh,
        "max_kw": 5,
        "status": status,
        "assigned_kw": assigned_kw,
        "last_seen": "2026-09-26T12:00:00+00:00",
    }


def fake_get(rows):
    def http_get(url, params=None, headers=None, timeout=None):
        assert url.endswith("/homes")
        assert "apikey" in (headers or {})
        params = params or {}
        out = list(rows)
        select = params.get("select", "")
        if "count()" in select or "sum()" in select:
            return Reply({"code": "PGRST123", "message": "Use of aggregate functions is not allowed"}, ok=False, status_code=400)
        if params.get("zone", "").startswith("eq."):
            out = [item for item in out if item["zone"] == params["zone"][3:]]
        if params.get("status", "").startswith("eq."):
            out = [item for item in out if item["status"] == params["status"][3:]]
        if params.get("assigned_kw", "").startswith("gt."):
            floor = float(params["assigned_kw"][3:])
            out = [item for item in out if float(item["assigned_kw"]) > floor]
        prefer = (headers or {}).get("Prefer", "")
        if "count=exact" in prefer:
            total = len(out)
            shown = out[:1]
            span = f"0-0/{total}" if shown else f"*/{total}"
            return Reply(shown, status_code=206 if shown else 200, content_range=span)
        if params.get("home_id", "").startswith("eq."):
            out = [item for item in out if item["home_id"] == params["home_id"][3:]]
        if params.get("home_id", "").startswith("ilike."):
            needle = params["home_id"][6:].strip("*").lower()
            out = [item for item in out if needle in item["home_id"].lower()]
        out = sorted(out, key=lambda item: item["home_id"])
        offset = int(params.get("offset") or 0)
        limit = int(params.get("limit") or len(out))
        return Reply(out[offset:offset + limit])

    return http_get


def client():
    return TestClient(create_app(FixtureStore()))


def test_missing_config_raises_no_config():
    try:
        list_homes(settings={"url": "", "key": "", "timeout_s": 3})
    except HomesUnavailable as exc:
        assert exc.reason == "no_config"
        return
    raise AssertionError("expected HomesUnavailable")


def test_list_homes_pages_and_filters():
    rows = [
        row("home-001", "South"),
        row("home-002", "North", status="stale"),
        row("home-003", "South", assigned_kw=5),
        row("home-010", "Houston"),
    ]
    page = list_homes(zone="South", limit=1, offset=1, settings=SETTINGS, http_get=fake_get(rows))
    assert [home["home_id"] for home in page] == ["home-003"]
    found = list_homes(q="010", settings=SETTINGS, http_get=fake_get(rows))
    assert [home["home_id"] for home in found] == ["home-010"]


def test_console_home_is_add_only_and_may_include_zone():
    home = as_console_home(row("home-003", "West", assigned_kw=2.5, soc_kwh=4.0))
    for key in CONSOLE_KEYS:
        assert key in home
    assert home["zone"] == "West"
    assert home["eligible"] is False
    assert home["skip_reason"] == "below_floor"
    assert home["last_command"] is None
    assert home["charge_state"] is None
    assert home["power_kw"] is None


def test_console_home_copies_last_reading_when_reported():
    raw = row("home-001", "North", assigned_kw=2.5)
    raw["charge_state"] = "DISCHARGING"
    raw["power_kw"] = 2.5
    home = as_console_home(raw)
    assert home["charge_state"] == "DISCHARGING"
    assert home["power_kw"] == 2.5
    listed = list_homes(settings=SETTINGS, http_get=fake_get([raw]))
    assert listed[0]["charge_state"] == "DISCHARGING"
    assert listed[0]["power_kw"] == 2.5


def test_unknown_charge_state_is_omitted():
    raw = row("home-002")
    raw["charge_state"] = "SPINNING"
    raw["power_kw"] = 1.0
    home = as_console_home(raw)
    assert home["charge_state"] is None
    assert home["power_kw"] == 1.0


def test_read_home_miss_is_none_not_error():
    assert read_home("home-999", settings=SETTINGS, http_get=fake_get([row("home-001")])) is None


def test_table_rollups_use_content_range_not_aggregates():
    rows = [row(f"home-{i:04d}", "South" if i < 8000 else "Houston") for i in range(10_000)]
    calls = []

    inner = fake_get(rows)

    def http_get(url, params=None, headers=None, timeout=None):
        calls.append((params or {}, headers or {}))
        return inner(url, params=params, headers=headers, timeout=timeout)

    body = table_rollups(settings=SETTINGS, http_get=http_get)
    assert body["n"] == 10_000
    assert body["zones"]["South"]["live"] == 8000
    assert body["zones"]["Houston"]["live"] == 2000
    assert not any("count()" in (params.get("select") or "") for params, _headers in calls)
    assert any("count=exact" in headers.get("Prefer", "") for _params, headers in calls)


def test_table_rollups_match_existing_shape():
    rows = [
        row("home-001", "South"),
        row("home-002", "South", assigned_kw=5),
        row("home-003", "North", status="stale"),
        row("home-004", "West", status="dead"),
    ]
    body = table_rollups(settings=SETTINGS, http_get=fake_get(rows))
    assert body["n"] == 4
    assert set(body["zones"]) == {"South", "North", "West", "Houston"}
    assert body["zones"]["South"]["live"] == 2
    assert body["zones"]["South"]["discharging"] == 1
    assert body["zones"]["South"]["discharging_mw"] == 0.005
    assert body["zones"]["North"]["stale"] == 1
    assert body["zones"]["North"]["silent"] == 1
    assert body["zones"]["West"]["dead"] == 1
    assert body["zones"]["Houston"]["live"] == 0
    assert "homes" not in body
    assert "home-001" not in str(body)
    assert body["clusters"][0]["id"] == "South:0"


def test_failed_table_read_falls_back_never_500(monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)
    monkeypatch.setenv("FLEET_SIZE", "100")

    def boom(*_args, **_kwargs):
        raise requests.Timeout()

    monkeypatch.setattr("server.api.homes.homes_settings", lambda: SETTINGS)
    monkeypatch.setattr("server.api.homes.requests.get", boom)
    api = client()
    homes = api.get("/v1/homes")
    rollups = api.get("/v1/fleet/rollups")
    assert homes.status_code == 200
    assert [home["home_id"] for home in homes.json()] == ["home-001", "home-014", "home-003"]
    assert rollups.status_code == 200
    assert rollups.json()["n"] == 100


def test_missing_config_keeps_fixture_filter_and_404(monkeypatch):
    monkeypatch.setattr(
        "server.api.homes.homes_settings",
        lambda: {"url": "", "key": "", "timeout_s": 3},
    )
    api = client()
    homes = api.get("/v1/homes", params={"status": "unconfirmed"}).json()
    assert [home["home_id"] for home in homes] == ["home-014"]
    assert api.get("/v1/homes/home-001").json()["status"] == "live"
    assert api.get("/v1/homes/home-999").status_code == 404


def test_homes_route_pages_from_table(monkeypatch):
    rows = [row(f"home-{i:03d}", "South" if i % 2 else "North") for i in range(1, 61)]
    monkeypatch.setattr("server.api.homes.homes_settings", lambda: SETTINGS)
    monkeypatch.setattr("server.api.homes.requests.get", fake_get(rows))
    api = client()
    default = api.get("/v1/homes").json()
    assert len(default) == 50
    assert default[0]["home_id"] == "home-001"
    clamped = api.get("/v1/homes", params={"limit": 500, "offset": 50}).json()
    assert len(clamped) == 10
    south = api.get("/v1/homes", params={"zone": "South", "limit": 200}).json()
    assert {home["zone"] for home in south} == {"South"}
    assert api.get("/v1/homes/home-007").json()["zone"] == "South"
    assert api.get("/v1/homes/home-999").status_code == 404


def test_rollups_route_uses_table(monkeypatch):
    rows = [row("home-001", "Houston", assigned_kw=10)]
    monkeypatch.setattr("server.api.homes.homes_settings", lambda: SETTINGS)
    monkeypatch.setattr("server.api.homes.requests.get", fake_get(rows))
    body = client().get("/v1/fleet/rollups").json()
    assert body["n"] == 1
    assert body["zones"]["Houston"]["discharging"] == 1
    assert body["zones"]["Houston"]["discharging_mw"] == 0.01
    assert "home_id" not in str(body)
