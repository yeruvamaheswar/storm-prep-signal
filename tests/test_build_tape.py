"""scripts/build_tape.py: tape frames and posting fixtures from Supabase rows. No network."""
import argparse
import importlib.util
import json
from datetime import datetime
from pathlib import Path

import pytest

from server.engine.signal import CENTRAL, load_signal, to_signal

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("build_tape", ROOT / "scripts" / "build_tape.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


@pytest.fixture
def no_network(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("the test tried to reach the network")
    monkeypatch.setattr(build.requests, "get", refuse)


def central(*parts):
    return datetime(*parts, tzinfo=CENTRAL)


def posting(posted):
    """A posting the way check_margin.to_posting returns it: naive Central time, rows oldest first."""
    day = posted.date().isoformat()
    return posted, [{"operatingDate": day, "hourEnding": posted.hour + 1 + lead, "totalResourceMWZoneHouston": 10.0}
                    for lead in range(2)]


POSTINGS = [posting(datetime(2024, 1, 15, 12, 3, 35)), posting(datetime(2024, 1, 15, 13, 3, 35))]
# Interval-ending times: 13:00 covers 12:45-13:00, 13:15 covers 13:00-13:15.
PRICES = [(central(2024, 1, 15, 13, 0), 80.0), (central(2024, 1, 15, 13, 15), 95.5)]


def test_frames_carry_labels_and_an_offset(no_network):
    frames, _ = build.build_frames(POSTINGS, PRICES, central(2024, 1, 15, 12, 50),
                                   central(2024, 1, 15, 13, 20), 5, "LZ_HOUSTON")

    assert [frame["tick"] for frame in frames] == list(range(1, 8))
    assert all((frame["target_mw"], frame["target_label"]) == (0.2, "synthetic") for frame in frames)
    assert frames[0]["ts"] == "2024-01-15T12:50:00-06:00"
    assert all(datetime.fromisoformat(frame["ts"]).utcoffset() is not None for frame in frames)
    # 13:15 and 13:20 fall in an interval Supabase did not return, so they carry no price and say so.
    assert [frame["price_label"] for frame in frames[-2:]] == ["none", "none"]
    assert all(frame["price_label"] == "recorded:ERCOT NP6-905-CD LZ_HOUSTON" for frame in frames[:-2])


def test_risk_fixture_is_the_latest_posting_at_or_before_the_frame(no_network):
    frames, used = build.build_frames(POSTINGS, PRICES, central(2024, 1, 15, 12, 0),
                                      central(2024, 1, 15, 13, 5), 5, "LZ_HOUSTON")
    by_ts = {frame["ts"][11:16]: frame["risk_fixture"] for frame in frames}
    before, after = (str(build.FIXTURE_DIR / name) for name in
                     ("np3_233_cd_20240115T120335.json", "np3_233_cd_20240115T130335.json"))

    assert by_ts["12:00"] is None
    assert by_ts["12:05"] == by_ts["13:00"] == before
    assert by_ts["13:05"] == after
    assert sorted(used) == [before, after]


def test_prices_come_from_the_asked_zone_and_the_interval_holding_the_tick(monkeypatch):
    asked = {}

    class Reply:
        ok = True

        def json(self):
            return [{"interval_ending": "2024-01-15T19:00:00+00:00", "price_usd_mwh": 80.0},
                    {"interval_ending": "2024-01-15T19:15:00+00:00", "price_usd_mwh": 95.5}]

    def fake_get(url, params, headers, timeout):
        asked.update(params)
        return Reply()
    monkeypatch.setattr(build.requests, "get", fake_get)

    prices = build.fetch_prices("https://x.supabase.co", "key", "LZ_WEST",
                                central(2024, 1, 15, 13, 0), central(2024, 1, 15, 13, 10))

    assert asked["settlement_point"] == "eq.LZ_WEST"
    assert prices[0] == (central(2024, 1, 15, 13, 0), 80.0)
    assert build.price_at(prices, central(2024, 1, 15, 12, 59)) == 80.0
    assert build.price_at(prices, central(2024, 1, 15, 13, 0)) == 95.5
    assert build.price_at(prices, central(2024, 1, 15, 13, 15)) is None


def test_posting_fixture_loads_like_a_saved_ercot_reply(tmp_path, no_network):
    posted, rows = POSTINGS[1]
    path = tmp_path / build.fixture_name(posted)
    path.write_text(json.dumps(build.posting_fixture(posted, rows)))

    loaded = load_signal(argparse.Namespace(fixture=False, file=str(path)))
    signal = to_signal(loaded["raw"], loaded["now"])

    assert loaded["now"] == central(2024, 1, 15, 13, 3, 35)
    assert signal["current_hour_ending"] == 14
    assert [row["hourEnding"] for row in signal["rows"]] == [14, 15]


def test_missing_config_skips_without_fetching(tmp_path, monkeypatch, capsys, no_network):
    monkeypatch.setattr(build, "ENV_PATH", tmp_path / "missing.env")
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)

    assert build.main([]) == 0
    assert capsys.readouterr().out == "build_tape_skipped: no_config\n"
