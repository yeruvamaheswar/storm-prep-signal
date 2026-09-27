"""Scenario sessions for the /flow page: one engine tick at a time over an archive tape.

scripts/scenario_session.py is the only process that runs the engine here. The API only appends
operator requests to var/scenario/requests.json and reads var/scenario/state.json, so no route
allocates or sets a floor (CONSTRAINTS.md "Backend").

Each start or reset gives every battery a random starting charge from a seeded draw, so the
same seed replays the same fleet and the same ticks. Weather alerts are real archived NWS alerts
(data/fixtures/nws/); the operator picks when to send one, and it applies from the next tick.
"""
import json
import os
import random
from dataclasses import asdict, replace
from datetime import datetime, timezone
from pathlib import Path

from server.engine.baseline import load_baseline
from server.engine.brief import write_brief
from server.engine.events import start_run
from server.engine.fleet import new_fleet
from server.engine.loop import load_tape, play_frame, with_fleet_defaults
from server.engine.order_log import order_timelines
from server.engine.score import new_board, update
from server.engine.telemetry import TelemetryState, data_status, plan_status
from server.engine.tick_emit import build_tick_emit

SCENARIO_DIR = Path("var") / "scenario"
CATALOG_PATH = Path("tapes") / "scenarios" / "catalog.json"
ALERT_DIR = Path("data") / "fixtures" / "nws"
JEV_DIR = Path("data") / "fixtures" / "jev"
# 25 homes per zone, so every battery can be drawn on the page.
SCENARIO_FLEET_SIZE = 100
# Wide on purpose: some batteries start under the 30% floor, some near full.
SOC_RANGE_PCT = (10.0, 95.0)
# Time-lapse factors: scenario seconds per wall second. 300 plays one 5-minute tick per second.
SPEEDS = (15, 30, 60, 150, 300, 600)
DEFAULT_SPEED = 300
# The page calls the worker gone when state.json has not been rewritten for this long.
STALE_AFTER_S = 10
HIST_BINS = 10
HISTORY_POINTS = 300
LOG_LINES = 12
KW_EPS = 1e-6
# A battery within this many percent of its floor is "at floor", not holding spare charge.
FLOOR_BAND_PCT = 0.5
REQUEST_KINDS = ("start", "reset", "play", "speed", "alert", "grid_down")
HONEST_LIMITS = (
    "The fleet is simulated. Each battery's starting charge is a seeded random draw.",
    "The grid ask (target MW) is synthetic; no public dispatch target exists.",
    "ERCOT outage postings and zone prices are the recorded archive rows listed here.",
    "Weather alerts are real archived NWS text; the operator chooses when to send them.",
    "Hand-placed overlays are labeled as overlays.",
    "Pack: 25 kWh, 11.4 kW (example settings, not Base specs), shown in time-lapse.",
    "Rules make every decision. JEV is a shadow reading and never dispatches.",
)


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json_atomic(path, value):
    """Write then rename, so a reader never sees half a file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(value), encoding="utf-8")
    os.replace(tmp, path)


# --- catalog and alerts (read-only files) ---

def load_catalog(path=CATALOG_PATH):
    """The scenario list. A missing file is an empty list, not an error: the page says so."""
    data = read_json(path, {"scenarios": []})
    return data.get("scenarios", []) if isinstance(data, dict) else []


def find_scenario(catalog, scenario_id):
    for entry in catalog:
        if entry.get("id") == scenario_id:
            return entry
    return None


def load_alert(alert_id, alert_dir=ALERT_DIR):
    """One archived NWS alert fixture, or None when the file is missing."""
    alert = read_json(Path(alert_dir) / f"{alert_id}.json", None)
    if not isinstance(alert, dict):
        return None
    return {**alert, "id": alert_id}


def alert_summary(alert):
    """What the picker and the data panel show; the full description stays in the fixture."""
    keys = ("id", "event", "headline", "areaDesc", "onset", "expires", "sent", "sender", "source_url",
            "source_label", "counties")
    return {key: alert.get(key) for key in keys if key in alert}


def alert_zones(alert, settings):
    """Load zones named by the alert's county FIPS codes, and codes that match no zone.

    The NWS SAME code is 0 + state + county ("048201"); ZONES holds "48201".
    """
    fips_to_zone = {fips: zone for zone, fips in settings["zones"].items()}
    zones, unknown = set(), []
    for code in alert.get("counties", []):
        fips = str(code)[-5:]
        if fips in fips_to_zone:
            zones.add(fips_to_zone[fips])
        else:
            unknown.append(str(code))
    return sorted(zones), unknown


def load_jev(alert_id, jev_dir=JEV_DIR):
    return read_json(Path(jev_dir) / f"{alert_id}.json", None)


# --- request inbox (the API writes, the worker reads) ---

def append_request(kind, body, operator, scenario_dir=SCENARIO_DIR):
    """Record one operator request. The worker applies it on its next loop."""
    if kind not in REQUEST_KINDS:
        raise ValueError(f"unknown scenario request {kind!r}")
    path = Path(scenario_dir) / "requests.json"
    requests_list = read_json(path, [])
    if not isinstance(requests_list, list):
        requests_list = []
    seq = (requests_list[-1]["seq"] + 1) if requests_list else 1
    request = {"seq": seq, "kind": kind, "body": dict(body), "operator": operator, "at": utc_now()}
    # Keep the file short; the worker only needs what it has not applied yet.
    write_json_atomic(path, (requests_list + [request])[-200:])
    return request


def read_requests(after_seq, scenario_dir=SCENARIO_DIR):
    requests_list = read_json(Path(scenario_dir) / "requests.json", [])
    if not isinstance(requests_list, list):
        return []
    return [r for r in requests_list if isinstance(r, dict) and r.get("seq", 0) > after_seq]


def last_request_seq(scenario_dir=SCENARIO_DIR):
    pending = read_requests(0, scenario_dir)
    return pending[-1]["seq"] if pending else 0


# --- state file (the worker writes, the API reads) ---

def write_state(state, scenario_dir=SCENARIO_DIR):
    write_json_atomic(Path(scenario_dir) / "state.json", state)


def read_state(scenario_dir=SCENARIO_DIR, now=None):
    """The worker's last state, or a named not-running body when it is missing or old."""
    state = read_json(Path(scenario_dir) / "state.json", None)
    if not isinstance(state, dict) or "updated_at" not in state:
        return {"status": "worker_not_running", "brief": "Start it: python scripts/scenario_session.py"}
    now = now or datetime.now(timezone.utc)
    try:
        age_s = (now - datetime.fromisoformat(state["updated_at"])).total_seconds()
    except (TypeError, ValueError):
        age_s = None
    if age_s is None or age_s > STALE_AFTER_S:
        return {"status": "worker_not_running", "brief": "The session worker stopped writing state.",
                "last_state_at": state.get("updated_at")}
    return state


# --- the session ---

def seed_fleet(settings, seed):
    """new_fleet ids, zones and pack size, with each starting charge drawn from SOC_RANGE_PCT."""
    homes = new_fleet(settings)
    rng = random.Random(seed)
    low, high = SOC_RANGE_PCT
    for home in homes:
        home.soc_kwh = round(home.capacity_kwh * rng.uniform(low, high) / 100, 3)
    return homes


def soc_histogram(homes, bins=HIST_BINS):
    counts = [0] * bins
    for home in homes:
        pct = 100 * home.soc_kwh / home.capacity_kwh
        counts[min(bins - 1, int(pct * bins / 100))] += 1
    return counts


def floor_pct_for(home, policy_view):
    return policy_view["zone_reserve_pct"].get(home.zone, policy_view["reserve_pct"])


def home_state(home, emit, floor_pct, zone_reason, grid_down):
    """One word for how the battery is behaving this tick, from confirmed kW and its status."""
    if home.status in ("dead", "stale"):
        return home.status
    command = emit.get("command")
    if command is not None and command.get("ack") == "timeout":
        return "unconfirmed"
    kw = emit.get("power_kw", 0.0)
    if kw > KW_EPS:
        return "selling"
    if kw < -KW_EPS:
        return "charging"
    if grid_down:
        return "islanded"
    soc_pct = 100 * home.soc_kwh / home.capacity_kwh
    if soc_pct < floor_pct - FLOOR_BAND_PCT:
        return "below_floor"
    # Drained to its floor: everything above it was sold, so there is nothing left to give.
    if soc_pct <= floor_pct + FLOOR_BAND_PCT:
        return "at_floor"
    if zone_reason not in ("normal", "", None):
        return "reserved"
    return "holding"


class Session:
    """One scenario playing on a seeded random fleet. Mutated only by the worker process."""

    def __init__(self, settings, catalog, log_dir=SCENARIO_DIR / "logs", alert_dir=ALERT_DIR,
                 jev_dir=JEV_DIR):
        self.settings = with_fleet_defaults(settings)
        self.settings["fleet_size"] = SCENARIO_FLEET_SIZE
        self.catalog = catalog
        self.log_dir, self.alert_dir, self.jev_dir = Path(log_dir), Path(alert_dir), Path(jev_dir)
        self.scenario = None
        self.frames, self.baseline, self.sidecar = [], None, {}
        self.index, self.playing, self.speed = 0, False, DEFAULT_SPEED
        self.seed, self.homes, self.telemetry, self.board = None, [], None, None
        self.mode = "AUTO"
        self.start_summary, self.last, self.history = {}, None, []
        self.started_under = set()   # home ids whose random starting charge was under the base floor
        self.active_alerts, self.grid_down_zones = [], []
        self.messages = []
        self.error = None

    # requests

    def apply(self, request):
        """Apply one inbox request. A bad request is logged on the page, never raised."""
        kind, body = request.get("kind"), request.get("body") or {}
        try:
            if kind == "start":
                self.start(body.get("scenario"), body.get("seed"))
            elif kind == "reset":
                self.reset(body.get("seed"))
            elif kind == "play":
                self.set_playing(bool(body.get("playing")))
            elif kind == "speed":
                self.set_speed(body.get("x"))
            elif kind == "alert":
                self.send_alert(body.get("alert_id"))
            elif kind == "grid_down":
                self.set_grid_down(body.get("zone"), bool(body.get("down", True)))
            else:
                raise ValueError(f"unknown request {kind!r}")
        except ValueError as exc:
            self.note(f"refused {kind}: {exc}")

    def start(self, scenario_id, seed=None):
        entry = find_scenario(self.catalog, scenario_id)
        if entry is None:
            raise ValueError(f"no scenario {scenario_id!r}")
        self.scenario = entry
        self.frames = load_tape(entry["tape"])
        self.baseline = load_baseline(entry["baseline"], lookahead_hours=self.settings["lookahead_hours"])
        sidecar = read_json(entry["provenance"], {}) if entry.get("provenance") else {}
        self.sidecar = sidecar if isinstance(sidecar, dict) else {}
        start_run(self.log_dir)
        self.note(f"started {entry['name']}")
        self.reset(seed)
        self.playing = True

    def reset(self, seed=None):
        """New random fleet (same scenario), back to the first tick. Overlays are cleared."""
        if self.scenario is None:
            raise ValueError("pick a scenario first")
        self.seed = int(seed) if seed else random.SystemRandom().randrange(1, 1_000_000)
        self.settings["seed"] = self.seed
        self.homes = seed_fleet(self.settings, self.seed)
        self.telemetry = (TelemetryState(self.homes, self.settings, self.seed)
                          if self.settings.get("telemetry_feed") else None)
        self.board = new_board(self.settings)
        self.index, self.mode, self.last, self.history = 0, "AUTO", None, []
        self.active_alerts, self.grid_down_zones, self.error = [], [], None
        self.start_summary = self.summarize_start()
        self.started_under = {h.home_id for h in self.homes
                              if 100 * h.soc_kwh / h.capacity_kwh < self.settings["base_reserve_pct"]}
        self.note(f"fleet seeded (seed {self.seed})")

    def set_playing(self, playing):
        if self.scenario is None:
            raise ValueError("pick a scenario first")
        if playing and self.index >= len(self.frames):
            self.reset(self.seed)
        self.playing = playing

    def set_speed(self, x):
        if x not in SPEEDS:
            raise ValueError(f"speed must be one of {SPEEDS}")
        self.speed = x

    def send_alert(self, alert_id):
        if self.scenario is None:
            raise ValueError("pick a scenario first")
        if alert_id not in self.scenario.get("alerts", []):
            raise ValueError(f"alert {alert_id!r} is not part of this scenario")
        alert = load_alert(alert_id, self.alert_dir)
        if alert is None:
            raise ValueError(f"alert fixture {alert_id!r} is missing")
        zones, unknown = alert_zones(alert, self.settings)
        if unknown:
            self.note(f"alert counties with no load zone ignored: {', '.join(unknown)}")
        if not zones:
            raise ValueError("alert names no county in the ZONES setting")
        if any(a["id"] == alert_id for a in self.active_alerts):
            raise ValueError("alert already sent")
        sent_tick = self.frames[self.index].tick if self.index < len(self.frames) else None
        self.active_alerts.append({**alert_summary(alert), "zones": zones, "sent_at_tick": sent_tick,
                                   "jev": load_jev(alert_id, self.jev_dir)})
        self.note(f"alert sent: {alert.get('event')} for {', '.join(zones)}, applies from the next tick")

    def set_grid_down(self, zone, down):
        if self.scenario is None:
            raise ValueError("pick a scenario first")
        if not self.scenario.get("grid_down_overlay"):
            raise ValueError("this scenario has no grid-down overlay")
        if zone not in self.settings["zones"]:
            raise ValueError(f"unknown zone {zone!r}")
        zones = set(self.grid_down_zones)
        if down:
            zones.add(zone)
        else:
            zones.discard(zone)
        self.grid_down_zones = sorted(zones)
        self.note(f"overlay: grid {'down' if down else 'restored'} in {zone}, applies from the next tick")

    # ticks

    def step_seconds(self):
        return self.settings["tick_minutes"] * 60 / self.speed

    def alert_active(self, alert, ts):
        """Active from the tick after it was sent until its archived expiry (scenario time)."""
        expires = alert.get("expires")
        if not expires:
            return True
        return datetime.fromisoformat(ts) <= datetime.fromisoformat(expires)

    def overlay(self, frame):
        """This frame with the operator's overlays added to its events."""
        events = dict(frame.events)
        zones = set(events.get("weather", []))
        for alert in self.active_alerts:
            if self.alert_active(alert, frame.ts):
                zones.update(alert["zones"])
        if zones:
            events["weather"] = sorted(zones)
        if self.grid_down_zones:
            events["grid_down"] = sorted(set(events.get("grid_down", [])) | set(self.grid_down_zones))
        return replace(frame, events=events)

    def step(self):
        """Play the next frame through the engine. Returns False when the tape is done."""
        if self.index >= len(self.frames):
            self.playing = False
            return False
        frame = self.overlay(self.frames[self.index])
        self.mode = frame.events.get("operator", self.mode)
        soc_before = {home.home_id: round(100 * home.soc_kwh / home.capacity_kwh, 2) for home in self.homes}
        feed_status = self.feed_statuses()
        result, cycle, policy, scaled, risk = play_frame(
            frame, self.homes, self.settings, self.baseline, self.mode, telemetry=self.telemetry)
        self.board = update(self.board, result, self.homes)
        emit = build_tick_emit(scaled, self.homes, cycle)
        self.last = self.describe_tick(result, emit, policy, scaled, risk, cycle, soc_before, feed_status)
        self.history = (self.history + [{
            "tick": result.tick, "ts": result.ts, "target_mw": result.target_mw,
            "delivered_mw": result.delivered_mw, "charging_mw": self.last["charging_mw"],
            "missed_mw": result.missed_mw, "unconfirmed_mw": cycle.unconfirmed_mw,
            "reserve_pct": result.reserve_pct, "risk_level": result.risk_level,
            "reasons": list(result.reasons), "breaches": result.breaches,
            "intent": result.intent, "intent_reason": result.intent_reason,
        }])[-HISTORY_POINTS:]
        self.index += 1
        if self.index >= len(self.frames):
            self.playing = False
            self.note("scenario finished")
        return True

    def feed_statuses(self):
        """Each home's data status as the next plan will read it, or None without a feed.

        orchestrate_tick plans from telemetry.reported_homes before any reading of the new tick
        arrives, so the age of the newest accepted reading is the same now as at plan time.
        The feed moves its clock on when the tick finishes, so this is taken before play_frame.
        """
        if self.telemetry is None:
            return None
        return {home_id: data_status(hs, self.telemetry.base_s, self.telemetry.settings)
                for home_id, hs in self.telemetry.homes.items()}

    def describe_tick(self, result, emit, policy, frame, risk, cycle, soc_before, feed_status=None):
        tick = {**asdict(result), "brief": write_brief(result)}
        policy_view = {"reserve_pct": policy.reserve_pct, "zone_reserve_pct": policy.zone_reserve_pct}
        grid_down = set(frame.events.get("grid_down", []))
        homes, zones = [], {}
        for home in self.homes:
            home_emit = emit["homes"][home.home_id]
            floor_pct = floor_pct_for(home, policy_view)
            reason = policy.zone_reasons.get(home.zone, policy.reason)
            state = home_state(home, home_emit, floor_pct, reason, home.zone in grid_down)
            kw = home_emit["power_kw"]
            homes.append({"id": home.home_id, "zone": home.zone, "soc_pct": round(100 * home.soc_kwh / home.capacity_kwh, 2),
                          "soc_before_pct": soc_before.get(home.home_id),
                          "kw": round(kw, 3), "state": state, "status": home.status, "floor_pct": floor_pct,
                          "under_floor_why": self.under_floor_why(home, state, floor_pct),
                          # What allocate saw: the reported status with the feed, else the home's own.
                          "plan_status": (home.status if feed_status is None
                                          else plan_status(home.status, feed_status[home.home_id]))})
            row = zones.setdefault(home.zone, {
                "selling_mw": result.zone_delivered_mw.get(home.zone, 0.0),
                "charging_mw": result.zone_charging_mw.get(home.zone, 0.0),
                "reserve_pct": floor_pct, "reason": reason, "price_usd_mwh": result.zone_prices.get(home.zone),
                "grid_down": home.zone in grid_down, "homes": 0, "states": {}, "soc_mwh": 0.0,
            })
            row["homes"] += 1
            row["states"][state] = row["states"].get(state, 0) + 1
            row["soc_mwh"] += home.soc_kwh / 1000
        return {"result": tick, "homes": homes, "zones": zones,
                "orders": order_timelines(cycle.events, cycle.allocation.per_home_kw),
                "charging_mw": result.charging_mw,
                "provenance": self.provenance(frame, risk)}

    # what the page shows

    def provenance(self, frame, risk):
        """Every input this tick read, named by file and archive row."""
        posting = None
        if frame.risk_fixture:
            fixture = read_json(frame.risk_fixture, {})
            rows = fixture.get("data") or []
            names = [f.get("name") for f in fixture.get("fields", [])]
            posted = rows[0][names.index("postedDatetime")] if rows and "postedDatetime" in names else None
            posting = {"report": "NP3-233-CD", "table": "public.ercot_postings", "file": frame.risk_fixture,
                       "posted_at": posted, "rows": len(rows), "source": fixture.get("source")}
        rating = None
        if risk is not None:
            rating = {key: getattr(risk, key) for key in
                      ("level", "peak_mw", "peak_hour", "trigger_mw", "baseline_mw", "margin_mw", "driving_zone")}
        baseline = {"file": self.scenario["baseline"], "postings": self.baseline.get("postings"),
                    "from": self.baseline.get("from"), "to": self.baseline.get("to"),
                    "source": self.baseline.get("source")}
        return {
            "tick": frame.tick, "ts": frame.ts,
            "posting": posting, "rating": rating,
            "price": {"usd_mwh": frame.price_usd_mwh, "label": frame.price_label},
            "zone_prices": {"label": frame.zone_price_label, "zones": dict(frame.zone_prices)},
            "target": {"mw": frame.target_mw, "label": frame.target_label},
            "baseline": baseline,
            "events": dict(frame.events),
            "archive_rows": self.sidecar.get(str(frame.tick)),
        }

    def under_floor_why(self, home, state, floor_pct):
        """The engine never sells below a floor, so a battery under one either began there or the floor rose.

        A battery refilling to its floor reads `charging`; it still gets the reason while under it.
        """
        under = 100 * home.soc_kwh / home.capacity_kwh < floor_pct - FLOOR_BAND_PCT
        if state not in ("below_floor", "charging") or not under:
            return None
        base = self.settings["base_reserve_pct"]
        if home.home_id in self.started_under and 100 * home.soc_kwh / home.capacity_kwh < base - FLOOR_BAND_PCT:
            return "started_under"
        return "floor_raised"

    def summarize_start(self):
        below = {}
        base = self.settings["base_reserve_pct"]
        for home in self.homes:
            if 100 * home.soc_kwh / home.capacity_kwh < base:
                below[home.zone] = below.get(home.zone, 0) + 1
        pcts = [100 * h.soc_kwh / h.capacity_kwh for h in self.homes]
        return {"seed": self.seed, "range_pct": list(SOC_RANGE_PCT), "histogram": soc_histogram(self.homes),
                "min_pct": round(min(pcts), 1), "max_pct": round(max(pcts), 1),
                "mean_pct": round(sum(pcts) / len(pcts), 1), "below_base_floor": below,
                "base_floor_pct": base, "homes": len(self.homes),
                "pack": {"kwh": self.settings["home_kwh"], "kw": self.settings["home_max_kw"]}}

    def note(self, text):
        self.messages = (self.messages + [{"at": utc_now(), "text": text}])[-LOG_LINES:]

    def status(self):
        if self.error:
            return "error"
        if self.scenario is None:
            return "idle"
        if self.index >= len(self.frames):
            return "finished"
        return "playing" if self.playing else "paused"

    def state(self):
        scenario = None
        if self.scenario is not None:
            scenario = {key: self.scenario.get(key) for key in
                        ("id", "name", "event", "window", "summary", "tape", "baseline", "label", "grid_down_overlay")}
            # Each alert's load zones, so the weather step can name the zones a grid-down overlay covers.
            scenario["alerts"] = [{**alert_summary(a), "zones": alert_zones(a, self.settings)[0]} for a in
                                  (load_alert(i, self.alert_dir) for i in self.scenario.get("alerts", [])) if a]
        live_homes = self.last["homes"] if self.last else [
            {"id": h.home_id, "zone": h.zone, "soc_pct": round(100 * h.soc_kwh / h.capacity_kwh, 2), "kw": 0.0,
             "state": "holding", "status": h.status, "floor_pct": self.settings["base_reserve_pct"]}
            for h in self.homes]
        return {
            "status": self.status(), "error": self.error, "updated_at": utc_now(), "pid": os.getpid(),
            "scenario": scenario, "seed": self.seed, "speed": self.speed, "speeds": list(SPEEDS),
            "step_seconds": self.step_seconds(), "tick_minutes": self.settings["tick_minutes"],
            "tick_index": self.index, "tick_count": len(self.frames),
            "start": self.start_summary,
            "tick": self.last["result"] if self.last else None,
            "homes": live_homes,
            "orders": self.last["orders"] if self.last else {},
            "zones": self.last["zones"] if self.last else {},
            "charging_mw": self.last["charging_mw"] if self.last else 0.0,
            "provenance": self.last["provenance"] if self.last else None,
            "alerts": self.active_alerts,
            "grid_down_zones": self.grid_down_zones,
            "history": self.history, "totals": self.board, "log": self.messages,
            "honest_limits": list(HONEST_LIMITS),
        }
