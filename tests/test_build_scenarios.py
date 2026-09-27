"""scripts/build_scenarios.py: price-shaped target, sidecars, overlay labels, and the committed catalog. No network."""
import importlib.util
import json
from datetime import datetime
from pathlib import Path

import pytest

from server.engine.scenario import Session, load_catalog
from server.engine.signal import CENTRAL

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("build_scenarios", ROOT / "scripts" / "build_scenarios.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)

SETTINGS = {
    "margin_pct": 15, "lookahead_hours": 6, "fleet_size": 100, "home_kwh": 25.0, "home_max_kw": 11.4,
    "base_reserve_pct": 30.0, "storm_reserve_pct": 60.0, "tick_minutes": 5, "telemetry_feed": False,
}
CATALOG = load_catalog(ROOT / "tapes" / "scenarios" / "catalog.json")
OVERLAY_KEYS = {"network", "crash", "misreport", "short_delivery", "operator", "dead", "stale", "live"}


@pytest.fixture
def no_network(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("the test tried to reach the network")
    monkeypatch.setattr(build.requests, "get", refuse)


def central(*parts):
    return datetime(*parts, tzinfo=CENTRAL)


def posting(posted):
    day = posted.date().isoformat()
    return posted, [{"operatingDate": day, "hourEnding": posted.hour + 1 + lead, "totalResourceMWZoneNorth": 10.0}
                    for lead in range(2)]


POSTINGS = [posting(datetime(2026, 9, 12, 17, 0, 47)), posting(datetime(2026, 9, 12, 18, 0, 48))]
META = {POSTINGS[0][0]: {"id": 11, "file_name": None}, POSTINGS[1][0]: {"id": 12, "file_name": None}}
# Interval-ending times: 18:15 covers 18:00-18:15.
ZONE_PRICES = {name: [(central(2026, 9, 12, 18, 15), usd), (central(2026, 9, 12, 18, 30), usd * 4)]
               for name, usd in (("Houston", 10.0), ("North", 20.0), ("South", 30.0), ("West", 40.0))}
SPEC = {"id": "t", "name": "Test", "event": "tuning-2026", "zone": "LZ_NORTH",
        "start": "2026-09-12T18:00", "end": "2026-09-12T18:25", "summary": "s",
        "withhold": [("2026-09-12T18:20", "2026-09-12T18:30")],
        "overlays": [{"span": ("2026-09-12T18:05", "2026-09-12T18:10"), "name": "operator HOLD 18:05",
                      "events": {"operator": "HOLD"}, "text": "overlay (hand-placed, not archive): operator HOLD"}]}


def test_target_is_small_when_cheap_rises_with_price_and_is_capped():
    assert build.price_shaped_mw(-25.0) == build.price_shaped_mw(25.0) == 0.02
    assert build.price_shaped_mw(60.0) == 0.2
    assert build.price_shaped_mw(500.0) == build.price_shaped_mw(1172.87) == 1.0
    ladder = [build.price_shaped_mw(usd) for usd in (0, 25, 40, 60, 100, 250, 500, 900)]
    assert ladder == sorted(ladder)
    # A cheap hour still asks for more than 0: allocate returns before charging when the target is 0.
    assert min(ladder) > 0
    assert build.price_shaped_mw(None) == 0.2


def test_frames_carry_shaped_targets_labels_and_hand_placed_events_only_in_their_span(no_network):
    frames, used, notes = build.scenario_frames(SPEC, POSTINGS, ZONE_PRICES, 5)

    assert [frame["ts"][11:16] for frame in frames] == ["18:00", "18:05", "18:10", "18:15", "18:20", "18:25"]
    assert all(frame["target_label"] == "synthetic:price-shaped" for frame in frames)
    assert frames[0]["price_usd_mwh"] == 20.0 and frames[0]["target_mw"] == 0.02
    assert frames[3]["price_usd_mwh"] == 80.0 and frames[3]["target_mw"] == build.price_shaped_mw(80.0)
    assert frames[0]["price_label"] == "recorded:ERCOT NP6-905-CD LZ_NORTH"
    assert [frame["events"] for frame in frames] == [{}, {"operator": "HOLD"}, {}, {}, {}, {}]
    # The posting fixture lives with its event, and a withheld tick reads no posting.
    assert frames[0]["risk_fixture"] == "data/fixtures/tuning-2026/np3_233_cd_20260912T170047.json"
    assert frames[1]["risk_fixture"].endswith("np3_233_cd_20260912T180048.json")
    assert [frame["risk_fixture"] for frame in frames[4:]] == [None, None]
    assert sorted(used) == sorted({frame["risk_fixture"] for frame in frames if frame["risk_fixture"]})
    assert sorted(notes) == [2, 5, 6]
    assert notes[2].startswith("overlay (hand-placed, not archive)")
    assert "signal_unavailable" in notes[5] and "withheld" in notes[5]


def test_sidecar_names_the_posting_row_the_price_rows_and_the_overlay(no_network):
    frames, _, notes = build.scenario_frames(SPEC, POSTINGS, ZONE_PRICES, 5)
    rows = build.sidecar(frames, META, ZONE_PRICES, "tuning-2026", notes)

    assert sorted(rows, key=int) == [str(frame["tick"]) for frame in frames]
    assert rows["1"]["posting"] == {"id": 11, "report": "NP3-233-CD", "posted_at": "2026-09-12T17:00:47",
                                    "file_name": None, "event": "tuning-2026"}
    assert rows["2"]["posting"]["id"] == 12
    assert rows["1"]["prices"][0] == {"settlement_point": "LZ_HOUSTON",
                                      "interval_ending": "2026-09-12T18:15:00-05:00", "price_usd_mwh": 10.0}
    assert {row["settlement_point"] for row in rows["1"]["prices"]} == {"LZ_HOUSTON", "LZ_NORTH", "LZ_SOUTH",
                                                                         "LZ_WEST"}
    assert "overlay" not in rows["1"] and rows["2"]["overlay"] == notes[2]
    assert "posting" not in rows["5"] and "withheld" in rows["5"]["overlay"]
    assert rows["6"]["prices"][0]["interval_ending"] == "2026-09-12T18:30:00-05:00"
    # A zone Supabase returned no rows for gets no price row; none is made up.
    north_only = build.sidecar(frames, META, {"North": ZONE_PRICES["North"]}, "tuning-2026")
    assert [row["settlement_point"] for row in north_only["1"]["prices"]] == ["LZ_NORTH"]


def test_frames_name_the_dam_days_published_at_the_tick_and_the_sidecar_lists_them(tmp_path, monkeypatch,
                                                                                   no_network):
    monkeypatch.setattr(build, "ROOT", tmp_path)
    for day in ("20260912", "20260913"):
        (tmp_path / "data" / "fixtures" / "dam").mkdir(parents=True, exist_ok=True)
        (tmp_path / "data" / "fixtures" / "dam" / f"np4_190_cd_{day}.json").write_text("{}")
    spec = {**SPEC, "start": "2026-09-12T13:25", "end": "2026-09-12T13:30", "withhold": [], "overlays": []}
    frames, _, notes = build.scenario_frames(spec, POSTINGS, ZONE_PRICES, 5)

    today = "data/fixtures/dam/np4_190_cd_20260912.json"
    tomorrow = "data/fixtures/dam/np4_190_cd_20260913.json"
    # Tomorrow's DAM is posted at 13:30 CT, so the 13:25 tick reads today's file only.
    assert [frame["dam_fixtures"] for frame in frames] == [[today], [today, tomorrow]]
    rows = build.sidecar(frames, META, ZONE_PRICES, "tuning-2026", notes)
    assert rows["2"]["dam"] == [{"report": "NP4-190-CD", "delivery_date": "2026-09-12", "file": today},
                                {"report": "NP4-190-CD", "delivery_date": "2026-09-13", "file": tomorrow}]
    # A day never fetched is left off; the tick falls back to the price bands.
    (tmp_path / tomorrow).unlink()
    frames, _, _ = build.scenario_frames(spec, POSTINGS, ZONE_PRICES, 5)
    assert frames[1]["dam_fixtures"] == [today]


def test_catalog_entry_names_every_overlay_in_its_label():
    entry = build.catalog_entry(SPEC, {"alerts": ["kept-alert"]})
    assert entry["label"].startswith("recorded ERCOT; target synthetic:price-shaped; overlays (hand-placed")
    assert "postings withheld 18:20-18:30 (feed failure)" in entry["label"]
    assert "operator HOLD 18:05" in entry["label"]
    assert entry["tape"] == "tapes/scenarios/t.json" and entry["provenance"] == "tapes/scenarios/t.provenance.json"
    assert entry["baseline"] == "data/fixtures/tuning-2026/baseline.json"
    assert entry["alerts"] == ["kept-alert"] and entry["grid_down_overlay"] is False
    assert entry["window"] == "2026-09-12 18:00 to 18:25 CT"
    plain = build.catalog_entry({**SPEC, "withhold": [], "overlays": []})
    assert plain["label"] == "recorded ERCOT; target synthetic:price-shaped" and plain["alerts"] == []


def test_specs_use_only_known_events_and_label_each_one():
    for scenario in build.SCENARIOS:
        for overlay in scenario.get("overlays", []):
            assert set(overlay["events"]) <= OVERLAY_KEYS
            assert overlay["text"].startswith("overlay (hand-placed, not archive)")
            assert overlay["name"] in build.catalog_entry(scenario)["label"]


def test_missing_config_skips_without_fetching(tmp_path, monkeypatch, capsys, no_network):
    monkeypatch.setattr(build, "ENV_PATH", tmp_path / "missing.env")
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)
    assert build.main([]) == 0
    assert capsys.readouterr().out == "build_scenarios_skipped: no_config\n"


def test_supabase_failure_skips_and_writes_nothing(tmp_path, monkeypatch, capsys):
    def fail(*args, **kwargs):
        raise build.FetchFailed("HTTP 503: down")
    monkeypatch.setattr(build, "fetch_all", fail)
    monkeypatch.setattr(build, "ROOT", tmp_path)
    monkeypatch.setenv("SUPABASE_URL", "https://x.supabase.co")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "key")
    assert build.main(["--only", "calm-charge"]) == 0
    assert capsys.readouterr().out == "build_scenarios_skipped: HTTP 503: down\n"
    assert list(tmp_path.iterdir()) == []


# --- the committed catalog ---

def test_every_catalog_entry_has_its_files_and_starts_a_session(tmp_path):
    assert {entry["id"] for entry in CATALOG} >= {"heather"} | {s["id"] for s in build.SCENARIOS}
    for entry in CATALOG:
        for key in ("tape", "baseline", "provenance"):
            assert (ROOT / entry[key]).is_file(), f"{entry['id']}: {key} {entry[key]} is missing"
        assert isinstance(entry["alerts"], list)
        s = Session(dict(SETTINGS), CATALOG, log_dir=tmp_path / entry["id"])
        s.start(entry["id"], 1)
        assert s.frames and s.baseline["postings"] > 0
        assert set(s.sidecar) == {str(frame.tick) for frame in s.frames}
        for frame in s.frames:
            if frame.risk_fixture:
                assert (ROOT / frame.risk_fixture).is_file()


def test_committed_tapes_never_carry_an_unlabeled_hand_placed_event():
    for entry in CATALOG:
        frames = json.loads((ROOT / entry["tape"]).read_text())["frames"]
        rows = json.loads((ROOT / entry["provenance"]).read_text())
        overlaid = False
        for frame in frames:
            row = rows[str(frame["tick"])]
            if frame["events"] or not frame["risk_fixture"]:
                assert row.get("overlay", "").startswith("overlay (hand-placed, not archive)"), \
                    f"{entry['id']} tick {frame['tick']}"
                overlaid = True
            if frame["risk_fixture"]:
                assert row["posting"]["id"] is not None
                assert build.posted_from_fixture(frame["risk_fixture"]).isoformat() == row["posting"]["posted_at"]
        assert overlaid == ("overlays" in entry["label"]), entry["id"]
        expected = "synthetic" if entry["id"] == "heather" else "synthetic:price-shaped"
        assert {frame["target_label"] for frame in frames} == {expected}


def play(tmp_path, scenario_id, steps):
    s = Session(dict(SETTINGS), CATALOG, log_dir=tmp_path / "logs")
    s.start(scenario_id, 42)
    ticks = []
    for _ in range(steps):
        s.step()
        ticks.append(s.last["result"])
    return ticks


def test_calm_day_charges_on_cheap_ticks_and_sells_at_the_peak(tmp_path):
    ticks = play(tmp_path, "calm-charge", 181)
    cheap = [t for t in ticks if t["price_usd_mwh"] <= 25]
    assert cheap and any(t["charging_mw"] > 0 for t in cheap)
    # The tape carries DAM hours, so a zone above the $25 band charges only in a chosen DAM hour or a dip.
    dear = [(t["zone_charge_why"].get(zone), mw) for t in ticks for zone, mw in t["zone_charging_mw"].items()
            if t["zone_prices"].get(zone, t["price_usd_mwh"]) > 25]
    assert any(mw > 0 for _, mw in dear)
    assert {why for why, mw in dear if mw > 0} <= {"dam_cheap_hour", "before_spike", "rt_dip"}
    assert all(t["dam_label"] == "recorded:ERCOT NP4-190-CD" for t in ticks)
    assert max(t["delivered_mw"] for t in ticks if t["price_usd_mwh"] >= 60) > 0.2
    assert sum(t["breaches"] for t in ticks) == 0


def test_withheld_postings_read_as_signal_unavailable_with_the_storm_floor(tmp_path):
    ticks = play(tmp_path, "feed-failure", 133)
    withheld = [t for t in ticks if "18:00" <= t["ts"][11:16] < "21:00"]
    assert withheld and all((t["reserve_pct"], t["policy_reason"]) == (60.0, "signal_unavailable") for t in withheld)
    assert all(t["policy_reason"] == "normal" for t in ticks if t not in withheld)
    assert sum(t["breaches"] for t in ticks) == 0
