"""scripts/load_ercot_reports.py: turn ERCOT API rows into Supabase rows. No network."""
import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("load_ercot_reports", ROOT / "scripts" / "load_ercot_reports.py")
loader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(loader)


@pytest.fixture
def no_network(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("the test tried to reach the network")
    monkeypatch.setattr(loader.requests, "get", refuse)
    monkeypatch.setattr(loader.requests, "post", refuse)


def test_rows_group_into_one_row_per_posting(no_network):
    later = {"postedDatetime": "2024-07-08T00:05:25", "intervalEnding": "2024-07-08T00:00:00",
             "genSystemWide": 17800.0}
    earlier = [{"postedDatetime": "2024-07-08T00:00:25", "intervalEnding": f"2024-07-07T23:{m}:00",
                "genSystemWide": 17954.06} for m in ("55", "50")]

    rows = loader.posting_rows("NP4-733-CD", "beryl", [later, *earlier])

    assert [row["posted_at"] for row in rows] == ["2024-07-08T00:00:25-05:00", "2024-07-08T00:05:25-05:00"]
    assert [len(row["payload"]) for row in rows] == [2, 1]
    # postedDatetime is the posted_at column, so it is not repeated inside the payload.
    assert rows[1]["payload"] == [{"intervalEnding": "2024-07-08T00:00:00", "genSystemWide": 17800.0}]
    assert (rows[0]["report"], rows[0]["event"], rows[0]["file_name"]) == ("NP4-733-CD", "beryl", None)
    assert "postedDatetime" in later


def test_price_interval_ending_in_central_time(no_network):
    row = {"deliveryDate": "2024-07-08", "deliveryHour": 24, "deliveryInterval": 4,
           "settlementPoint": "LZ_HOUSTON", "settlementPointType": "LZ",
           "settlementPointPrice": 20.63, "DSTFlag": False}

    [price] = loader.price_rows("beryl", [row])

    # HE 24 interval 4 is the last 15 minutes of the day, so it ends at midnight.
    assert price["interval_ending"] == "2024-07-09T00:00:00-05:00"
    assert (price["settlement_point"], price["price_usd_mwh"], price["report"]) == ("LZ_HOUSTON", 20.63, "NP6-905-CD")


def test_repeated_fall_back_hour_is_standard_time(no_network):
    first = loader.interval_ending("2024-11-03", 2, 1, False)
    repeat = loader.interval_ending("2024-11-03", 2, 1, True)

    assert first.isoformat() == "2024-11-03T01:15:00-05:00"
    assert repeat.isoformat() == "2024-11-03T01:15:00-06:00"


def test_missing_config_skips_without_sending(tmp_path, monkeypatch, capsys, no_network):
    monkeypatch.setattr(loader, "ENV_PATH", tmp_path / "missing.env")
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)

    assert loader.main([]) == 0
    assert capsys.readouterr().out == "skipped: no_config\n"
