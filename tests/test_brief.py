"""write_brief builds one or two sentences from TickResult fields only."""
from server.engine.brief import apply_tick_brief, write_brief
from server.engine.contracts import TickResult


def tick(**over):
    row = TickResult(
        tick=5,
        ts="2026-09-25T12:20:00-05:00",
        mode="AUTO",
        target_mw=0.40,
        target_label="synthetic",
        delivered_mw=0.31,
        missed_mw=0.09,
        price_usd_mwh=185.0,
        price_label="synthetic",
        reserve_pct=60.0,
        policy_reason="storm_risk_high",
        risk_level="HIGH",
        live_homes=100,
        stale_homes=0,
        dead_homes=0,
        breaches=0,
        reasons=["storm_reserve", "fleet_headroom_short"],
    )
    for key, value in over.items():
        setattr(row, key, value)
    return row


def test_storm_tick_names_the_codes_not_the_tape_prose():
    text = write_brief(tick())
    assert text == (
        "Delivered 0.31 of 0.40 MW. Storm reserve raised; not enough headroom above the floor."
    )
    assert "missed on purpose" not in text
    assert "synthetic" not in text
    assert "tape tick" not in text


def test_dead_and_stale_homes_use_the_counted_codes():
    text = write_brief(
        tick(
            delivered_mw=0.22,
            missed_mw=0.18,
            dead_homes=20,
            stale_homes=10,
            live_homes=70,
            reasons=["storm_reserve", "homes_dead:20", "homes_stale:10", "fleet_headroom_short"],
        )
    )
    assert text == (
        "Delivered 0.22 of 0.40 MW. Storm reserve raised; 20 homes are dead; "
        "10 homes are stale; not enough headroom above the floor."
    )


def test_signal_unavailable_is_named_even_when_reasons_only_say_storm_reserve():
    text = write_brief(
        tick(
            delivered_mw=0.20,
            missed_mw=0.00,
            target_mw=0.20,
            reserve_pct=60.0,
            policy_reason="signal_unavailable",
            risk_level=None,
            reasons=["storm_reserve"],
        )
    )
    assert text == "Delivered 0.20 of 0.20 MW. Storm signal could not be read; storm reserve raised."


def test_apply_tick_brief_replaces_tape_prose():
    stamped = apply_tick_brief(
        {
            "delivered_mw": 0.31,
            "target_mw": 0.40,
            "reserve_pct": 60,
            "policy_reason": "storm_risk_high",
            "reasons": ["storm_reserve", "fleet_headroom_short"],
            "brief": "0.09 MW missed on purpose. tape tick 5/12",
        }
    )
    assert stamped["brief"] == (
        "Delivered 0.31 of 0.40 MW. Storm reserve raised; not enough headroom above the floor."
    )
    assert stamped["reasons"] == ["storm_reserve", "fleet_headroom_short"]
    assert "missed on purpose" not in stamped["brief"]
    assert "tape tick" not in stamped["brief"]


def test_clear_tick_names_the_floor_and_has_no_reason_clause():
    text = write_brief(
        tick(
            delivered_mw=0.20,
            missed_mw=0.00,
            target_mw=0.20,
            reserve_pct=30.0,
            policy_reason="normal",
            risk_level="LOW",
            reasons=[],
        )
    )
    assert text == "Delivered 0.20 of 0.20 MW. Floor 30%."


def test_zone_floor_above_the_fleet_floor_is_named_before_the_reasons():
    text = write_brief(
        tick(
            delivered_mw=0.40,
            missed_mw=0.00,
            reserve_pct=30.0,
            policy_reason="normal",
            risk_level="LOW",
            reasons=["timed_out:1"],
            zone_reserve_pct={"Houston": 60.0, "North": 30.0},
            zone_reasons={"Houston": "weather_alert", "North": "normal"},
        )
    )
    assert text == "Delivered 0.40 of 0.40 MW. Floor 30% (Houston 60%: weather_alert); timed out 1."


def test_live_brief_names_a_zone_floor_from_the_tick_dict():
    stamped = apply_tick_brief(
        {
            "delivered_mw": 0.40,
            "target_mw": 0.40,
            "reserve_pct": 30,
            "policy_reason": "normal",
            "reasons": [],
            "zone_reserve_pct": {"Houston": 60, "North": 30},
            "zone_reasons": {"Houston": "weather_alert", "North": "normal"},
        }
    )
    assert stamped["brief"] == "Delivered 0.40 of 0.40 MW. Floor 30% (Houston 60%: weather_alert)."


def test_charging_code_reads_as_charging_on_cheap_power():
    # calm-charge tick 1 used to print a bare "charging." after the delivered sentence.
    text = write_brief(
        tick(
            delivered_mw=0.02,
            missed_mw=0.00,
            target_mw=0.02,
            reserve_pct=30.0,
            policy_reason="normal",
            risk_level="LOW",
            reasons=["charging"],
        )
    )
    assert text == "Delivered 0.02 of 0.02 MW. Charging on cheap power."


# Engine ticks (scenario Session in-process, seed 42, HOME_MAX_KW=11.4, HOME_KWH=25). BERYL_22 is from the merged
# engine with #47; Harris's county reason is written as the engine sends it since 2026-09-27 (same floors).
BERYL_22 = dict(
    delivered_mw=0.02, missed_mw=0.0, target_mw=0.02, reserve_pct=30.0, policy_reason="normal", risk_level="LOW",
    reasons=["charging", "homes_stale:1"],
    zone_reserve_pct={"Houston": 60.0, "North": 30.0, "South": 30.0, "West": 30.0},
    zone_reasons={"Houston": "weather_alert", "North": "normal", "South": "normal", "West": "normal"},
    county_reserve_pct={"48201": 60.0, "48157": 30.0, "48039": 30.0, "48167": 30.0, "48339": 30.0},
    county_reasons={"48201": "weather_alert", "48157": "not_in_alert", "48039": "not_in_alert",
                    "48167": "not_in_alert", "48339": "not_in_alert"},
)
# heather tick 2 after both freeze alerts (2026-09-27 named-county rule): all nine named counties keep 60%.
HEATHER_2 = dict(
    delivered_mw=0.2, missed_mw=0.0, target_mw=0.2, reserve_pct=30.0, policy_reason="normal", risk_level="LOW",
    reasons=["reserve_refill", "homes_stale:2"],
    zone_reserve_pct={"Houston": 60.0, "North": 60.0, "South": 30.0, "West": 30.0},
    zone_reasons={"Houston": "weather_alert", "North": "weather_alert", "South": "normal", "West": "normal"},
    county_reserve_pct={f: 60.0 for f in ("48201", "48157", "48039", "48167", "48339", "48113", "48439", "48085", "48121")},
    county_reasons={f: "weather_alert" for f in ("48201", "48157", "48039", "48167", "48339", "48113", "48439", "48085", "48121")},
)


def test_a_zone_whose_counties_keep_different_floors_names_the_range_and_the_raised_county():
    # beryl tick 22: the alert names only Harris, so Harris keeps 60%; the other four Houston counties keep 30%.
    text = write_brief(tick(**BERYL_22))
    assert text == ("Delivered 0.02 of 0.02 MW. Floor 30% (Houston 30–60% by county: Harris raised, NWS weather alert); "
                    "charging on cheap power; 1 home is stale.")
    assert "Houston 60%: weather_alert" not in text


def test_zones_whose_every_county_is_named_keep_the_plain_zone_note():
    # heather tick 2: every roster county of Houston and North is named, so no county range is written.
    text = write_brief(tick(**HEATHER_2))
    assert text == ("Delivered 0.20 of 0.20 MW. Floor 30% (Houston 60%: weather_alert, North 60%: weather_alert); "
                    "refilling batteries under their reserve floor; 2 homes are stale.")


def test_counties_the_alert_does_not_name_are_not_called_raised():
    # storm-rule-night tick 2 after the Midland alert: Midland and Ector named (60%); Tom Green and Taylor not (30%).
    text = write_brief(tick(
        delivered_mw=0.02, missed_mw=0.0, target_mw=0.02, reserve_pct=30.0, policy_reason="normal", risk_level="LOW",
        reasons=["charging", "reserve_refill", "homes_stale:2"],
        zone_reserve_pct={"Houston": 30.0, "North": 30.0, "South": 30.0, "West": 60.0},
        zone_reasons={"Houston": "normal", "North": "normal", "South": "normal", "West": "weather_alert"},
        county_reserve_pct={"48329": 60.0, "48135": 60.0, "48451": 30.0, "48441": 30.0},
        county_reasons={"48329": "weather_alert", "48135": "weather_alert", "48451": "not_in_alert", "48441": "not_in_alert"},
    ))
    assert text == ("Delivered 0.02 of 0.02 MW. Floor 30% (West 30–60% by county: Midland and Ector raised, NWS weather alert); "
                    "charging on cheap power; refilling batteries under their reserve floor; 2 homes are stale.")


def test_live_brief_reads_the_county_floors_from_the_tick_dict():
    view = {**BERYL_22, "brief": "tape prose"}
    stamped = apply_tick_brief(view)
    assert "Houston 30–60% by county: Harris raised, NWS weather alert" in stamped["brief"]
    assert "North 60%: weather_alert" in apply_tick_brief({**HEATHER_2})["brief"]
