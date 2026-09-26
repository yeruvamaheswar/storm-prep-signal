"""End-to-end runs of the Slice 1 pipeline on the saved fixtures."""
import json
from pathlib import Path

import storm_prep.__main__ as cli
from storm_prep.__main__ import parse_args, read_settings, run

FIXTURES = Path(__file__).parent / "fixtures"
SETTINGS = {"margin_pct": 15, "lookahead_hours": 6}
REAL_LINE = (
    "[NORMAL] risk LOW | peak outages 22,194 MW at HE15 (next 6 h) vs trigger 23,304 MW"
    " (-1,110 MW; typical for +2 h ahead 20,264 MW over Aug 25-Sep 25 postings +15%)"
    " | driving zone: North 9,429 MW"
    " | data as of 12:00 CT (0 min old) | clock: pinned to posting | quality: unchecked"
    " | source: fixture"
)


def run_with(log_dir, *flags):
    return run(parse_args(list(flags)), SETTINGS, log_dir=log_dir)


def test_real_fixture_gives_same_decision_line_every_run(tmp_path):
    first, batteries = run_with(tmp_path, "--fixture")
    second, _ = run_with(tmp_path, "--fixture")
    assert first == second == REAL_LINE
    assert set(batteries.values()) == {"NORMAL"}
    # Each run gets its own log file, even when both finish within one second.
    assert len(list(tmp_path.glob("*.jsonl"))) == 2


def test_synthetic_spike_rates_high_and_reserves_batteries(tmp_path):
    line, batteries = run_with(tmp_path, "--file", str(FIXTURES / "np3_spike_synthetic.json"))
    assert line.startswith("[RESERVE] risk HIGH | peak outages 23,539 MW at HE16")
    assert "clock: pinned to posting" in line
    assert line.endswith("source: fixture (synthetic)")
    assert set(batteries.values()) == {"RESERVE"}


def test_run_logs_every_stage(tmp_path):
    run_with(tmp_path, "--fixture")
    [log_file] = tmp_path.glob("*.jsonl")
    events = [json.loads(line) for line in log_file.read_text().splitlines()]
    stages = [event["stage"] for event in events]
    assert stages == ["run", "load_signal", "load_baseline", "compute_risk", "decide_mode",
                      "apply_to_batteries", "run"]
    assert all(event["ok"] for event in events)


def test_read_settings_defaults_reserves_to_env_example(monkeypatch):
    # Skip the real .env so the owner's local values can't change the result.
    monkeypatch.setattr(cli, "load_dotenv", lambda: None)
    monkeypatch.delenv("BASE_RESERVE_PCT", raising=False)
    monkeypatch.delenv("STORM_RESERVE_PCT", raising=False)
    settings = read_settings()
    assert settings["base_reserve_pct"] == 30
    assert settings["storm_reserve_pct"] == 60
