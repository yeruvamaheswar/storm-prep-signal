"""One TickView for the wall. Imports compute_risk and reserve_policy; does not write a second rule."""

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

import requests

from server.api.archive import (
    ArchiveUnavailable,
    event_for_clock,
    posted_text,
    read_outage,
    read_prices,
)
from server.api.feeds import serve_outage, serve_price
from server.api.prices import (
    LOAD_ZONE_POINTS,
    bind_zone_prices,
    fetch_archive_prices,
    price_for_zone,
    rows_from_np6,
)
from server.api.runtime import FIXTURE_CLOCK, discover_runtime, normalize_event, pin_clock, posting_at
from server.engine.baseline import BaselineError, load_baseline
from server.engine.brief import apply_tick_brief
from server.engine.cli import read_settings
from server.engine.fleet import call_target_mw, fleet_cap_mw, scale_tick_to_fleet
from server.engine.fleet_state import apply_mode
from server.engine.policy import reserve_policy
from server.engine.risk import ZONES, compute_risk, current_hour_index, zone_fields
from server.engine.signal import (
    CENTRAL,
    SignalUnavailable,
    newest_posting_time,
    parse_central,
    read_price,
    rows_by_name,
    stamp_price,
    to_signal,
)
from server.env import load_env

REPO_ROOT = Path(__file__).resolve().parents[2]
LATEST_RUN = REPO_ROOT / "var" / "runs" / "latest.json"
LAYOUT_RUN = REPO_ROOT / "web" / "src" / "fixtures" / "layout-run.json"

Ingest = Callable[[datetime], dict]

OUTAGE_PRODUCT = "NP3-233-CD"
PRICE_PRODUCT = "NP6-905-CD"
OUTAGE_PATH = "/api/public-reports/np3-233-cd/hourly_res_outage_cap"
PRICE_PATH = "/api/public-reports/np6-905-cd/spp_node_zone_hub"


class IngestError(Exception):
    """Live read failed. `quality` is the wall's LiveFailure code."""

    def __init__(self, quality: str, http_status: Optional[int] = None, feeds: Optional[list] = None):
        self.quality = quality
        self.http_status = http_status
        self.feeds = feeds


def is_run_file(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    ticks = value.get("ticks")
    return isinstance(value.get("run_id"), str) and isinstance(ticks, list) and len(ticks) > 0


def _read_run(path: Path) -> Optional[dict]:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if is_run_file(data) else None


def run_from_table_rows(rows):
    """None when PostgREST /runs is empty or not a run file. Empty is not source of truth."""
    if isinstance(rows, dict):
        rows = [rows]
    if not isinstance(rows, list) or not rows:
        return None
    row = rows[0]
    if not isinstance(row, dict):
        return None
    result = row.get("result")
    if isinstance(result, str):
        return None
    if is_run_file(result):
        return result
    if isinstance(result, dict):
        run_id = result.get("run_id") or row.get("run_id")
        ticks = result.get("ticks")
        if isinstance(run_id, str) and isinstance(ticks, list) and ticks:
            merged = dict(result)
            merged["run_id"] = run_id
            if is_run_file(merged):
                return merged
    if isinstance(result, list) and result and isinstance(row.get("run_id"), str):
        candidate = {"run_id": row["run_id"], "ticks": result}
        if isinstance(row.get("source"), str):
            candidate["source"] = row["source"]
        if is_run_file(candidate):
            return candidate
    return row if is_run_file(row) else None


def fetch_runs_table(get=None, url=None, key=None, timeout_s=None):
    """GET PostgREST /runs. Returns the JSON list (often []), or None on skip/error."""
    load_env()
    host = os.getenv("SUPABASE_URL", "") if url is None else url
    secret = os.getenv("SUPABASE_SECRET_KEY", "") if key is None else key
    if not (host and secret):
        return None
    try:
        timeout = float(os.getenv("FETCH_TIMEOUT_S", "3") if timeout_s is None else timeout_s)
    except ValueError:
        timeout = 3.0
    endpoint = f"{host.rstrip('/')}/rest/v1/runs"
    params = {"select": "run_id,source,result", "order": "run_id.desc", "limit": "1"}
    caller = requests.get if get is None else get
    try:
        reply = caller(endpoint, params=params, headers={"apikey": secret}, timeout=timeout)
    except (TypeError, requests.Timeout, requests.RequestException):
        return None
    if not getattr(reply, "ok", False):
        return None
    try:
        body = reply.json()
    except ValueError:
        return None
    return body if isinstance(body, list) else None


def load_latest_run() -> dict:
    """File is source of truth. Table rows count only when they exist. Empty [] falls back."""
    run = _read_run(LATEST_RUN)
    if run is not None:
        return run
    table = run_from_table_rows(fetch_runs_table())
    if table is not None:
        return table
    run = _read_run(LAYOUT_RUN)
    if run is not None:
        return run
    raise FileNotFoundError("no run file")


def _fleet_size(run: dict) -> int:
    settings = run.get("settings") if isinstance(run.get("settings"), dict) else {}
    fleet = settings.get("fleet_size")
    if not isinstance(fleet, int) or isinstance(fleet, bool):
        try:
            fleet = int(os.getenv("FLEET_SIZE", "100"))
        except ValueError:
            fleet = 100
    return fleet


def _iso_clock(clock):
    """ISO posting time only. Tokens wall/fixture/archive are clock kinds."""
    if clock in (None, "wall", "fixture", "archive"):
        return None
    if isinstance(clock, datetime):
        return clock.isoformat()
    if isinstance(clock, str) and "T" in clock:
        return clock
    return None


def build_meta(run: Optional[dict] = None, event: Optional[str] = None, clock: Optional[str] = None) -> dict:
    """What the wall should open as. clock is wall, fixture, or archive (pinned posting)."""
    if run is None:
        try:
            run = load_latest_run()
        except FileNotFoundError:
            run = {}
    fleet = _fleet_size(run)
    raw = run.get("source")
    named = event if isinstance(event, str) else (run.get("event") if isinstance(run.get("event"), str) else None)
    replay = discover_runtime(event=named, clock=_iso_clock(clock))
    if raw == "archive" or (named and named in ("beryl", "heather", "tuning-2026")):
        body = {
            "mode": "live",
            "fleet_size": fleet,
            "source": "archive",
            "event": replay.get("event") or named,
            "clock": "archive",
        }
    elif raw == "live":
        body = {"mode": "live", "fleet_size": fleet, "source": "live", "event": None, "clock": "wall"}
    elif raw == "scenario":
        body = {"mode": "demo", "fleet_size": fleet, "source": "scenario", "event": None, "clock": "wall"}
    else:
        fleet = 100
        body = {"mode": "demo", "fleet_size": 100, "source": "fixture", "event": None, "clock": "fixture"}
    return _with_fleet(fleet, body)


def feed_row(product, path, as_of, age_min, quality, hold_on_fail, http_status=None):
    return {
        "product": product,
        "path": path,
        "as_of": as_of,
        "age_min": age_min,
        "quality": quality,
        "hold_on_fail": hold_on_fail,
        "http_status": http_status,
    }


def _feeds(quality, as_of=None, age_min=None, http_status=None, hold_outage=False):
    return [
        feed_row(OUTAGE_PRODUCT, OUTAGE_PATH, as_of, age_min, quality, hold_outage, http_status),
        feed_row(PRICE_PRODUCT, PRICE_PATH, as_of, age_min, quality, False, http_status),
    ]


def _finish(tick: dict) -> dict:
    return apply_tick_brief(apply_mode(tick))


def _with_fleet(fleet, body):
    sized = {**read_settings(), "fleet_size": fleet}
    return {**body, "fleet_cap_mw": fleet_cap_mw(sized), "call_target_mw": call_target_mw(sized)}


class _ReplayRisk:
    """reserve_policy only reads level. Replay.csv already rated the posting."""

    def __init__(self, level):
        self.level = level


def _origin_fields(replay: dict, run: dict, event=None) -> dict:
    if run.get("source") == "live":
        return {"source": "live", "event": None, "clock": "wall"}
    named = normalize_event(event) or normalize_event(run.get("event") if isinstance(run.get("event"), str) else None)
    if named is None and replay.get("source") == "archive":
        named = replay.get("event")
    if run.get("source") == "archive" or replay.get("source") == "archive" or named:
        return {"source": "archive", "event": named, "clock": "archive"}
    if run.get("source") == "scenario":
        return {"source": "scenario", "event": None, "clock": "wall"}
    return {"source": "fixture", "event": None, "clock": "fixture"}


def _stamp_origin(tick: dict, origin: dict) -> dict:
    tick.update(origin)
    if origin.get("source") == "archive":
        tick["feed"] = "ARCHIVE"
    return tick


def _as_when(now, clock, replay: dict) -> datetime:
    """Archive ingest uses the pinned posting, not the wall clock (2024 is not stale)."""
    if now is not None:
        return now
    iso = _iso_clock(replay.get("clock")) if replay.get("source") == "archive" else _iso_clock(clock)
    if not iso:
        return datetime.now(CENTRAL)
    parsed = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=CENTRAL)
    return parsed.astimezone(CENTRAL)


def _overlay_replay(tick: dict, replay: dict, clock, origin: dict):
    """Local replay.csv when Supabase has no posting. Missing file stays fail-safe."""
    if replay.get("source") != "archive":
        return None
    try:
        return _finish(_stamp_origin(_stamp_replay(tick, replay, clock), origin))
    except (FileNotFoundError, KeyError, TypeError, ValueError):
        return None


def _stamp_replay(tick: dict, replay: dict, clock=None) -> dict:
    """Overlay the nearest replay.csv posting. This is not a live ERCOT body."""
    posting = posting_at(replay["path"], _iso_clock(clock) or _iso_clock(replay.get("clock")))
    peak = float(posting["peak_mw"])
    trigger = float(posting["trigger_mw"])
    policy = reserve_policy(_ReplayRisk(posting["risk"]), read_settings())
    zone = posting.get("driving_zone")
    priced = stamp_price(tick, None)
    pinned = pin_clock(posting["posted_at"])
    priced.update({
        "outage_mw": peak,
        "peak_mw": peak,
        "trigger_mw": trigger,
        "threshold_mw": trigger,
        "margin_mw": peak - trigger,
        "risk_level": policy.risk_level,
        "reserve_pct": policy.reserve_pct,
        "policy_reason": policy.reason,
        "driving_zone": zone,
        "zone_mw": float(posting["houston_mw"]) if zone == "Houston" and posting.get("houston_mw") else None,
        "houston_mw": float(posting["houston_mw"]) if posting.get("houston_mw") not in (None, "") else None,
        "as_of": f"{pinned[11:16]} CT",
        "stress_as_of": f"{pinned[11:16]} CT",
        "stress_age_min": 0,
        "quality": "ok",
        "stress_quality": "ok",
        "feed": "ARCHIVE",
        "clock_pinned": True,
        "feeds": _feeds("ok", f"{pinned[11:16]} CT", 0),
    })
    return priced


def _fail(tick: dict, quality: str, http_status: Optional[int] = None, feeds: Optional[list] = None) -> dict:
    policy = reserve_policy(None, read_settings())
    failed = stamp_price(tick, None)
    failed.update({
        "quality": quality,
        "stress_quality": quality,
        "feed": "LIVE",
        "clock_pinned": False,
        "risk_level": policy.risk_level,
        "policy_reason": policy.reason,
        "reserve_pct": policy.reserve_pct,
        "outage_mw": None,
        "trigger_mw": None,
        "peak_mw": None,
        "margin_mw": None,
        "threshold_mw": None,
        "driving_zone": None,
        "zone_mw": None,
        "houston_mw": None,
        "north_mw": None,
        "south_mw": None,
        "west_mw": None,
        "zone_delivered_mw": tick.get("zone_delivered_mw") or {},
        "feeds": feeds or _feeds(quality, http_status=http_status, hold_outage=True),
    })
    if "zone_acks" in tick:
        failed["zone_acks"] = tick["zone_acks"]
    return failed


def _rate(raw: dict, now: datetime):
    settings = read_settings()
    signal = to_signal(raw, now)
    risk = compute_risk(
        signal,
        load_baseline(lookahead_hours=settings["lookahead_hours"]),
        margin_pct=settings["margin_pct"],
        lookahead_hours=settings["lookahead_hours"],
    )
    return risk, signal, reserve_policy(risk, settings)


def _bound_prices(live: dict) -> dict:
    """Four load-zone prices for this interval. A live North row wins over archive."""
    interval = live.get("price_as_of")
    rows = list(live.get("price_rows") or [])
    if not rows:
        rows.extend(rows_from_np6(live.get("price_raw")))
    bound = bind_zone_prices(rows, interval)
    north = live.get("price_usd_mwh")
    if "North" not in bound and isinstance(north, (int, float)) and not isinstance(north, bool):
        bound = {**bound, "North": float(north)}
    return bound


def _stamp_usd(live: dict, bound: dict, zone: Optional[str]):
    """Selected zone uses its row. No selection keeps the live/archive North number."""
    if zone in LOAD_ZONE_POINTS:
        usd = price_for_zone(bound, zone)
        if usd is None:
            return None
        return {"usd_mwh": usd, "as_of": live.get("price_as_of")}
    if live.get("price_usd_mwh") is None:
        return None
    return {"usd_mwh": live["price_usd_mwh"], "as_of": live.get("price_as_of")}


def _price_stamp(tick: dict, live: dict, zone: Optional[str] = None) -> dict:
    bound = _bound_prices(live)
    priced = stamp_price(tick, _stamp_usd(live, bound, zone))
    priced["zone_prices"] = bound
    return priced


def _stamp_risk(tick: dict, live: dict, risk, signal: dict, policy, zone: Optional[str] = None) -> dict:
    start = current_hour_index(signal)
    peak = signal["rows"][start + risk.peak_lead]
    columns = {field: peak[field] for name in ZONES for field in zone_fields(name)}
    priced = _price_stamp(tick, live, zone)
    priced.update({
        **columns,
        "peak_mw": risk.peak_mw,
        "outage_mw": risk.peak_mw,
        "trigger_mw": risk.trigger_mw,
        "threshold_mw": risk.trigger_mw,
        "margin_mw": risk.peak_mw - risk.trigger_mw,
        "reserve_pct": policy.reserve_pct,
        "policy_reason": policy.reason,
        "risk_level": policy.risk_level,
        "driving_zone": risk.driving_zone,
        "houston_mw": risk.zone_mw["Houston"],
        "north_mw": risk.zone_mw["North"],
        "south_mw": risk.zone_mw["South"],
        "west_mw": risk.zone_mw["West"],
        "zone_mw": risk.zone_mw[risk.driving_zone],
        "zone_delivered_mw": tick.get("zone_delivered_mw") or {},
        "as_of": live["as_of"],
        "stress_as_of": live["as_of"],
        "stress_age_min": live["age_min"],
        "quality": "ok",
        "stress_quality": "ok",
        "feed": "LIVE",
        "clock_pinned": bool(live.get("clock_pinned")),
        "feeds": _feeds("ok", live.get("as_of"), live.get("age_min")),
    })
    if "zone_acks" in tick:
        priced["zone_acks"] = tick["zone_acks"]
    return priced


def _stamp_totals(tick: dict, live: dict, zone: Optional[str] = None) -> dict:
    totals = live["zone_totals"]
    priced = _price_stamp(tick, live, zone)
    priced.update({
        **live["zone_columns"],
        "outage_mw": live["outage_mw"],
        "threshold_mw": None,
        "margin_mw": None,
        "trigger_mw": tick.get("trigger_mw"),
        "driving_zone": live["driving_zone"],
        "zone_mw": live["zone_mw"],
        "houston_mw": totals["Houston"],
        "north_mw": totals["North"],
        "south_mw": totals["South"],
        "west_mw": totals["West"],
        "zone_delivered_mw": tick.get("zone_delivered_mw") or {},
        "as_of": live["as_of"],
        "stress_as_of": live["as_of"],
        "stress_age_min": live["age_min"],
        "quality": "ok",
        "stress_quality": "ok",
        "feed": "LIVE",
        "clock_pinned": bool(live.get("clock_pinned")),
        "feeds": _feeds("ok", live.get("as_of"), live.get("age_min")),
    })
    if "zone_acks" in tick:
        priced["zone_acks"] = tick["zone_acks"]
    return priced


def _require_ok(feed: dict) -> dict:
    quality = feed.get("quality")
    body = feed.get("body")
    if quality != "ok" or not isinstance(body, dict):
        raise IngestError(quality if isinstance(quality, str) else "unavailable")
    return body


def _price_from_body(raw: dict, now: datetime) -> dict:
    try:
        return read_price(raw, now)
    except SignalUnavailable as exc:
        reason = str(exc)
        if "min old" in reason or "no LZ_NORTH" in reason:
            raise IngestError("stale") from None
        raise IngestError("malformed") from None


def live_ingest(now: datetime) -> dict:
    """Price plus the newest NP3 body. Rating happens in build_snapshot."""
    price_raw = _require_ok(serve_price(now=now))
    price = _price_from_body(price_raw, now)
    raw = _require_ok(serve_outage(now=now))
    try:
        newest = newest_posting_time(rows_by_name(raw))
        posted = parse_central(newest)
    except (KeyError, TypeError, ValueError):
        raise IngestError("malformed") from None
    return {
        "price_usd_mwh": price["usd_mwh"],
        "price_as_of": price["as_of"],
        "price_raw": price_raw,
        "price_rows": rows_from_np6(price_raw) + fetch_archive_prices(price["as_of"]),
        "raw": raw,
        "as_of": f"{newest[11:16]} CT",
        "age_min": max(0, int(round((now - posted).total_seconds() / 60))),
    }


def tick_clock(tick: dict):
    """Pinned tape time, or None when the tick has no usable ts."""
    ts = tick.get("ts")
    if not isinstance(ts, str):
        return None
    try:
        parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=CENTRAL)
    return parsed.astimezone(CENTRAL)


def archive_ingest(now: datetime, event=None, http_get=None, settings=None) -> dict:
    """Newest archived posting at or before `now`. A missing price is named, not a hold."""
    name = event or event_for_clock(now)
    try:
        outage = read_outage(name, now, http_get=http_get, settings=settings)
    except ArchiveUnavailable as exc:
        raise IngestError(exc.quality) from None
    posted = outage["posted_at"]
    age_min = max(0, int(round((now - posted).total_seconds() / 60)))
    if age_min > 90:
        raise IngestError("stale")
    price_usd = None
    price_as_of = None
    price_rows = []
    try:
        fetched = read_prices(
            name,
            now,
            settlement_points=tuple(LOAD_ZONE_POINTS.values()),
            http_get=http_get,
            settings=settings,
        )
        priced = read_price(fetched["body"], now)
        price_usd = priced["usd_mwh"]
        price_as_of = priced["as_of"]
        price_rows = list(fetched.get("rows") or [])
    except (ArchiveUnavailable, SignalUnavailable, KeyError, TypeError, ValueError):
        pass
    newest = posted_text(posted)
    return {
        "price_usd_mwh": price_usd,
        "price_as_of": price_as_of,
        "price_rows": price_rows,
        "raw": outage["body"],
        "as_of": f"{newest[11:16]} CT",
        "age_min": max(0, int(round((now - posted).total_seconds() / 60))),
        "clock_pinned": True,
    }


def build_snapshot(
    now: Optional[datetime] = None,
    ingest: Optional[Ingest] = None,
    event: Optional[str] = None,
    clock: Optional[str] = None,
    zone: Optional[str] = None,
) -> dict:
    run = load_latest_run()
    tick = scale_tick_to_fleet(dict(run["ticks"][-1]), read_settings())
    named = event if isinstance(event, str) else (run.get("event") if isinstance(run.get("event"), str) else None)
    replay = discover_runtime(event=named, clock=_iso_clock(clock))
    origin = _origin_fields(replay, run, named)
    when = _as_when(now, clock, replay)
    if ingest is None and origin["source"] == "archive":
        try:
            live = archive_ingest(when, event=origin["event"])
            raw = live.get("raw")
            if isinstance(raw, dict):
                risk, signal, policy = _rate(raw, when)
                return _finish(_stamp_origin(_stamp_risk(tick, live, risk, signal, policy, zone), origin))
        except IngestError as exc:
            overlay = _overlay_replay(tick, replay, clock, origin) if exc.quality == "unavailable" else None
            if overlay is not None:
                return overlay
            return _finish(_stamp_origin(_fail(tick, exc.quality, exc.http_status, exc.feeds), origin))
        except (SignalUnavailable, KeyError, TypeError, ValueError):
            overlay = _overlay_replay(tick, replay, clock, origin)
            if overlay is not None:
                return overlay
            return _finish(_stamp_origin(_fail(tick, "unavailable"), origin))
        overlay = _overlay_replay(tick, replay, clock, origin)
        if overlay is not None:
            return overlay
        return _finish(_stamp_origin(_fail(tick, "unavailable"), origin))
    if ingest is None and origin["source"] == "live":
        # Worker rows (event=live) are the Live wall's posting. Direct ERCOT is the fallback.
        try:
            live = archive_ingest(when, event="live")
            raw = live.get("raw")
            if isinstance(raw, dict):
                risk, signal, policy = _rate(raw, when)
                stamped = _stamp_risk(tick, live, risk, signal, policy, zone)
                stamped["clock_pinned"] = False
                stamped["feed"] = "LIVE"
                return _finish(_stamp_origin(stamped, origin))
        except IngestError:
            pass
        except (SignalUnavailable, KeyError, TypeError, ValueError):
            pass
    try:
        live = (ingest or live_ingest)(when)
    except IngestError as exc:
        return _finish(_stamp_origin(_fail(tick, exc.quality, exc.http_status, exc.feeds), origin))
    raw = live.get("raw")
    if isinstance(raw, dict):
        try:
            risk, signal, policy = _rate(raw, when)
        except BaselineError:
            raise
        except (SignalUnavailable, KeyError, TypeError, ValueError):
            return _finish(_stamp_origin(_fail(tick, "unavailable"), origin))
        return _finish(_stamp_origin(_stamp_risk(tick, live, risk, signal, policy, zone), origin))
    if "zone_totals" in live:
        return _finish(_stamp_origin(_stamp_totals(tick, live, zone), origin))
    return _finish(_stamp_origin(_fail(tick, "unavailable"), origin))
