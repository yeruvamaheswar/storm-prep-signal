"""scripts/check_margin.py: baseline and HIGH counts from Supabase posting rows. No network."""
import importlib.util
from datetime import date, datetime
from pathlib import Path

import pytest

from server.engine.risk import CATEGORIES, ZONES

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("check_margin", ROOT / "scripts" / "check_margin.py")
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


@pytest.fixture
def no_network(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("the test tried to reach the network")
    monkeypatch.setattr(check.requests, "get", refuse)


def hour(day, hour_ending, houston_mw):
    """One payload row: every outage field 0 except Houston Resource."""
    row = {"operatingDate": day, "hourEnding": hour_ending}
    row.update({f"total{category}MWZone{zone}": 0.0 for category in CATEGORIES for zone in ZONES})
    row["totalResourceMWZoneHouston"] = houston_mw
    return row


def posting(posted, mws):
    """A posting made at `posted` whose hours, from its own hour on, total `mws`."""
    day = posted.date().isoformat()
    return posted, [hour(day, posted.hour + 1 + lead, mw) for lead, mw in enumerate(mws)]


def test_row_time_is_central_and_hours_are_sorted(no_network):
    row = {"posted_at": "2026-08-25T05:00:47+00:00",
           "payload": [hour("2026-08-25", 2, 1.0), hour("2026-08-25", 1, 1.0)]}

    posted, rows = check.to_posting(row)

    assert posted == datetime(2026, 8, 25, 0, 0, 47)
    assert [row["hourEnding"] for row in rows] == [1, 2]


def test_baseline_is_the_median_at_each_lead_from_the_posting_hour(no_network):
    postings = [posting(datetime(2024, 6, 10, 0, 1), [100, 200, 300, 400, 500, 600]),
                posting(datetime(2024, 6, 10, 1, 1), [300, 400, 500, 600, 700, 800]),
                posting(datetime(2024, 6, 10, 2, 1), [200, 300, 400, 500, 600, 700]),
                # Looks only 5 hours ahead, so it is left out like in make_baseline.
                posting(datetime(2024, 6, 10, 3, 1), [9999] * 5)]

    baseline = check.build_baseline(postings)

    assert baseline == {"postings": 3, "median_mw_by_lead": [200.0, 300.0, 400.0, 500.0, 600.0, 700.0]}


def test_high_counts_change_with_the_margin(no_network):
    baseline = {"median_mw_by_lead": [1000.0] * 6}
    postings = [posting(datetime(2024, 7, 8, 0, 1), [1120] * 6),
                posting(datetime(2024, 7, 8, 1, 1), [1180] * 6),
                posting(datetime(2024, 7, 8, 2, 1), [1000] * 6)]

    by_margin = check.count_high(postings, baseline, [10, 15, 20], lookahead_hours=6)

    assert by_margin["10"] == {"high": 2, "first_high": "2024-07-08T00:01:00", "last_high": "2024-07-08T01:01:00"}
    assert by_margin["15"] == {"high": 1, "first_high": "2024-07-08T01:01:00", "last_high": "2024-07-08T01:01:00"}
    assert by_margin["20"] == {"high": 0, "first_high": None, "last_high": None}


def test_storm_week_uses_the_days_before_it_as_baseline(no_network):
    calm = [posting(datetime(2024, 7, 4, h, 1), [1000] * 6) for h in range(3)]
    storm = [posting(datetime(2024, 7, 8, 0, 1), [1200] * 6),
             # Its own hour is missing, so compute_risk cannot rate it.
             (datetime(2024, 7, 8, 5, 1), [hour("2024-07-08", 9, 5000.0)])]
    span = (date(2024, 7, 5), date(2024, 7, 11), date(2024, 6, 5), date(2024, 7, 4))

    result = check.check_event(calm + storm, span, [15], lookahead_hours=6)

    assert (result["baseline_postings"], result["in_sample"]) == (3, False)
    assert (result["rated"], result["skipped"]) == (1, 1)
    assert result["by_margin"]["15"]["high"] == 1


def test_calm_month_is_marked_in_sample(no_network):
    assert check.windows()["tuning-2026"] == (date(2026, 8, 25), date(2026, 9, 25),
                                              date(2026, 8, 25), date(2026, 9, 25))
    assert check.windows()["beryl"][2:] == (date(2024, 6, 5), date(2024, 7, 4))


def test_missing_config_skips_without_fetching(tmp_path, monkeypatch, capsys, no_network):
    monkeypatch.setattr(check, "ENV_PATH", tmp_path / "missing.env")
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)

    assert check.main([]) == 0
    assert capsys.readouterr().out == "skipped: no_config\n"
