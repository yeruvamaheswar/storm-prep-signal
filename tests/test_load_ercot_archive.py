"""scripts/load_ercot_archive.py: build ercot_postings rows from saved zips. No network."""
import importlib.util
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = Path(__file__).parent / "fixtures" / "np3233_sample.csv"
CSV_NAME = "cdr.00013103.0000000000000000.20240708.000050.HRLYRESOUTCAPNP3233.csv"
spec = importlib.util.spec_from_file_location("load_ercot_archive", ROOT / "scripts" / "load_ercot_archive.py")
loader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(loader)


@pytest.fixture
def no_network(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("the test tried to reach the network")
    monkeypatch.setattr(loader.requests, "post", refuse)


def test_one_zip_becomes_one_row(tmp_path, no_network):
    raw = tmp_path / "beryl" / "raw"
    raw.mkdir(parents=True)
    with zipfile.ZipFile(raw / "1009322989.zip", "w") as archive:
        archive.write(FIXTURE, CSV_NAME)

    [row] = loader.build_rows(tmp_path / "beryl")

    assert row["report"] == "NP3-233-CD"
    # 00:00:50 on 8 July is Central Daylight Time, five hours behind UTC.
    assert row["posted_at"] == "2024-07-08T00:00:50-05:00"
    assert (row["event"], row["file_name"]) == ("beryl", CSV_NAME)
    assert [(hour["operatingDate"], hour["hourEnding"]) for hour in row["payload"]] == [
        ("2024-07-08", 1), ("2024-07-08", 2), ("2024-07-08", 3)]
    assert row["payload"][0]["totalResourceMWZoneHouston"] == 2200
    assert loader.event_names(tmp_path) == ["beryl"]


def test_missing_config_skips_without_sending(tmp_path, monkeypatch, capsys, no_network):
    monkeypatch.setattr(loader, "ENV_PATH", tmp_path / "missing.env")
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)

    assert loader.main([]) == 0
    assert capsys.readouterr().out == "skipped: no_config\n"
