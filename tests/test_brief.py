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
