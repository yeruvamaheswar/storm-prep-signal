"""Every path one engine tick can take, end to end through loop.run (plan: one test per path).

Each test builds the tick it needs and plays it through the real engine: storm rule, price intent,
allocate, the lossy orchestration runtime, the scoreboard and the run file. A spy keeps a handle on
the fleet and each tick's CycleResult; nothing else is replaced. Every tick also passes the shared
rules in check_tick. Run with -s to read one line per path:

    .venv/bin/pytest -q -s tests/test_tick_paths.py
"""
import json
from dataclasses import replace
from pathlib import Path

import pytest

from server.engine import fleet, orchestration
from server.engine import loop as engine
from server.engine.cli import read_settings
from server.engine.contracts import Home, TapeFrame
from server.engine.controller import acted_intent

ROOT = Path(__file__).parent.parent
CALM = "tests/fixtures/np3_233_cd.json"             # rates LOW
STORM = "tests/fixtures/np3_spike_synthetic.json"   # rates HIGH
ZONE_NAMES = ("Houston", "North", "South", "West")
EPS = 1e-9
# Short delays so a clean tick confirms everything; fault paths turn faults on per tick.
CLEAN = {"channel_delay_s": (1.0, 5.0), "worker_delay_s": (1.0, 5.0),
         "channel_drop_rate": 0.0, "channel_dup_rate": 0.0, "channel_late_rate": 0.0}


def settings(**over):
    """Pinned, so a local .env cannot change the answer. Feed on, as in the real engine."""
    s = read_settings()
    s.update({"fleet_size": 100, "home_kwh": 25.0, "home_max_kw": 11.4,
              "home_start_soc_min_pct": 45.0, "home_start_soc_max_pct": 75.0,
              "base_reserve_pct": 30.0, "storm_reserve_pct": 60.0, "tick_minutes": 5,
              "charge_threshold_usd_mwh": 25.0, "discharge_threshold_usd_mwh": 60.0,
              "call_target_mw": None, "telemetry_feed": True, "seed": 1, **CLEAN})
    s.update(over)
    return s


def frame(tick=1, target_mw=0.2, price=35.0, risk=CALM, events=None, price_label="synthetic"):
    return TapeFrame(tick, f"2026-09-25T12:{5 * (tick - 1):02d}:00-05:00", target_mw, "synthetic",
                     price, price_label, risk, events or {})


def fleet_ids(zone=None, **over):
    """Home ids of the fleet a run will build (new_fleet is deterministic for the settings)."""
    return [h.home_id for h in fleet.new_fleet(settings(**over)) if zone is None or h.zone == zone]


def play(tmp_path, monkeypatch, frames, **over):
    """Run the engine on these frames. Returns (record, ticks) with each tick's spy data."""
    monkeypatch.chdir(ROOT)   # risk fixture paths are relative to the repo root
    seen = []

    def spy(homes, frame, policy, mode, s, seed, **feed):
        before = {h.home_id: h.soc_kwh for h in homes}
        status = {h.home_id: h.status for h in homes}
        cycle = orchestration.orchestrate_tick(homes, frame, policy, mode, s, seed, **feed)
        # Copies at the end of this tick: the fleet objects keep changing on later ticks.
        after = [Home(**vars(h)) for h in homes]
        seen.append({"homes": after, "before": before, "status": status, "policy": policy,
                     "cycle": cycle, "target": frame.target_mw, "feed": feed.get("telemetry")})
        return cycle

    monkeypatch.setattr(engine, "orchestrate_tick", spy)
    runs_dir = tmp_path / "runs"
    record = engine.run(None, settings(**over), log_dir=tmp_path / "logs", runs_dir=runs_dir,
                        frames=frames)
    assert json.loads((runs_dir / "latest.json").read_text()) == json.loads(json.dumps(record))
    for tick, data in zip(record["ticks"], seen):
        check_tick(tick, data)
    return record, seen


def check_tick(tick, data):
    """The rules every path must keep, whatever else it shows."""
    at = f"tick {tick['tick']}"
    homes, before, policy = data["homes"], data["before"], data["policy"]
    assert tick["breaches"] == 0, f"{at}: breaches"
    assert 0 <= tick["delivered_mw"] <= tick["target_mw"] + EPS, f"{at}: delivered out of range"
    assert tick["delivered_mw"] + tick["missed_mw"] == pytest.approx(tick["target_mw"], abs=1e-6)
    for h in homes:
        assert h.soc_kwh <= h.capacity_kwh + EPS, f"{at}: {h.home_id} past full"
        if h.soc_kwh < before[h.home_id] - EPS:
            assert h.soc_kwh >= fleet.floor_kwh(h, policy) - EPS, f"{at}: {h.home_id} under floor"
        if data["status"][h.home_id] != "live":
            assert h.soc_kwh == pytest.approx(before[h.home_id]), f"{at}: {h.home_id} not live but moved"
    assert sum(sum(row.values()) for row in tick["zone_acks"].values()) == len(homes)


def moved_kwh(data):
    """Net kWh the fleet gained this tick (positive = charged, negative = gave)."""
    return sum(h.soc_kwh - data["before"][h.home_id] for h in data["homes"])


def gained_kwh(data):
    """kWh the charging homes took this tick (homes that sold are left out)."""
    return sum(max(0.0, h.soc_kwh - data["before"][h.home_id]) for h in data["homes"])


def story(n, name, tick, data, extra=""):
    print(f"\n  path {n:>2} {name:<24} intent {tick['intent']:<9} floor {tick['reserve_pct']:g}%"
          f" | delivered {tick['delivered_mw']:.3f} of {tick['target_mw']:.3f} MW"
          f" | fleet {moved_kwh(data):+.2f} kWh | breaches {tick['breaches']}"
          f" | reasons {tick['reasons']}{extra}")


# --- price decides charge, hold or discharge (calm day, 30% floor) -----------------

def test_path_01_hold_on_a_calm_day_still_serves_the_call(tmp_path, monkeypatch):
    record, seen = play(tmp_path, monkeypatch, [frame(price=35.0)])
    tick, data = record["ticks"][0], seen[0]
    story(1, "hold ($35)", tick, data)
    # The price band says hold; the fleet sold for the call, so the tick says discharge.
    assert data["policy"].intent == "hold" and tick["reserve_pct"] == 30.0
    assert (tick["intent"], tick["intent_reason"]) == ("discharge", "grid_call")
    assert tick["delivered_mw"] == pytest.approx(0.2)
    assert moved_kwh(data) < 0


def test_path_02_discharge_on_a_high_price_serves_the_call(tmp_path, monkeypatch):
    record, seen = play(tmp_path, monkeypatch, [frame(price=80.0)])
    tick, data = record["ticks"][0], seen[0]
    story(2, "discharge ($80)", tick, data)
    assert tick["intent"] == "discharge"
    assert tick["delivered_mw"] == pytest.approx(0.2)


def test_path_03_charge_on_a_cheap_price_serves_the_call_and_fills_safely(tmp_path, monkeypatch):
    record, seen = play(tmp_path, monkeypatch, [frame(price=20.0)])
    tick, data = record["ticks"][0], seen[0]
    story(3, "charge ($20)", tick, data, f" | charged {data['cycle'].charged_mw:.3f} MW")
    # Net flow is in (most homes charge), and the call was met: charge / grid_call_served.
    assert data["policy"].intent == "charge"
    assert (tick["intent"], tick["intent_reason"]) == ("charge", "grid_call_served")
    # Cheap power still answers the call first; the homes not selling charge.
    assert tick["delivered_mw"] == pytest.approx(0.2) and tick["missed_mw"] == pytest.approx(0.0, abs=EPS)
    assert "charging" in tick["reasons"]
    assert gained_kwh(data) > 0
    assert data["cycle"].charged_mw == pytest.approx(gained_kwh(data) * 12 / 1000)


def test_path_04_no_price_holds_and_still_serves(tmp_path, monkeypatch):
    record, seen = play(tmp_path, monkeypatch, [frame(price=None, price_label="none")])
    tick, data = record["ticks"][0], seen[0]
    story(4, "no price", tick, data, f" | intent_reason {tick['intent_reason']}")
    # No price means a hold band (price_unavailable); the fleet still served the call.
    assert (data["policy"].intent, data["policy"].intent_reason) == ("hold", "price_unavailable")
    assert (tick["intent"], tick["intent_reason"]) == ("discharge", "grid_call")
    assert tick["delivered_mw"] == pytest.approx(0.2)


# --- storm rule and floors ------------------------------------------------------------

def test_path_05_storm_raises_every_floor_to_60(tmp_path, monkeypatch):
    record, seen = play(tmp_path, monkeypatch, [frame(target_mw=0.4, price=35.0, risk=STORM)])
    tick, data = record["ticks"][0], seen[0]
    story(5, "storm (HIGH)", tick, data)
    assert tick["risk_level"] == "HIGH" and tick["policy_reason"] == "storm_risk_high"
    assert set(tick["zone_reserve_pct"].values()) == {60.0}
    assert tick["delivered_mw"] > 0
    if tick["missed_mw"] > EPS:
        assert "storm_reserve" in tick["reasons"]


def test_path_06_storm_with_a_cheap_price_charges_and_serves_only_above_the_storm_floor(
        tmp_path, monkeypatch):
    record, seen = play(tmp_path, monkeypatch, [frame(price=20.0, risk=STORM)])
    tick, data = record["ticks"][0], seen[0]
    story(6, "storm + cheap ($20)", tick, data)
    # Net flow is in, and the call was met from above the storm floor: charge / grid_call_served.
    assert data["policy"].intent == "charge"
    assert (tick["intent"], tick["intent_reason"]) == ("charge", "grid_call_served")
    assert "charging" in tick["reasons"]
    assert tick["delivered_mw"] == pytest.approx(0.2)
    assert set(tick["zone_reserve_pct"].values()) == {60.0}
    # The call is served from headroom above the 60% storm floor (check_tick guards the
    # floor), and every home not selling charges.
    assert tick["delivered_mw"] > 0
    assert data["cycle"].charged_mw > 0


def test_path_07_missing_signal_fails_safe_to_60(tmp_path, monkeypatch):
    record, seen = play(tmp_path, monkeypatch, [frame(price=35.0, risk=None)])
    tick, data = record["ticks"][0], seen[0]
    story(7, "missing signal", tick, data)
    assert tick["policy_reason"] == "signal_unavailable" and tick["reserve_pct"] == 60.0
    assert tick["risk_level"] is None


def test_path_08_weather_alert_raises_only_that_zone(tmp_path, monkeypatch):
    record, seen = play(tmp_path, monkeypatch, [frame(events={"weather": ["Houston"]})])
    tick, data = record["ticks"][0], seen[0]
    story(8, "weather: Houston", tick, data, f" | zones {tick['zone_reserve_pct']}")
    assert tick["zone_reserve_pct"]["Houston"] == 60.0
    assert tick["zone_reasons"]["Houston"] == "weather_alert"
    assert {tick["zone_reserve_pct"][z] for z in ZONE_NAMES if z != "Houston"} == {30.0}


# --- operator and the size of the call ---------------------------------------------------

def test_path_09_operator_hold_moves_no_battery(tmp_path, monkeypatch):
    record, seen = play(tmp_path, monkeypatch, [frame(events={"operator": "HOLD"})])
    tick, data = record["ticks"][0], seen[0]
    story(9, "operator HOLD", tick, data)
    assert tick["mode"] == "HOLD" and tick["delivered_mw"] == 0
    assert "operator_hold" in tick["reasons"]
    assert moved_kwh(data) == pytest.approx(0)
    assert data["cycle"].command_states == {}


def test_path_10_zero_target_sends_nothing(tmp_path, monkeypatch):
    record, seen = play(tmp_path, monkeypatch, [frame(target_mw=0.0)])
    tick, data = record["ticks"][0], seen[0]
    story(10, "zero target", tick, data)
    assert tick["delivered_mw"] == 0 and tick["missed_mw"] == 0
    assert data["cycle"].command_states == {}


def test_path_11_a_call_bigger_than_the_fleet_is_short_and_says_why(tmp_path, monkeypatch):
    record, seen = play(tmp_path, monkeypatch, [frame(target_mw=5.0, price=80.0)])
    tick, data = record["ticks"][0], seen[0]
    story(11, "call too big (5 MW)", tick, data)
    assert 0 < tick["delivered_mw"] < 5.0
    assert "fleet_headroom_short" in tick["reasons"]


# --- home health -------------------------------------------------------------------------

def test_path_12_dead_and_stale_homes_get_no_work(tmp_path, monkeypatch):
    ids = fleet_ids()
    dead, stale = ids[:4], ids[4:7]
    record, seen = play(tmp_path, monkeypatch, [frame(events={"dead": dead, "stale": stale})])
    tick, data = record["ticks"][0], seen[0]
    story(12, "4 dead, 3 stale", tick, data)
    planned = data["cycle"].allocation.per_home_kw
    assert not set(dead + stale) & set(planned)
    assert tick["dead_homes"] == 4 and tick["stale_homes"] == 3
    assert "homes_dead:4" in tick["reasons"] and "homes_stale:3" in tick["reasons"]
    assert tick["delivered_mw"] == pytest.approx(0.2)


def test_path_13_a_whole_zone_down_leaves_the_others_delivering(tmp_path, monkeypatch):
    houston = fleet_ids("Houston")
    record, seen = play(tmp_path, monkeypatch, [frame(events={"dead": houston})])
    tick, data = record["ticks"][0], seen[0]
    story(13, "Houston all dead", tick, data, f" | by zone {tick['zone_delivered_mw']}")
    assert tick["zone_acks"]["Houston"]["dead"] == len(houston)
    assert tick["zone_delivered_mw"].get("Houston", 0.0) == 0
    assert all(tick["zone_delivered_mw"][z] > 0 for z in ZONE_NAMES if z != "Houston")


# --- failures ------------------------------------------------------------------------------

def test_path_14_lost_messages_are_unconfirmed_never_delivered(tmp_path, monkeypatch):
    record, seen = play(tmp_path, monkeypatch, [frame(events={"network": {"drop_rate": 0.5}})])
    tick, data = record["ticks"][0], seen[0]
    cycle = data["cycle"]
    story(14, "50% messages lost", tick, data, f" | unconfirmed {cycle.unconfirmed_mw:.3f} MW")
    assert "faults_injected" in tick["reasons"]
    assert any(r.startswith("timed_out:") for r in tick["reasons"])
    assert tick["delivered_mw"] == pytest.approx(cycle.credited_mw)
    assert sum(row["unconfirmed"] for row in tick["zone_acks"].values()) > 0


def test_path_15_duplicates_never_run_an_order_twice(tmp_path, monkeypatch):
    record, seen = play(tmp_path, monkeypatch, [frame(events={"network": {"dup_rate": 1.0}})])
    tick, data = record["ticks"][0], seen[0]
    story(15, "every message twice", tick, data)
    runs = {}
    for e in data["cycle"].events:
        if e["kind"] == "executed":
            runs[e["command_id"]] = runs.get(e["command_id"], 0) + 1
    assert runs and max(runs.values()) == 1
    assert any(r.startswith("duplicates_ignored:") for r in tick["reasons"])
    assert tick["delivered_mw"] == pytest.approx(0.2)


def test_path_16_late_reports_are_never_counted(tmp_path, monkeypatch):
    record, seen = play(tmp_path, monkeypatch, [frame(events={"network": {"late_rate": 1.0}})])
    tick, data = record["ticks"][0], seen[0]
    story(16, "every message late", tick, data, f" | late {data['cycle'].late}")
    assert tick["delivered_mw"] < 0.2
    assert tick["delivered_mw"] == pytest.approx(data["cycle"].credited_mw)


def test_path_17_crashing_homes_go_dead_and_the_rest_carry_on(tmp_path, monkeypatch):
    crash = fleet_ids()[:3]
    record, seen = play(tmp_path, monkeypatch, [frame(events={"crash": crash})])
    tick, data = record["ticks"][0], seen[0]
    story(17, "3 homes crash", tick, data)
    by_id = {h.home_id: h for h in data["homes"]}
    assert all(by_id[i].status == "dead" for i in crash)
    assert tick["dead_homes"] == 3
    assert "faults_injected" in tick["reasons"]
    assert tick["delivered_mw"] > 0


def test_path_18_a_lying_battery_is_booked_at_what_it_really_gave(tmp_path, monkeypatch):
    liars = {home_id: 2.0 for home_id in fleet_ids()[:5]}
    record, seen = play(tmp_path, monkeypatch, [frame(events={"misreport": liars})])
    tick, data = record["ticks"][0], seen[0]
    story(18, "5 homes report 2x", tick, data)
    assert any(r.startswith("charge_mismatch:") for r in tick["reasons"])
    gave_mw = -moved_kwh(data) * 12 / 1000
    assert tick["delivered_mw"] <= gave_mw + 1e-6


def test_path_19_short_delivery_is_booked_at_what_the_home_gave(tmp_path, monkeypatch):
    short = {home_id: 0.5 for home_id in fleet_ids()[:10]}
    record, seen = play(tmp_path, monkeypatch, [frame(events={"short_delivery": short})])
    tick, data = record["ticks"][0], seen[0]
    story(19, "10 homes give half", tick, data)
    assert any(r.startswith("short_delivery:") for r in tick["reasons"])
    assert tick["delivered_mw"] < 0.2
    assert tick["delivered_mw"] == pytest.approx(-moved_kwh(data) * 12 / 1000)


# --- across two ticks ------------------------------------------------------------------------

def test_path_20_charge_then_discharge_across_two_ticks(tmp_path, monkeypatch):
    record, seen = play(tmp_path, monkeypatch, [frame(1, price=20.0), frame(2, price=80.0)])
    first, second = record["ticks"]
    story(20, "tick 1 charge ($20)", first, seen[0])
    story(20, "tick 2 discharge ($80)", second, seen[1])
    # Tick 1 meets the call and charges the rest; net flow is in, so it reads charge.
    assert seen[0]["policy"].intent == "charge" and "charging" in first["reasons"]
    assert (first["intent"], first["intent_reason"]) == ("charge", "grid_call_served")
    assert first["delivered_mw"] == pytest.approx(0.2)
    assert second["intent"] == "discharge"
    assert moved_kwh(seen[0]) > 0 > moved_kwh(seen[1])
    assert second["delivered_mw"] == pytest.approx(0.2)
    assert record["totals"]["breaches"] == 0
    # The feed plants one lying battery per seed. Charging must not make honest ones look like liars:
    # after the charge tick, the only suspect is that planted one (the "homes_stale:1" on tick 2).
    feed = seen[1]["feed"]
    assert [i for i, hs in feed.homes.items() if hs.suspect] == list(feed.liar_ids)
    assert "homes_stale:1" in second["reasons"]


# --- the label says what the fleet did, not what the price band said -------------------------

def sold_kw(data):
    return sum(kw for kw in data["cycle"].allocation.per_home_kw.values() if kw > 0)


def test_path_21_storm_call_at_a_high_price_is_labelled_discharge(tmp_path, monkeypatch):
    # HIGH risk never discharges on price, but the fleet still serves a grid call from headroom.
    record, seen = play(tmp_path, monkeypatch, [frame(price=80.0, risk=STORM)])
    tick, data = record["ticks"][0], seen[0]
    story(21, "storm call ($80)", tick, data, f" | intent_reason {tick['intent_reason']}")
    assert data["policy"].intent == "hold"
    assert sold_kw(data) > 0 and tick["delivered_mw"] > 0
    assert (tick["intent"], tick["intent_reason"]) == ("discharge", "grid_call")


def test_path_22_high_price_with_no_call_is_labelled_hold(tmp_path, monkeypatch):
    record, seen = play(tmp_path, monkeypatch, [frame(target_mw=0.0, price=80.0)])
    tick, data = record["ticks"][0], seen[0]
    story(22, "no call ($80)", tick, data, f" | intent_reason {tick['intent_reason']}")
    assert data["policy"].intent == "discharge"
    assert data["cycle"].allocation.per_home_kw == {}
    assert (tick["intent"], tick["intent_reason"]) == ("hold", "no_grid_call")


def test_path_23_cheap_price_with_no_call_charges_and_is_labelled_charge(tmp_path, monkeypatch):
    # Idle charging: no call, cheap power, so the homes really charge and nothing is sold.
    record, seen = play(tmp_path, monkeypatch, [frame(target_mw=0.0, price=20.0)])
    tick, data = record["ticks"][0], seen[0]
    story(23, "no call ($20)", tick, data, f" | intent_reason {tick['intent_reason']}")
    assert data["policy"].intent == "charge"
    assert moved_kwh(data) > 0
    assert sold_kw(data) == 0 and tick["delivered_mw"] == 0
    assert (tick["intent"], tick["intent_reason"]) == ("charge", data["policy"].intent_reason)


# --- each load zone decides from its own price ------------------------------------------------

def test_path_24_each_zone_follows_its_own_price(tmp_path, monkeypatch):
    # Cheap Houston, expensive West, North and South in between; the headline price is North's.
    prices = {"Houston": 10.0, "North": 40.0, "South": 40.0, "West": 80.0}
    tape = replace(frame(price=40.0), zone_prices=prices, zone_price_label="synthetic")
    record, seen = play(tmp_path, monkeypatch, [tape])
    tick, data = record["ticks"][0], seen[0]
    story(24, "zone prices", tick, data, f" | intent_reason {tick['intent_reason']}")
    policy, planned = data["policy"], data["cycle"].allocation.per_home_kw
    assert policy.zone_intent == {"Houston": "charge", "North": "hold", "South": "hold",
                                  "West": "discharge"}
    zone_of = {h.home_id: h.zone for h in data["homes"]}
    sellers = {i for i, kw in planned.items() if kw > 0}
    chargers = {i for i, kw in planned.items() if kw < 0}
    # The call is met, and only the non-cheap zones sell for it: just what the call needs.
    assert tick["delivered_mw"] == pytest.approx(0.2)
    assert sold_kw(data) == pytest.approx(200.0)
    assert sellers and {zone_of[i] for i in sellers} <= {"West", "North", "South"}
    # Every live Houston home charges (they start 45-75% full, so all have room); no other zone does.
    assert chargers == {i for i in fleet_ids("Houston") if data["status"][i] == "live"}
    assert gained_kwh(data) > 0
    # The label is what the fleet was ordered to do.
    assert (tick["intent"], tick["intent_reason"]) == acted_intent(data["cycle"].allocation,
                                                                   policy, "AUTO")
