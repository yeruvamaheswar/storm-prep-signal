"""Slice 2, the live ERCOT fetch. The network is faked, so no test makes a real call."""
import json
from datetime import datetime, timedelta
from pathlib import Path

import pytest
import requests

import storm_prep.__main__ as cli
from storm_prep import signal
from storm_prep.__main__ import parse_args, run
from storm_prep.baseline import load_baseline
from storm_prep.signal import CENTRAL, fetch_outages, to_signal

FIXTURE = Path(__file__).parent / "fixtures" / "np3_233_cd.json"
# The fixture's posting time, so the rated hour is inside the fake posting.
NOW = datetime(2026, 9, 25, 12, 0, 47, tzinfo=CENTRAL)
SECRETS = {"ERCOT_USERNAME": "user-SECRET-1", "ERCOT_PASSWORD": "pass-SECRET-2",
           "ERCOT_SUBSCRIPTION_KEY": "key-SECRET-3"}
TOKEN = "token-SECRET-4"
SETTINGS = {"margin_pct": 15, "lookahead_hours": 6, "fetch_timeout_s": 3, "stale_after_min": 90,
            "base_reserve_pct": 30, "storm_reserve_pct": 60}


class FakeResponse:
    def __init__(self, status_code, text):
        self.status_code = status_code
        self.text = text


class PinnedClock(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW


@pytest.fixture
def fake_ercot(monkeypatch, tmp_path):
    """Swap requests.post/get for fakes that answer like ERCOT and record every call."""
    for name, value in SECRETS.items():
        monkeypatch.setenv(name, value)
    # Live runs save to var/signal/ under the working directory; keep that out of the repo.
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(signal, "datetime", PinnedClock)
    calls = []

    def post(url, **kwargs):
        calls.append(kwargs)
        return FakeResponse(200, json.dumps({"id_token": TOKEN, "token_type": "Bearer"}))

    def get(url, **kwargs):
        calls.append(kwargs)
        return FakeResponse(200, FIXTURE.read_text())

    monkeypatch.setattr(requests, "post", post)
    monkeypatch.setattr(requests, "get", get)
    return calls


def read_log(log_dir):
    [log_file] = Path(log_dir).glob("*.jsonl")
    return log_file.read_text()


def test_good_response_gives_parsed_rows(fake_ercot, tmp_path):
    saved = tmp_path / "latest_np3.json"
    raw = fetch_outages(SETTINGS, NOW, save_to=saved)
    rows = to_signal(raw, NOW)["rows"]
    assert len(rows) == 192
    assert (rows[0]["operatingDate"], rows[0]["hourEnding"]) == ("2026-09-24", 24)
    # The body is kept byte for byte, so --file can replay the run.
    assert saved.read_text() == FIXTURE.read_text()
    token_call, report_call = fake_ercot
    assert token_call["data"]["password"] == SECRETS["ERCOT_PASSWORD"]
    assert report_call["headers"] == {"Authorization": f"Bearer {TOKEN}",
                                      "Ocp-Apim-Subscription-Key": SECRETS["ERCOT_SUBSCRIPTION_KEY"]}
    assert report_call["params"] == {"postedDatetimeFrom": "2026-09-25T10:00:47", "size": 400}
    assert token_call["timeout"] == report_call["timeout"] == 3


def test_live_run_rates_the_fetched_posting(fake_ercot, tmp_path):
    line, batteries = run(parse_args(["--live"]), SETTINGS, log_dir=tmp_path / "logs")
    assert line.startswith("[NORMAL] risk LOW | peak outages 22,194 MW at HE15")
    assert "clock: pinned" not in line
    assert line.endswith("source: ERCOT NP3-233-CD")
    assert (tmp_path / "var" / "signal" / "latest_np3.json").exists()


def test_timeout_gives_no_risk_and_the_storm_floor(fake_ercot, monkeypatch, tmp_path):
    def timeout(url, **kwargs):
        raise requests.Timeout("read timed out")

    monkeypatch.setattr(requests, "post", timeout)
    line, batteries = run(parse_args(["--live"]), SETTINGS, log_dir=tmp_path)
    assert line == ("[RESERVE] risk unknown | ERCOT did not answer within 3 s"
                    " | reserve floor 60% (signal_unavailable) | source: ERCOT NP3-233-CD")
    assert set(batteries.values()) == {"RESERVE"}
    events = [json.loads(text) for text in read_log(tmp_path).splitlines()]
    [failed] = [event for event in events if event["stage"] == "compute_risk"]
    assert (failed["event"], failed["ok"]) == ("failed", False)
    assert failed["reason"] == "ERCOT did not answer within 3 s"


def pin_clock(monkeypatch, minutes_after_posting):
    later = NOW + timedelta(minutes=minutes_after_posting)

    class LaterClock(datetime):
        @classmethod
        def now(cls, tz=None):
            return later

    monkeypatch.setattr(signal, "datetime", LaterClock)


def test_live_posting_120_min_old_gives_no_risk_and_the_storm_floor(fake_ercot, monkeypatch, tmp_path):
    pin_clock(monkeypatch, 120)
    line, batteries = run(parse_args(["--live"]), SETTINGS, log_dir=tmp_path)
    assert line == ("[RESERVE] risk unknown | data is 120 min old (limit 90)"
                    " | reserve floor 60% (signal_unavailable) | source: ERCOT NP3-233-CD")
    assert set(batteries.values()) == {"RESERVE"}


def test_live_posting_40_min_old_is_still_rated(fake_ercot, monkeypatch, tmp_path):
    pin_clock(monkeypatch, 40)
    line, _ = run(parse_args(["--live"]), SETTINGS, log_dir=tmp_path)
    assert line.startswith("[NORMAL] risk LOW | peak outages 22,194 MW at HE15")
    assert "(40 min old)" in line


def test_live_run_without_baseline_stops_with_a_setup_error(fake_ercot, monkeypatch, tmp_path):
    missing = tmp_path / "baseline_by_lead.json"
    monkeypatch.setattr(cli, "load_baseline", lambda **kwargs: load_baseline(missing, **kwargs))
    with pytest.raises(ValueError, match="baseline file missing"):
        run(parse_args(["--live"]), SETTINGS, log_dir=tmp_path / "logs")


def test_no_secret_reaches_the_log_or_the_screen(fake_ercot, monkeypatch, tmp_path):
    good_line, _ = run(parse_args(["--live"]), SETTINGS, log_dir=tmp_path / "good")
    monkeypatch.setattr(requests, "get", lambda url, **kwargs: FakeResponse(401, "{}"))
    bad_line, _ = run(parse_args(["--live"]), SETTINGS, log_dir=tmp_path / "bad")
    assert "auth rejected (HTTP 401)" in bad_line
    written = " ".join([good_line, bad_line, read_log(tmp_path / "good"), read_log(tmp_path / "bad"),
                        (tmp_path / "var" / "signal" / "latest_np3.json").read_text()])
    for secret in [*SECRETS.values(), TOKEN]:
        assert secret not in written
