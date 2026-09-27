"""/v1 scenario routes for the /flow page.

Writes only append an operator request to var/scenario/requests.json; reads return files, or
(verify) the Supabase archive rows for one clock.
scripts/scenario_session.py applies the requests and runs the engine. Nothing here allocates,
rates risk, or sets a reserve floor (CONSTRAINTS.md "Backend").
"""

from datetime import timedelta
from typing import Literal, Optional

from fastapi import APIRouter, Header
from pydantic import BaseModel, Field

from server.api import archive
from server.api.prices import POINT_TO_ZONE
from server.api.v1 import ApiError, _require_operator
from server.engine import scenario as store

router = APIRouter(prefix="/v1")
PRICE_INTERVAL = timedelta(minutes=15)


class StartBody(BaseModel):
    scenario: str
    seed: Optional[int] = Field(default=None, ge=1)


class ResetBody(BaseModel):
    seed: Optional[int] = Field(default=None, ge=1)


class PlayBody(BaseModel):
    playing: bool


class SpeedBody(BaseModel):
    x: int


class AlertBody(BaseModel):
    alert_id: str


class GridDownBody(BaseModel):
    zone: Literal["Houston", "North", "South", "West"]
    down: bool = True


def _catalog():
    return store.load_catalog()


def _record(kind: str, body: dict, operator: str) -> dict:
    request = store.append_request(kind, body, operator, store.SCENARIO_DIR)
    # 202: recorded, applied by the worker on its next loop.
    return {"accepted": request["seq"], "kind": kind}


@router.get("/scenarios")
def get_scenarios():
    scenarios = []
    for entry in _catalog():
        alerts = [store.load_alert(alert_id, store.ALERT_DIR) for alert_id in entry.get("alerts", [])]
        scenarios.append({**entry, "alerts": [store.alert_summary(a) for a in alerts if a]})
    return {"scenarios": scenarios, "speeds": list(store.SPEEDS), "default_speed": store.DEFAULT_SPEED}


@router.get("/scenario/state")
def get_scenario_state():
    return store.read_state(store.SCENARIO_DIR)


@router.get("/scenario/verify")
def get_scenario_verify(event: str, clock: str):
    """Supabase rows for this clock by the tape builder's rules (scripts/build_tape.py)."""
    try:
        when = archive.as_central(clock)
    except ValueError:
        raise ApiError(422, "bad_clock", "clock must be an ISO time.") from None
    try:
        # Posting: newest at or before the clock. Price: the 15-minute interval that holds the
        # clock (build_tape.price_at), which is the newest interval ending by clock + 15 min.
        outage = archive.read_outage(event, when)
        prices = archive.read_prices(event, when + PRICE_INTERVAL)
    except archive.ArchiveUnavailable as exc:
        raise ApiError(503, f"archive_{exc.quality}", f"Supabase archive: {exc.reason}.") from None
    zones = {
        POINT_TO_ZONE[row["settlement_point"]]: row["price_usd_mwh"]
        for row in prices["rows"]
        if row.get("settlement_point") in POINT_TO_ZONE
    }
    return {
        "event": event,
        "clock": when.isoformat(),
        "posted_at": archive.posted_text(outage["posted_at"]),
        "interval_ending": archive.posted_text(prices["interval_ending"]),
        "zone_prices": zones,
        "source": "Supabase ercot_postings and ercot_prices",
    }


@router.post("/scenario/start", status_code=202)
def post_start(body: StartBody, x_operator_id: Optional[str] = Header(None)):
    operator = _require_operator(x_operator_id)
    if store.find_scenario(_catalog(), body.scenario) is None:
        raise ApiError(409, "unknown_scenario", f"No scenario {body.scenario}.")
    return _record("start", body.model_dump(), operator)


@router.post("/scenario/reset", status_code=202)
def post_reset(body: ResetBody, x_operator_id: Optional[str] = Header(None)):
    return _record("reset", body.model_dump(), _require_operator(x_operator_id))


@router.post("/scenario/play", status_code=202)
def post_play(body: PlayBody, x_operator_id: Optional[str] = Header(None)):
    return _record("play", body.model_dump(), _require_operator(x_operator_id))


@router.post("/scenario/speed", status_code=202)
def post_speed(body: SpeedBody, x_operator_id: Optional[str] = Header(None)):
    operator = _require_operator(x_operator_id)
    if body.x not in store.SPEEDS:
        raise ApiError(422, "bad_speed", f"Speed must be one of {', '.join(map(str, store.SPEEDS))}.")
    return _record("speed", body.model_dump(), operator)


@router.post("/scenario/alert", status_code=202)
def post_alert(body: AlertBody, x_operator_id: Optional[str] = Header(None)):
    operator = _require_operator(x_operator_id)
    known = {alert_id for entry in _catalog() for alert_id in entry.get("alerts", [])}
    if body.alert_id not in known or store.load_alert(body.alert_id, store.ALERT_DIR) is None:
        raise ApiError(409, "unknown_alert", f"No archived alert {body.alert_id}.")
    return _record("alert", body.model_dump(), operator)


@router.post("/scenario/grid-down", status_code=202)
def post_grid_down(body: GridDownBody, x_operator_id: Optional[str] = Header(None)):
    return _record("grid_down", body.model_dump(), _require_operator(x_operator_id))
