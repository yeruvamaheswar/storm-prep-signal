"""The wall's zone_intent and zone_prices always agree, and a storm zone never shows discharge."""
import json
from datetime import datetime

from server.api.snapshot import build_snapshot
from server.engine.signal import CENTRAL

INTERVAL = "2024-07-09T00:00:00-05:00"
# Every load zone in the sell band, so the price-only recompute would say discharge everywhere.
HIGH_ROWS = [
    {"settlement_point": point, "interval_ending": INTERVAL, "price_usd_mwh": 250.0}
    for point in ("LZ_HOUSTON", "LZ_NORTH", "LZ_SOUTH", "LZ_WEST")
]
ZONES = ("Houston", "North", "South", "West")


def write_run(tmp_path, monkeypatch, **tick_fields):
    tick = {
        "tick": 1, "ts": "2024-07-08T23:55:00-05:00", "mode": "AUTO", "target_mw": 0.2,
        "delivered_mw": 0.2, "missed_mw": 0.0, "price_usd_mwh": 250, "price_label": "ercot",
        "reserve_pct": 30, "policy_reason": "normal", "risk_level": "LOW", "live_homes": 100,
        "stale_homes": 0, "dead_homes": 0, "breaches": 0, "reasons": [], "brief": "tape",
        **tick_fields,
    }
    latest = tmp_path / "latest.json"
    latest.write_text(json.dumps({"run_id": "z", "ticks": [tick]}), encoding="utf-8")
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", latest)


def ingest(_now):
    return {
        "price_usd_mwh": 250.0,
        "price_as_of": INTERVAL,
        "price_rows": HIGH_ROWS,
        "zone_totals": {"Houston": 3500.0, "North": 9000.0, "South": 2900.0, "West": 2800.0},
        "zone_columns": {},
        "outage_mw": 18200.0,
        "driving_zone": "Houston",
        "zone_mw": 3500.0,
        "as_of": "00:00 CT",
        "age_min": 5,
    }


def snapshot():
    return build_snapshot(now=datetime(2024, 7, 9, 0, 5, tzinfo=CENTRAL), ingest=ingest)


def test_a_weather_alert_zone_never_shows_discharge_when_the_tick_has_no_zone_intent(tmp_path, monkeypatch):
    write_run(tmp_path, monkeypatch, zone_reasons={"Houston": "weather_alert", "North": "normal"})
    body = snapshot()
    assert body["zone_intent"]["Houston"] == "hold"
    # A zone with no storm reason follows the recomputed price band.
    assert body["zone_intent"]["North"] == "discharge"
    # The recompute read the live prices, so those are the prices shown beside it.
    assert body["zone_prices"] == {zone: 250.0 for zone in ZONES}


def test_every_storm_reason_forces_hold_in_the_fallback(tmp_path, monkeypatch):
    reasons = {"Houston": "storm_risk_high", "North": "signal_unavailable", "South": "weather_alert"}
    write_run(tmp_path, monkeypatch, zone_reasons=reasons)
    body = snapshot()
    for zone in reasons:
        assert body["zone_intent"][zone] != "discharge", zone


def test_the_ticks_own_zone_intent_keeps_the_ticks_own_zone_prices(tmp_path, monkeypatch):
    intent = {"Houston": "charge", "North": "hold", "South": "charge", "West": "hold"}
    prices = {"Houston": 12.0, "North": 40.0, "South": 15.0, "West": 30.0}
    write_run(tmp_path, monkeypatch, zone_intent=intent, zone_prices=prices)
    body = snapshot()
    assert body["zone_intent"] == intent
    # Not the $250 rows the snapshot just read: those would say discharge beside a charge intent.
    assert body["zone_prices"] == prices


def test_a_tick_intent_without_its_prices_shows_no_prices_rather_than_mismatched_ones(tmp_path, monkeypatch):
    intent = {"Houston": "charge", "North": "hold", "South": "charge", "West": "hold"}
    write_run(tmp_path, monkeypatch, zone_intent=intent)
    body = snapshot()
    assert body["zone_intent"] == intent
    assert body["zone_prices"] == {}
