"""Day-Ahead Market (NP4-190-CD) reader, window, fetch and backtest scoring. No test calls ERCOT."""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import requests

from server.engine.signal import (
    CENTRAL,
    SignalUnavailable,
    dam_hour_start,
    dam_window,
    fetch_dam_prices,
    read_dam_prices,
)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from backtest_dam import score_day  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
FIELDS = [{"name": "deliveryDate"}, {"name": "hourEnding"}, {"name": "settlementPoint"},
          {"name": "settlementPointPrice"}, {"name": "DSTFlag"}]
SECRETS = {"ERCOT_USERNAME": "user-SECRET-1", "ERCOT_PASSWORD": "pass-SECRET-2",
           "ERCOT_SUBSCRIPTION_KEY": "key-SECRET-3"}


def body(rows, fields=FIELDS):
    return {"fields": fields, "data": rows}


def test_read_dam_prices_keys_by_field_name_and_keeps_only_load_zones():
    # Columns in a different order from the real reply; the reader must not care.
    fields = [FIELDS[3], FIELDS[2], FIELDS[0], FIELDS[1], FIELDS[4]]
    raw = body([[12.5, "LZ_NORTH", "2026-08-30", "01:00", False],
                [99.0, "LZ_AEN", "2026-08-30", "01:00", False],
                [11.0, "LZ_NORTH", "2026-08-30", "02:00", False]], fields)
    hours = read_dam_prices([raw])
    assert list(hours) == ["North"]
    assert [usd for _, usd in hours["North"]] == [12.5, 11.0]


def test_hour_ending_one_starts_at_midnight_central_and_24_at_23():
    first = dam_hour_start("2026-08-30", "01:00", False)
    last = dam_hour_start("2026-08-30", "24:00", False)
    assert first.astimezone(CENTRAL) == datetime(2026, 8, 30, 0, 0, tzinfo=CENTRAL)
    assert last.astimezone(CENTRAL).hour == 23


def test_dst_flag_marks_the_repeated_fall_back_hour():
    # 2026-11-01: 01:00-02:00 Central happens twice. The flagged row is the second (CST) one.
    first = dam_hour_start("2026-11-01", "02:00", False)
    repeat = dam_hour_start("2026-11-01", "02:00", True)
    assert repeat - first == timedelta(hours=1)
    raw = body([["2026-11-01", "02:00", "LZ_WEST", 20.0, False],
                ["2026-11-01", "02:00", "LZ_WEST", 18.0, True]])
    assert [usd for _, usd in read_dam_prices([raw])["West"]] == [20.0, 18.0]


def test_read_dam_prices_rejects_a_broken_row():
    with pytest.raises(SignalUnavailable):
        read_dam_prices([body([["2026-08-30", "01:00", "LZ_NORTH", "not a number", False]])])


def day_rows(point, day, prices):
    return [[day, f"{he:02d}:00", point, usd, False] for he, usd in enumerate(prices, start=1)]


def test_window_runs_from_the_current_hour_for_24_hours():
    today = day_rows("LZ_NORTH", "2026-08-30", [float(h) for h in range(24)])
    tomorrow = day_rows("LZ_NORTH", "2026-08-31", [100.0 + h for h in range(24)])
    hours = read_dam_prices([body(today + tomorrow)])
    window = dam_window(hours, datetime(2026, 8, 30, 14, 20, tzinfo=CENTRAL))
    north = window["North"]
    assert len(north) == 24
    assert north[0] == {"hour_start": "2026-08-30T14:00-05:00", "usd_mwh": 14.0}
    assert north[-1]["hour_start"] == "2026-08-31T13:00-05:00"


def test_window_holds_only_the_hours_published_so_far():
    # Before 13:30 only today's file is on the frame: the window stops at midnight.
    hours = read_dam_prices([body(day_rows("LZ_NORTH", "2026-08-30", [20.0] * 24))])
    window = dam_window(hours, datetime(2026, 8, 30, 9, 0, tzinfo=CENTRAL))
    assert len(window["North"]) == 15


def test_window_drops_a_zone_missing_the_current_hour():
    hours = read_dam_prices([body(day_rows("LZ_SOUTH", "2026-08-31", [20.0] * 24))])
    assert dam_window(hours, datetime(2026, 8, 30, 23, 30, tzinfo=CENTRAL)) == {}
    assert dam_window(hours, datetime(2026, 8, 31, 0, 0, tzinfo=timezone.utc)) == {}


def test_saved_fixture_reads_as_four_zones_of_24_hours():
    raw = json.loads((ROOT / "data" / "fixtures" / "dam" / "np4_190_cd_20260830.json").read_text())
    hours = read_dam_prices([raw])
    assert sorted(hours) == ["Houston", "North", "South", "West"]
    assert all(len(values) == 24 for values in hours.values())
    assert raw["source"].startswith("ERCOT NP4-190-CD")


class FakeResponse:
    def __init__(self, status_code, text):
        self.status_code = status_code
        self.text = text


def test_fetch_dam_prices_merges_four_zones_and_keeps_secrets_out(monkeypatch):
    for name, value in SECRETS.items():
        monkeypatch.setenv(name, value)
    asked = []

    def fake_get(url, params, headers, timeout):
        asked.append(params["settlementPoint"])
        return FakeResponse(200, json.dumps(body(day_rows(params["settlementPoint"], "2026-08-30", [1.0]))))

    monkeypatch.setattr(requests, "get", fake_get)
    merged = fetch_dam_prices({"fetch_timeout_s": 3}, "2026-08-30", id_token="token")
    assert asked == ["LZ_HOUSTON", "LZ_NORTH", "LZ_SOUTH", "LZ_WEST"]
    assert len(merged["data"]) == 4 and merged["delivery_date"] == "2026-08-30"

    monkeypatch.setattr(requests, "get", lambda *a, **k: FakeResponse(500, "boom"))
    with pytest.raises(SignalUnavailable) as err:
        fetch_dam_prices({"fetch_timeout_s": 3}, "2026-08-30", id_token="token")
    assert "SECRET" not in str(err.value)


def test_score_day_compares_dam_choice_with_hindsight_and_the_band():
    hours = [datetime(2026, 8, 30, h, tzinfo=CENTRAL) for h in range(4)]
    dam = dict(zip(hours, [10.0, 30.0, 12.0, 40.0]))
    rt = dict(zip(hours, [20.0, 5.0, 22.0, 50.0]))
    row = score_day(dam, rt, 2)
    assert row["hit"] == 0.5            # DAM picked hours 0 and 2; the real cheapest were 1 and 0
    assert row["dam"] == 21.0 and row["best"] == 12.5
    assert row["band"] == 12.5          # the first two hours at or under $25 are hours 0 and 1
    assert score_day(dam, rt, 4)["band"] is None
