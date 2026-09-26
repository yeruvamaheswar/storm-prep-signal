"""scripts/replay_event.py: parse an archived NP3-233-CD CSV and rate one posting. No network."""
import importlib.util
from datetime import datetime
from pathlib import Path

import pytest

from storm_prep.risk import zone_mw

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = Path(__file__).parent / "fixtures" / "np3233_sample.csv"
spec = importlib.util.spec_from_file_location("replay_event", ROOT / "scripts" / "replay_event.py")
replay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(replay)


def test_parse_gives_the_houston_mw():
    rows = replay.read_posting(FIXTURE)
    assert [(row["operatingDate"], row["hourEnding"]) for row in rows] == [
        ("2024-07-08", 1), ("2024-07-08", 2), ("2024-07-08", 3)]
    assert rows[0]["totalResourceMWZoneHouston"] == 2200
    # Houston zone MW = Resource + IRR + NewEquipResource, e.g. 2200 + 500 + 300 in HE1.
    assert [zone_mw(row, "Houston") for row in rows] == [3000, 4200, 3500]


def test_a_posting_is_rated_against_the_baseline_plus_margin():
    rows = replay.read_posting(FIXTURE)
    baseline = {"median_mw_by_lead": [10000.0] * 6}
    risk = replay.rate_posting(rows, datetime(2024, 7, 8, 0, 0, 50), baseline,
                               margin_pct=15, lookahead_hours=6)
    # HE2 totals 12,000 MW against a trigger of 10,000 + 15% = 11,500 MW.
    assert (risk.level, risk.peak_hour, risk.peak_mw, risk.trigger_mw) == ("HIGH", 2, 12000, 11500)
    assert (risk.driving_zone, risk.zone_mw["Houston"]) == ("Houston", 4200)


def test_an_unmapped_total_column_is_rejected(tmp_path):
    odd = tmp_path / "odd.csv"
    lines = FIXTURE.read_text().splitlines()
    odd.write_text("\n".join([lines[0] + ",TotalResourceMW"] + [line + ",9999" for line in lines[1:]]))
    with pytest.raises(ValueError, match="TotalResourceMW"):
        replay.read_posting(odd)
