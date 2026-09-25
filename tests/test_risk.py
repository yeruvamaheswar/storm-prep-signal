"""Edge cases for the risk rule, using small synthetic postings."""
from storm_prep.risk import ZONES, compute_risk, zone_fields


def make_signal(totals):
    """A synthetic posting whose first row is the current hour.

    Each hour's whole total sits in one field, so hour_total equals the number given.
    """
    rows = []
    for index, total in enumerate(totals):
        row = {field: 0 for zone in ZONES for field in zone_fields(zone)}
        row["totalResourceMWZoneNorth"] = total
        row["operatingDate"] = f"2026-01-{1 + index // 24:02d}"
        row["hourEnding"] = index % 24 + 1
        rows.append(row)
    return {"posted_at": None, "current_date": "2026-01-01", "current_hour_ending": 1, "rows": rows}


def test_peak_exactly_on_trigger_is_high():
    # The median is 1000, so the trigger is exactly 1200.
    risk = compute_risk(make_signal([1200] + [1000] * 47), margin_pct=20, lookahead_hours=6)
    assert risk.trigger_mw == 1200
    assert risk.level == "HIGH"


def test_peak_one_mw_below_trigger_is_low():
    risk = compute_risk(make_signal([1199] + [1000] * 47), margin_pct=20, lookahead_hours=6)
    assert risk.margin_mw == -1
    assert risk.level == "LOW"


def test_peak_at_hour_six_of_window_is_caught():
    # The spike is the 6th hour of the window; the bigger hour right after it is outside the window.
    totals = [1000] * 5 + [1300] + [5000] + [1000] * 41
    risk = compute_risk(make_signal(totals), margin_pct=20, lookahead_hours=6)
    assert (risk.peak_mw, risk.peak_hour) == (1300, 6)
    assert risk.level == "HIGH"
