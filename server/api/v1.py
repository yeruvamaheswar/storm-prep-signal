"""The /v1 routes. Reads come from fixtures; writes only change in-memory console state.

Nothing here allocates, rates risk, or sets a reserve floor. That stays in server.engine.
"""

import copy
import json
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal, Optional

from fastapi import APIRouter, Header, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from server.api.archive import event_for_clock
from server.api.feeds import FEED_EVENTS, list_feeds, serve_outage, serve_price
from server.api.fixtures import LIVE_SCENES, FixtureStore
from server.api.snapshot import archive_ingest, build_meta, build_snapshot, load_latest_run, tick_clock
from server.engine.fleet import current_rollups
from server.engine.fleet_state import write_fleet_mode

router = APIRouter(prefix="/v1")


class ApiError(Exception):
    """Becomes `{ "error", "brief" }`, the body the wall reads on a refused write."""

    def __init__(self, status: int, error: str, brief: str):
        self.status = status
        self.error = error
        self.brief = brief


@dataclass
class ConsoleState:
    scene: str = "live-ok"
    mode_requested: Optional[str] = None
    playback: Optional[dict] = None
    spent_retries: set = field(default_factory=set)
    answered: dict = field(default_factory=dict)


class ModeBody(BaseModel):
    mode: Literal["HOLD", "AUTO"]


class AttentionBody(BaseModel):
    choice: Literal["approve", "retry", "skip"]


class PlaybackBody(BaseModel):
    tape_id: str


def _store(request: Request) -> FixtureStore:
    return request.app.state.fixtures


def _state(request: Request) -> ConsoleState:
    return request.app.state.console


def _require_operator(operator_id: Optional[str]) -> str:
    # Every write is tied to a named operator; there is no anonymous or homeowner write.
    if not operator_id:
        raise ApiError(401, "operator_required", "Send X-Operator-Id with every write.")
    return operator_id


def _parse_ts(value: str, name: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ApiError(422, "bad_time", f"{name} is not an ISO 8601 time.")
    if parsed.tzinfo is None:
        raise ApiError(422, "bad_time", f"{name} needs a UTC offset.")
    return parsed


def current_tick(store: FixtureStore, state: ConsoleState) -> dict:
    name = "playback" if state.playback else state.scene
    tick = copy.deepcopy(store.load(name))
    attention = tick.get("attention")
    # Show a spent retry the way the contract does: flag set, retry no longer offered.
    if attention and attention["attention_id"] in state.spent_retries:
        attention["retry_spent"] = True
        attention["choices"] = [c for c in attention["choices"] if c != "retry"]
    return tick


@router.get("/meta")
def get_meta(event: Optional[str] = None, clock: Optional[str] = None):
    # Live, archive, or the layout fixture. clock is wall, fixture, or archive.
    return build_meta(event=event, clock=clock)


def _run_or_none():
    try:
        return load_latest_run()
    except FileNotFoundError:
        return None


def _archive_clock(run):
    ticks = run.get("ticks") if isinstance(run, dict) else None
    if not ticks:
        return None
    return tick_clock(ticks[-1])


def _feed_kwargs(run):
    """Demo/Synthetic reads the archive at the tape clock. Live keeps signal.py."""
    if run is None or build_meta(run)["source"] == "live":
        return {}
    clock = _archive_clock(run)
    meta = build_meta(run)
    return {
        "source": "archive",
        "event": meta.get("event") or (event_for_clock(clock) if clock else None),
        "clock": clock,
    }


def current_snapshot(run, event: Optional[str] = None, clock: Optional[str] = None, zone: Optional[str] = None):
    """Live rates the ERCOT body. Archive pins the saved posting clock."""
    meta = build_meta(run, event=event, clock=clock)
    if meta["source"] == "archive":
        return build_snapshot(event=meta["event"], clock=clock, zone=zone)
    if meta["mode"] == "live":
        return build_snapshot(zone=zone)
    pinned = _archive_clock(run)
    if pinned is None:
        return build_snapshot(zone=zone)
    named = event or event_for_clock(pinned)
    if not named:
        return build_snapshot(zone=zone)
    return build_snapshot(now=pinned, event=named, clock=clock, zone=zone)


@router.get("/snapshot")
def get_snapshot(event: Optional[str] = None, clock: Optional[str] = None, zone: Optional[str] = None):
    # Demo + event pins the archive clock. Live pulls ERCOT.
    # zone picks that LZ's archive/live row for price_usd_mwh when a row exists.
    try:
        return current_snapshot(load_latest_run(), event=event, clock=clock, zone=zone)
    except FileNotFoundError:
        raise ApiError(404, "no_run", "No run file is available.")


@router.get("/runs/latest")
def get_latest_run():
    try:
        return load_latest_run()
    except FileNotFoundError:
        raise ApiError(404, "no_run", "No run file is available.")


@router.get("/feeds")
def get_feeds(event: Optional[str] = None):
    chosen = event or _feed_kwargs(_run_or_none()).get("event") or "beryl"
    if chosen not in FEED_EVENTS:
        raise ApiError(422, "bad_event", "event must be beryl, heather, or tuning-2026.")
    return list_feeds(chosen)


@router.get("/feeds/outage")
def get_outage_feed():
    return serve_outage(**_feed_kwargs(_run_or_none()))


@router.get("/feeds/price")
def get_price_feed():
    return serve_price(**_feed_kwargs(_run_or_none()))


@router.get("/zone")
def get_zone(request: Request):
    return _store(request).load("zone")


@router.get("/live")
def get_live(request: Request):
    return current_tick(_store(request), _state(request))


def _sse(event: str, data: object) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def home_rollup(tick: dict) -> dict:
    """Fleet counts only. The stream never sends one row per home."""
    fleet = tick.get("fleet")
    if isinstance(fleet, dict) and "live" in fleet:
        return {
            "live": fleet.get("live", 0),
            "stale": fleet.get("stale", 0),
            "dead": fleet.get("dead", 0),
            "unconfirmed": fleet.get("unconfirmed", 0),
            "breaches": fleet.get("breaches", 0),
        }
    return {
        "live": tick.get("live_homes", 0),
        "stale": tick.get("stale_homes", 0),
        "dead": tick.get("dead_homes", 0),
        "unconfirmed": tick.get("unconfirmed_homes", 0),
        "breaches": tick.get("breaches", 0),
    }


def feeds_event(tick: dict) -> dict:
    rows = tick.get("feeds")
    return {
        "quality": tick.get("quality") or tick.get("stress_quality") or "ok",
        "as_of": tick.get("as_of") or tick.get("stress_as_of"),
        "feed": tick.get("feed"),
        "rows": rows if isinstance(rows, list) else [],
    }


@router.get("/live/stream")
def get_live_stream(request: Request):
    # Scaffold names: tick | attention | home. Live also sends feeds.
    # home is a fleet rollup, never 10k home rows. The wall polls /v1/snapshot
    # every 20 s; this burst is the same facts for createClient.
    tick = current_tick(_store(request), _state(request))
    try:
        snapshot = build_snapshot()
    except FileNotFoundError:
        snapshot = None
    rollup_src = snapshot if snapshot is not None else tick

    def frames():
        yield _sse("tick", tick)
        yield _sse("feeds", feeds_event(rollup_src))
        attention = tick.get("attention")
        if attention:
            yield _sse("attention", attention)
        yield _sse("home", home_rollup(rollup_src))

    return StreamingResponse(frames(), media_type="text/event-stream")


@router.get("/fleet/rollups")
def get_fleet_rollups():
    # Zone counts and MW only. Never the seeded homes list.
    return current_rollups()


@router.get("/homes")
def get_homes(request: Request, status: Optional[str] = None):
    # Fixture rows for the console list. Do not load var/fleet homes.json here.
    homes = _store(request).load("homes")
    if status is None:
        return homes
    return [h for h in homes if h["status"] == status]


@router.get("/homes/{home_id}")
def get_home(request: Request, home_id: str):
    for home in _store(request).load("homes"):
        if home["home_id"] == home_id:
            return home
    raise ApiError(404, "unknown_home", f"No home {home_id}.")


@router.get("/ticks")
def get_ticks(request: Request, to: str, from_: str = Query(alias="from")):
    start = _parse_ts(from_, "from")
    end = _parse_ts(to, "to")
    ticks = _store(request).all_ticks()
    return [t for t in ticks if start <= _parse_ts(t["ts"], "ts") <= end]


@router.get("/ticks/{tick_id}")
def get_tick(request: Request, tick_id: str):
    for tick in _store(request).all_ticks():
        if tick["tick_id"] == tick_id:
            return tick
    raise ApiError(404, "unknown_tick", f"No tick {tick_id}.")


@router.get("/tapes")
def get_tapes(request: Request):
    return _store(request).load("tapes")


@router.get("/playback")
def get_playback(request: Request):
    return _state(request).playback


@router.post("/fleet/mode", status_code=202)
def post_mode(request: Request, body: ModeBody, x_operator_id: Optional[str] = Header(None)):
    _require_operator(x_operator_id)
    state = _state(request)
    if state.playback:
        raise ApiError(409, "playback_running", "Mode cannot change during playback.")
    # Persist so the next allocate() and GET /v1/snapshot share this mode.
    write_fleet_mode(body.mode)
    state.mode_requested = body.mode
    return {"mode_requested": body.mode}


@router.post("/attention/{attention_id}", status_code=202)
def post_attention(
    request: Request,
    attention_id: str,
    body: AttentionBody,
    x_operator_id: Optional[str] = Header(None),
):
    operator = _require_operator(x_operator_id)
    state = _state(request)
    attention = current_tick(_store(request), state).get("attention")
    if not attention or attention["attention_id"] != attention_id:
        raise ApiError(409, "unknown_attention", f"No open attention {attention_id}.")
    if body.choice not in attention["choices"]:
        raise ApiError(409, "retry_spent", "Retry was already used. Approve or skip.")
    if body.choice == "retry":
        state.spent_retries.add(attention_id)
    # No choice returns the fleet to AUTO; the fleet stays in RESERVE until two calm readings.
    state.answered[attention_id] = {"choice": body.choice, "operator": operator}
    return {"attention_id": attention_id, "choice": body.choice}


@router.post("/playback", status_code=202)
def post_playback(request: Request, body: PlaybackBody, x_operator_id: Optional[str] = Header(None)):
    _require_operator(x_operator_id)
    state = _state(request)
    if state.playback:
        raise ApiError(409, "playback_running", "A tape is already playing. Stop it first.")
    tapes = {t["tape_id"]: t for t in _store(request).load("tapes")}
    tape = tapes.get(body.tape_id)
    if tape is None:
        raise ApiError(409, "unknown_tape", f"No tape {body.tape_id}.")
    state.playback = {"tape_id": tape["tape_id"], "tick_index": 0, "tick_count": tape["ticks"]}
    return state.playback


@router.post("/playback/stop", status_code=202)
def post_playback_stop(request: Request, x_operator_id: Optional[str] = Header(None)):
    _require_operator(x_operator_id)
    _state(request).playback = None
    return None


def valid_scene(name: str) -> str:
    if name not in LIVE_SCENES:
        raise ValueError(f"CONSOLE_SCENE must be one of {', '.join(LIVE_SCENES)}")
    return name
