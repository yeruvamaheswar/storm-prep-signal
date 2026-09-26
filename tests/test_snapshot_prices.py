"""Bind each load zone to its ercot_prices row. Live GET stays LZ_NORTH."""

from datetime import datetime

from server.api.prices import (
    IGNORE_POINTS,
    LOAD_ZONE_POINTS,
    bind_zone_prices,
    price_for_zone,
    price_label_for,
)
from server.api.snapshot import build_snapshot
from server.engine.signal import CENTRAL

INTERVAL = "2024-07-09T00:00:00-05:00"
ROWS = [
    {"settlement_point": "LZ_HOUSTON", "interval_ending": INTERVAL, "price_usd_mwh": 20.63},
    {"settlement_point": "LZ_NORTH", "interval_ending": INTERVAL, "price_usd_mwh": 42.25},
    {"settlement_point": "LZ_SOUTH", "interval_ending": INTERVAL, "price_usd_mwh": 18.5},
    {"settlement_point": "LZ_WEST", "interval_ending": INTERVAL, "price_usd_mwh": 31.1},
    {"settlement_point": "LZ_AEN", "interval_ending": INTERVAL, "price_usd_mwh": 99.0},
    {"settlement_point": "LZ_CPS", "interval_ending": INTERVAL, "price_usd_mwh": 98.0},
    {"settlement_point": "LZ_LCRA", "interval_ending": INTERVAL, "price_usd_mwh": 97.0},
    {"settlement_point": "LZ_RAYBN", "interval_ending": INTERVAL, "price_usd_mwh": 96.0},
    {"settlement_point": "LZ_HOUSTON", "interval_ending": "2024-07-09T00:15:00-05:00", "price_usd_mwh": 1.0},
]


def test_bind_keeps_four_load_zones_at_one_interval():
    bound = bind_zone_prices(ROWS, INTERVAL)
    assert bound == {"Houston": 20.63, "North": 42.25, "South": 18.5, "West": 31.1}
    assert IGNORE_POINTS == {"LZ_AEN", "LZ_CPS", "LZ_LCRA", "LZ_RAYBN"}
    assert set(LOAD_ZONE_POINTS.values()) == {"LZ_HOUSTON", "LZ_NORTH", "LZ_SOUTH", "LZ_WEST"}


def test_price_label_is_ercot_only_when_a_row_exists():
    bound = bind_zone_prices(ROWS, INTERVAL)
    assert price_for_zone(bound, "Houston") == 20.63
    assert price_label_for(bound, "Houston") == "ercot"
    empty = bind_zone_prices([], INTERVAL)
    assert price_for_zone(empty, "Houston") is None
    assert price_label_for(empty, "Houston") == "none"


def test_snapshot_stamps_selected_zone_from_archive_rows(tmp_path, monkeypatch):
    latest = tmp_path / "latest.json"
    latest.write_text(
        '{"run_id":"z","ticks":[{"tick":1,"ts":"2024-07-08T23:55:00-05:00",'
        '"target_mw":0.2,"delivered_mw":0.2,"missed_mw":0.0,"price_usd_mwh":48,'
        '"price_label":"synthetic","reserve_pct":30,"policy_reason":"normal",'
        '"risk_level":"LOW","live_homes":100,"stale_homes":0,"dead_homes":0,'
        '"breaches":0,"reasons":[],"brief":"tape"}]}',
        encoding="utf-8",
    )
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", latest)

    def ingest(_now):
        return {
            "price_usd_mwh": 42.25,
            "price_as_of": INTERVAL,
            "price_rows": ROWS,
            "zone_totals": {"Houston": 3500.0, "North": 9000.0, "South": 2900.0, "West": 2800.0},
            "zone_columns": {},
            "outage_mw": 18200.0,
            "driving_zone": "Houston",
            "zone_mw": 3500.0,
            "as_of": "00:00 CT",
            "age_min": 5,
        }

    north = build_snapshot(now=datetime(2024, 7, 9, 0, 5, tzinfo=CENTRAL), ingest=ingest, zone="North")
    assert north["price_usd_mwh"] == 42.25
    assert north["price_label"] == "ercot"
    assert north["zone_prices"]["Houston"] == 20.63
    houston = build_snapshot(now=datetime(2024, 7, 9, 0, 5, tzinfo=CENTRAL), ingest=ingest, zone="Houston")
    assert houston["price_usd_mwh"] == 20.63
    assert houston["price_label"] == "ercot"
    missing = build_snapshot(
        now=datetime(2024, 7, 9, 0, 5, tzinfo=CENTRAL),
        ingest=lambda _now: {**ingest(_now), "price_rows": [ROWS[1]]},
        zone="Houston",
    )
    assert missing["price_usd_mwh"] is None
    assert missing["price_label"] == "none"
    assert 48 not in missing.values()
    assert 185 not in missing.values()
