"""Edge cases for the risk rule, using small synthetic postings."""
import json

import pytest

from storm_prep.baseline import BaselineError, load_baseline
from storm_prep.risk import ZONES, compute_risk, zone_fields

FLAT = {"median_mw_by_lead": [1000] * 6}  # example, not real data


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
    # The typical total is 1000 at every lead, so the trigger is exactly 1150.
    risk = compute_risk(make_signal([1150] + [1000] * 47), FLAT, margin_pct=15, lookahead_hours=6)
    assert risk.trigger_mw == 1150
    assert risk.level == "HIGH"


def test_peak_one_mw_below_trigger_is_low():
    risk = compute_risk(make_signal([1149] + [1000] * 47), FLAT, margin_pct=15, lookahead_hours=6)
    assert risk.margin_mw == -1
    assert risk.level == "LOW"


def test_peak_at_hour_six_of_window_is_caught():
    # The spike is the 6th hour of the window; the bigger hour right after it is outside the window.
    totals = [1000] * 5 + [1150] + [5000] + [1000] * 41
    risk = compute_risk(make_signal(totals), FLAT, margin_pct=15, lookahead_hours=6)
    assert (risk.peak_mw, risk.peak_hour, risk.peak_lead) == (1150, 6, 5)
    assert risk.level == "HIGH"


def test_each_hour_is_compared_with_its_own_lead():
    # Every hour has the same total, but +5 h is usually lower, so that hour stands out most.
    baseline = {"median_mw_by_lead": [1000, 1000, 1000, 1000, 1000, 900]}
    risk = compute_risk(make_signal([1100] * 48), baseline, margin_pct=15, lookahead_hours=6)
    assert (risk.peak_lead, risk.baseline_mw, risk.trigger_mw) == (5, 900, 1035)
    assert risk.level == "HIGH"


def test_missing_baseline_file_is_named(tmp_path):
    with pytest.raises(ValueError, match="baseline file missing"):
        load_baseline(tmp_path / "nope.json")


def test_short_baseline_file_is_rejected(tmp_path):
    path = tmp_path / "short.json"
    path.write_text(json.dumps({"median_mw_by_lead": [1000] * 5}))
    with pytest.raises(ValueError, match="baseline too short: 5 lead hours"):
        load_baseline(path, lookahead_hours=6)


def test_broken_baseline_json_is_a_setup_error(tmp_path):
    path = tmp_path / "broken.json"
    path.write_text('{"median_mw_by_lead": [1000, 1000,')
    with pytest.raises(BaselineError, match="baseline file is not valid JSON"):
        load_baseline(path)
