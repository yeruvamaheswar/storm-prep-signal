"""Build the /flow scenario tapes from the ERCOT archive in Supabase.

Usage: python scripts/build_scenarios.py [--only <id>]

Each scenario in SCENARIOS is one recorded window, built by the same rules as scripts/build_tape.py:
posting = the newest NP3-233-CD posting at or before the tick; price = the NP6-905-CD 15-minute
interval that holds the tick. It writes committed files the session worker replays offline:
- tapes/scenarios/<id>.json: one frame per tick. The target is synthetic:price-shaped (price_shaped_mw),
  because no public dispatch target exists. dam_fixtures names the saved NP4-190-CD day files
  (scripts/fetch_dam_prices.py) published at the tick; a day not fetched yet is left out.
- tapes/scenarios/<id>.provenance.json: per tick, the Supabase rows the frame came from
  ({posting: {id, report, posted_at, file_name, event}, prices: [...], dam?: [{report, delivery_date, file}],
  overlay?}).
- data/fixtures/<event>/np3_233_cd_<posted>.json: each posting a tape points at.
- data/fixtures/<event>/baseline.json: the lead-matched baseline, only when it is not there yet.
- tapes/scenarios/catalog.json: every scenario. The heather entry is kept; tapes/heather.json is not
  rewritten, only given a provenance sidecar.

Hand-placed overlays (withheld postings, simulated faults, an operator hold) are named in the
sidecar's `overlay` text and in the catalog label. They are never passed off as archive data.

Supabase is never needed at run time. If it fails here, the old files stay and the script exits 0.
Needs SUPABASE_URL and SUPABASE_SECRET_KEY in .env.
"""
import argparse
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT), str(ROOT / "scripts")]

from build_tape import (  # noqa: E402
    PRICE_INTERVAL,
    baseline_file,
    fetch_prices,
    fixture_name,
    latest_posting,
    posting_fixture,
    price_at,
)
from check_margin import REPORT, FetchFailed, fetch_postings, windows  # noqa: E402
from fetch_dam_prices import dam_path  # noqa: E402
from server.api.prices import LOAD_ZONE_POINTS  # noqa: E402
from server.engine.cli import read_settings  # noqa: E402
from server.engine.signal import CENTRAL, dam_days_published  # noqa: E402

ENV_PATH = ROOT / ".env"
SCENARIO_DIR = Path("tapes") / "scenarios"
CATALOG_PATH = SCENARIO_DIR / "catalog.json"
HEATHER_TAPE = Path("tapes") / "heather.json"
TIMEOUT_S = 60
META_PAGE = 1000

SHAPED_LABEL = "synthetic:price-shaped"
# (price $/MWh, target MW) points, straight lines between them, flat past both ends.
# The lowest ask is above 0 because allocate returns before its charge branch when target_mw is 0.
PRICE_SHAPE = ((25.0, 0.02), (60.0, 0.2), (500.0, 1.0))
WITHHELD_TEXT = ("overlay (hand-placed, not archive): the builder withheld NP3-233-CD postings for this tick,"
                 " so the storm rule reads signal_unavailable")
LABEL = "recorded ERCOT; target synthetic:price-shaped"
DAM_REPORT = "NP4-190-CD"

# Windows picked from the archive (see the scenario summaries). Home ids are new_fleet's home-001..home-100.
SCENARIOS = [
    {"id": "heather-spike", "name": "Heather: cheap afternoon, $1,165 evening", "event": "heather",
     "start": "2024-01-16T12:00", "end": "2024-01-16T22:00", "zone": "LZ_HOUSTON",
     "summary": "Winter Storm Heather, day after the HIGH posting. LZ_HOUSTON dips near $21 from 14:30 to 16:30,"
                " then spikes to $1,165 around 18:15. The storm rule reads LOW. The day-ahead look-ahead charges"
                " from noon, even near $54, in the cheapest hours before the spike, so the fleet is nearly full by"
                " 15:40; then it sells into the spike down to its floor by about 19:00."},
    {"id": "heather-thaw", "name": "Heather thaw: sell the morning, charge at noon", "event": "heather",
     "start": "2024-01-17T05:00", "end": "2024-01-17T18:00", "zone": "LZ_HOUSTON",
     "summary": "Last storm day. LZ_HOUSTON is $70 to $87 around 07:00, then falls to $6 by 15:00."
                " The day-ahead look-ahead charges near $45 before dawn for the morning peak, and the fleet sells"
                " into it. Then each zone refills in its cheapest day-ahead hours and on real-time dips, to about"
                " 83% full by 16:00."},
    {"id": "calm-charge", "name": "Calm day: charge in the morning, sell at the peak", "event": "tuning-2026",
     "start": "2026-08-30T07:00", "end": "2026-08-30T22:00", "zone": "LZ_NORTH",
     "summary": "A normal late-summer day. LZ_NORTH sits under $25 until about 12:45 (low $12),"
                " then climbs to $225 around 19:30. Each zone waits for its cheapest day-ahead hours (North:"
                " 09:00 to 10:30), so the fleet is nearly full by 10:30; then it sells into the evening."},
    {"id": "storm-rule-high", "name": "Storm rule HIGH: the 60% floor", "event": "tuning-2026",
     "start": "2026-09-16T02:00", "end": "2026-09-16T14:00", "zone": "LZ_NORTH",
     "summary": "The postings from 04:00 to 12:00 rate HIGH (North outages over the +15% margin), so every zone"
                " keeps 60%. The 13:00 posting reads LOW and the floor drops back to 30%."
                " Baseline is the same month (in sample)."},
    {"id": "price-spike", "name": "Price spike: LZ_NORTH over $1,000", "event": "tuning-2026",
     "start": "2026-09-16T17:45", "end": "2026-09-16T22:00", "zone": "LZ_NORTH",
     "summary": "The same day, after the storm rule reads LOW again. LZ_NORTH goes from $225 to $498 at 18:00"
                " and passes $1,000 around 19:45. The price-shaped ask rises to its 1.0 MW cap and the fleet"
                " sells until it reaches its floor."},
    {"id": "storm-rule-night", "name": "Storm rule turns HIGH mid-peak", "event": "tuning-2026",
     "start": "2026-09-22T16:00", "end": "2026-09-23T04:00", "zone": "LZ_NORTH",
     "summary": "The fleet sells into a $90 to $213 evening. The 21:00 posting rates HIGH, so the floor"
                " rises to 60% while prices are still high. The 02:00 posting reads LOW again."},
    {"id": "feed-failure", "name": "Feed failure: postings withheld", "event": "tuning-2026",
     "start": "2026-09-12T12:00", "end": "2026-09-12T23:00", "zone": "LZ_NORTH",
     "withhold": [("2026-09-12T18:00", "2026-09-12T21:00")],
     "summary": "A cheap day with a $55 to $76 evening. From 18:00 to 21:00 the builder withholds the outage"
                " postings (overlay), so the rule fails safe: signal_unavailable and a 60% floor. Only charge"
                " above 60% can be sold until the postings return."},
    {"id": "faults", "name": "Faults at the peak: lossy network, crashes, misreports", "event": "tuning-2026",
     "start": "2026-09-02T08:00", "end": "2026-09-02T23:00", "zone": "LZ_NORTH",
     "overlays": [
         {"span": ("2026-09-02T19:00", "2026-09-02T20:30"), "name": "lossy network 19:00-20:30",
          "events": {"network": {"drop_rate": 0.3, "dup_rate": 0.1, "late_rate": 0.2}},
          "text": "overlay (hand-placed, not archive): network 30% lost, 10% duplicated, 20% late"},
         {"span": ("2026-09-02T19:30", "2026-09-02T19:35"), "name": "5 homes crash 19:30",
          "events": {"crash": ["home-005", "home-010", "home-015", "home-020", "home-025"]},
          "text": "overlay (hand-placed, not archive): homes 005, 010, 015, 020, 025 crash if sent an order"},
         {"span": ("2026-09-02T20:00", "2026-09-02T20:30"), "name": "2 homes misreport 20:00-20:30",
          "events": {"misreport": {"home-030": 1.5, "home-031": 1.5}},
          "text": "overlay (hand-placed, not archive): homes 030 and 031 report 1.5x what they gave"},
         {"span": ("2026-09-02T21:00", "2026-09-02T21:05"), "name": "crashed homes back 21:00",
          "events": {"live": ["home-005", "home-010", "home-015", "home-020", "home-025"]},
          "text": "overlay (hand-placed, not archive): the crashed homes come back live"},
     ],
     "summary": "LZ_NORTH is cheap until noon, then spikes to $484 around 20:00. During the peak the builder"
                " adds simulated faults (overlays): a lossy network, five crashed homes, two misreporting homes."
                " Floors still hold."},
    {"id": "operator-hold", "name": "Operator HOLD through the peak", "event": "tuning-2026",
     "start": "2026-09-17T16:30", "end": "2026-09-17T21:30", "zone": "LZ_NORTH",
     "overlays": [
         {"span": ("2026-09-17T16:45", "2026-09-17T18:15"), "name": "operator HOLD 16:45-18:15",
          "events": {"operator": "HOLD"},
          "text": "overlay (hand-placed, not archive): operator HOLD, nothing is dispatched"},
         {"span": ("2026-09-17T18:15", "2026-09-17T18:20"), "name": "AUTO from 18:15",
          "events": {"operator": "AUTO"},
          "text": "overlay (hand-placed, not archive): operator back to AUTO"},
     ],
     "summary": "LZ_NORTH runs $105 to $380 from 16:30 and peaks near $720 around 18:15. An operator HOLD"
                " (overlay) stops all dispatch from 16:45 to 18:15, so the charge is still there when the"
                " rules resume on AUTO at the peak."},
    {"id": "beryl-landfall", "name": "Hurricane Beryl landfall", "event": "beryl",
     "start": "2024-07-07T22:00", "end": "2024-07-08T14:00", "zone": "LZ_HOUSTON", "grid_down_overlay": True,
     "summary": "Beryl came ashore early on July 8. Houston load fell away and LZ_HOUSTON went negative"
                " from about 08:00 to 13:30. Prices stay under $25 all window, but each zone charges only in its"
                " cheapest day-ahead hours or on a real-time dip below them, so the fleet fills in steps and is"
                " about 98% full by 03:30; the storm rule never read HIGH. The operator can mark a zone's grid down (overlay) to show"
                " batteries carrying homes."},
]


def at(text):
    return datetime.fromisoformat(text).replace(tzinfo=CENTRAL)


def price_shaped_mw(price):
    """Synthetic target MW from the tick's price: small when cheap, rising with price, capped.

    A tick with no price asks what $60 asks, the flat 0.2 MW the other tapes use.
    """
    if price is None:
        price = PRICE_SHAPE[1][0]
    (low_price, low_mw), *rest = PRICE_SHAPE
    if price <= low_price:
        return low_mw
    for high_price, high_mw in rest:
        if price <= high_price:
            return round(low_mw + (high_mw - low_mw) * (price - low_price) / (high_price - low_price), 4)
        low_price, low_mw = high_price, high_mw
    return low_mw


def row_at(prices, ts):
    """(interval_ending, price) of the 15-minute interval that holds ts, like build_tape.price_at."""
    for ending, price in prices:
        if ending - PRICE_INTERVAL <= ts < ending:
            return ending, price
    return None


def in_span(ts, span):
    return at(span[0]) <= ts < at(span[1])


def fixture_path(event, posted):
    return str(Path("data") / "fixtures" / event / fixture_name(posted))


def posted_from_fixture(path):
    """The naive Central posted time in a fixture name like np3_233_cd_20240115T130335.json."""
    return datetime.strptime(Path(path).stem.removeprefix("np3_233_cd_"), "%Y%m%dT%H%M%S")


def delivery_date_of(path):
    """The delivery day in a DAM file name like np4_190_cd_20260830.json, as 2026-08-30."""
    return datetime.strptime(Path(path).stem.removeprefix("np4_190_cd_"), "%Y%m%d").date().isoformat()


def dam_fixtures_at(ts):
    """The saved DAM day files published at ts (today, plus tomorrow from 13:30 CT). A day not fetched is left out."""
    return [str(dam_path(day)) for day in dam_days_published(ts) if (ROOT / dam_path(day)).is_file()]


def scenario_frames(spec, postings, zone_prices, tick_minutes):
    """Frames from start to end every tick_minutes, the postings they point at, and overlay text by tick.

    zone_prices maps each load-zone name to its (interval_ending, price) list; the frame's own price
    is the zone whose point is spec["zone"]. dam_fixtures lists the DAM day files published at the tick.
    """
    primary = next(name for name, point in LOAD_ZONE_POINTS.items() if point == spec["zone"])
    frames, used, notes_by_tick = [], {}, {}
    ts, end, tick = at(spec["start"]), at(spec["end"]), 1
    while ts <= end:
        price = price_at(zone_prices[primary], ts)
        by_zone = {name: price_at(rows, ts) for name, rows in zone_prices.items()}
        by_zone = {name: usd for name, usd in by_zone.items() if usd is not None}
        notes, events = [], {}
        withheld = any(in_span(ts, span) for span in spec.get("withhold", []))
        posting = None if withheld else latest_posting(postings, ts)
        fixture = None
        if withheld:
            notes.append(WITHHELD_TEXT)
        if posting:
            fixture = fixture_path(spec["event"], posting[0])
            used[fixture] = posting
        for overlay in spec.get("overlays", []):
            if in_span(ts, overlay["span"]):
                events.update(overlay["events"])
                notes.append(overlay["text"])
        if notes:
            notes_by_tick[tick] = "; ".join(notes)
        frames.append({"tick": tick, "ts": ts.isoformat(timespec="seconds"),
                       "target_mw": price_shaped_mw(price), "target_label": SHAPED_LABEL,
                       "price_usd_mwh": price,
                       "price_label": f"recorded:ERCOT NP6-905-CD {spec['zone']}" if price is not None else "none",
                       "risk_fixture": fixture, "events": events,
                       "zone_prices": by_zone,
                       "zone_price_label": "recorded:ERCOT NP6-905-CD" if by_zone else "none",
                       "dam_fixtures": dam_fixtures_at(ts)})
        ts += timedelta(minutes=tick_minutes)
        tick += 1
    return frames, used, notes_by_tick


def sidecar(frames, meta, zone_prices, event, notes_by_tick=None):
    """Per tick (keyed by str(tick)): the posting row, the four zone price rows, the DAM day files, and any overlay text."""
    notes_by_tick = notes_by_tick or {}
    rows = {}
    for frame in frames:
        ts = datetime.fromisoformat(frame["ts"])
        entry = {}
        if frame["risk_fixture"]:
            posted = posted_from_fixture(frame["risk_fixture"])
            found = meta.get(posted, {})
            entry["posting"] = {"id": found.get("id"), "report": REPORT,
                                "posted_at": posted.isoformat(timespec="seconds"),
                                "file_name": found.get("file_name"), "event": event}
        entry["prices"] = [{"settlement_point": point, "interval_ending": hit[0].isoformat(timespec="seconds"),
                            "price_usd_mwh": hit[1]}
                           for name, point in LOAD_ZONE_POINTS.items()
                           if (hit := row_at(zone_prices.get(name, []), ts))]
        if frame.get("dam_fixtures"):
            entry["dam"] = [{"report": DAM_REPORT, "delivery_date": delivery_date_of(path), "file": path}
                            for path in frame["dam_fixtures"]]
        if frame["tick"] in notes_by_tick:
            entry["overlay"] = notes_by_tick[frame["tick"]]
        rows[str(frame["tick"])] = entry
    return rows


def window_text(spec):
    start, end = at(spec["start"]), at(spec["end"])
    if start.date() == end.date():
        return f"{start:%Y-%m-%d %H:%M} to {end:%H:%M} CT"
    return f"{start:%Y-%m-%d %H:%M} to {end:%Y-%m-%d %H:%M} CT"


def overlay_names(spec):
    names = [f"postings withheld {at(a):%H:%M}-{at(b):%H:%M} (feed failure)" for a, b in spec.get("withhold", [])]
    return names + [overlay["name"] for overlay in spec.get("overlays", [])]


def catalog_entry(spec, old=None):
    names = overlay_names(spec)
    label = LABEL + (f"; overlays (hand-placed, not archive): {', '.join(names)}" if names else "")
    return {"id": spec["id"], "name": spec["name"], "event": spec["event"], "window": window_text(spec),
            "summary": spec["summary"], "label": label,
            "tape": str(SCENARIO_DIR / f"{spec['id']}.json"),
            "baseline": str(Path("data") / "fixtures" / spec["event"] / "baseline.json"),
            "provenance": str(SCENARIO_DIR / f"{spec['id']}.provenance.json"),
            # Alert ids come from the archived NWS fixtures; a rebuild keeps whatever is listed.
            "alerts": list((old or {}).get("alerts", [])),
            "grid_down_overlay": bool(spec.get("grid_down_overlay", False))}


def tape_label(spec):
    names = overlay_names(spec)
    text = (f"ERCOT replay, {spec['name']}, {window_text(spec)}. Risk: recorded NP3-233-CD."
            f" Price: recorded NP6-905-CD {spec['zone']}; zone_prices: the four load zones."
            f" Target: {SHAPED_LABEL} (no public dispatch target exists).")
    return text + (f" Overlays (hand-placed, not archive): {', '.join(names)}." if names else "")


def fetch_posting_meta(url, key, event):
    """posted time (naive Central) -> {id, file_name} for every NP3-233-CD posting of one event."""
    endpoint = f"{url.rstrip('/')}/rest/v1/ercot_postings"
    params = {"select": "id,posted_at,file_name", "event": f"eq.{event}", "report": f"eq.{REPORT}",
              "order": "posted_at"}
    meta, start = {}, 0
    while True:
        try:
            reply = requests.get(endpoint, params=params, timeout=TIMEOUT_S,
                                 headers={"apikey": key, "Range": f"{start}-{start + META_PAGE - 1}"})
        except requests.Timeout:
            raise FetchFailed(f"no answer within {TIMEOUT_S} s") from None
        except requests.RequestException as exc:
            # The exception text can include the request, so only its type is shown.
            raise FetchFailed(f"network error ({type(exc).__name__})") from None
        if not reply.ok:
            raise FetchFailed(f"HTTP {reply.status_code}: {reply.text}")
        page = reply.json()
        for row in page:
            posted = datetime.fromisoformat(row["posted_at"]).astimezone(CENTRAL).replace(tzinfo=None)
            meta[posted] = {"id": row["id"], "file_name": row.get("file_name")}
        if len(page) < META_PAGE:
            return meta
        start += META_PAGE


def fetch_zone_prices(url, key, start, end):
    return {name: fetch_prices(url, key, point, start, end) for name, point in LOAD_ZONE_POINTS.items()}


def with_source(value, event):
    """build_tape's fixture and baseline shapes, with this event named in `source`."""
    return {**value, "source": f"Supabase public.ercot_postings, event {event}, ERCOT {REPORT}"}


def write_json(path, value):
    path = ROOT / path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=1) + "\n")


def read_catalog():
    try:
        return json.loads((ROOT / CATALOG_PATH).read_text())
    except (OSError, ValueError):
        return {"label": "Scenario catalog for the /flow page.", "scenarios": []}


def fetch_all(url, key, specs, with_heather):
    """Every Supabase read, before any file is written. Raises FetchFailed or ValueError."""
    events = sorted({spec["event"] for spec in specs} | ({"heather"} if with_heather else set()))
    postings = {event: fetch_postings(url, key, event) for event in events}
    meta = {event: fetch_posting_meta(url, key, event) for event in events}
    baselines = {}
    for event in events:
        if not (ROOT / "data" / "fixtures" / event / "baseline.json").exists():
            _, _, first, last = windows()[event]
            baselines[event] = with_source(baseline_file(postings[event], first, last), event)
    prices = {spec["id"]: fetch_zone_prices(url, key, at(spec["start"]), at(spec["end"])) for spec in specs}
    heather = None
    if with_heather:
        frames = json.loads((ROOT / HEATHER_TAPE).read_text())["frames"]
        first, last = (datetime.fromisoformat(frames[i]["ts"]) for i in (0, -1))
        heather = (frames, fetch_zone_prices(url, key, first, last))
    return postings, meta, baselines, prices, heather


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build the /flow scenario tapes from Supabase.")
    ids = ["heather"] + [spec["id"] for spec in SCENARIOS]
    parser.add_argument("--only", choices=ids, help="build one scenario (heather: only its provenance sidecar)")
    args = parser.parse_args(argv)
    specs = [spec for spec in SCENARIOS if args.only in (None, spec["id"])]
    with_heather = args.only in (None, "heather")

    load_dotenv(ENV_PATH)
    url, key = os.getenv("SUPABASE_URL", ""), os.getenv("SUPABASE_SECRET_KEY", "")
    if not (url and key):
        print("build_scenarios_skipped: no_config")
        return 0
    tick_minutes = read_settings()["tick_minutes"]
    try:
        postings, meta, baselines, prices, heather = fetch_all(url, key, specs, with_heather)
    except (FetchFailed, ValueError) as exc:
        print(f"build_scenarios_skipped: {exc}")
        return 0

    for event, baseline in baselines.items():
        write_json(Path("data") / "fixtures" / event / "baseline.json", baseline)
        print(f"wrote baseline for {event}: {baseline['postings']} postings {baseline['from']} to {baseline['to']}")
    catalog = read_catalog()
    old = {entry.get("id"): entry for entry in catalog.get("scenarios", [])}
    built = {}
    if heather:
        frames, zone_prices = heather
        path = SCENARIO_DIR / "heather.provenance.json"
        write_json(path, sidecar(frames, meta["heather"], zone_prices, "heather"))
        built["heather"] = {**old.get("heather", {}), "provenance": str(path)}
        print(f"wrote {path}: {len(frames)} ticks for {HEATHER_TAPE} (frames unchanged)")
    for spec in specs:
        frames, used, notes = scenario_frames(spec, postings[spec["event"]], prices[spec["id"]], tick_minutes)
        for path, (posted, rows) in used.items():
            write_json(path, with_source(posting_fixture(posted, rows), spec["event"]))
        entry = catalog_entry(spec, old.get(spec["id"]))
        write_json(entry["tape"], {"label": tape_label(spec), "frames": frames})
        write_json(entry["provenance"],
                   sidecar(frames, meta[spec["event"]], prices[spec["id"]], spec["event"], notes))
        built[spec["id"]] = entry
        priced = sum(frame["price_usd_mwh"] is not None for frame in frames)
        print(f"wrote {entry['tape']}: {len(frames)} frames ({priced} priced, {len(notes)} with overlays),"
              f" {len(used)} postings in data/fixtures/{spec['event']}")

    order = ids + [entry_id for entry_id in old if entry_id not in ids]
    merged = {**old, **built}
    catalog["scenarios"] = [merged[entry_id] for entry_id in order if entry_id in merged]
    write_json(CATALOG_PATH, catalog)
    print(f"wrote {CATALOG_PATH}: {len(catalog['scenarios'])} scenarios")
    return 0


if __name__ == "__main__":
    sys.exit(main())
