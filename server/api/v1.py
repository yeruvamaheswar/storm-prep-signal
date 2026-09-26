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

from server.api.fixtures import LIVE_SCENES, FixtureStore

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


@router.get("/zone")
def get_zone(request: Request):
    return _store(request).load("zone")


@router.get("/live")
def get_live(request: Request):
    return current_tick(_store(request), _state(request))


@router.get("/live/stream")
def get_live_stream(request: Request):
    tick = current_tick(_store(request), _state(request))

    # Scaffold: one tick frame, then the stream closes. The client falls back to GET /v1/live.
    def frames():
        yield f"event: tick\ndata: {json.dumps(tick)}\n\n"

    return StreamingResponse(frames(), media_type="text/event-stream")


@router.get("/homes")
def get_homes(request: Request, status: Optional[str] = None):
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
    # Recorded only. The engine will apply it on the next tick; fixtures do not change.
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
