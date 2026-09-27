"""Fetch archived NWS alerts from the Iowa Environmental Mesonet into data/fixtures/nws/<id>.json.

Usage: python scripts/fetch_nws_alerts.py [--only ID]

Every text field is copied from the archived product; nothing is written by hand. For each alert:
- the product text comes from IEM's NWS text archive (api/1/nwstext/<product_id>);
- onset and expires are when the warning began and ended for the anchor zone, from IEM's VTEC
  event record (so an early cancellation shows as the real end);
- counties are SAME codes (0 + state + county FIPS). County UGCs (TXC113) convert directly; zone
  UGCs (TXZ213) go through the NWS zone-county correlation file.
A failed fetch or parse exits 1 and writes nothing for that alert.
"""
import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "fixtures" / "nws"
IEM = "https://mesonet.agron.iastate.edu"
ZONE_COUNTY_URL = "https://www.weather.gov/source/gis/Shapefiles/County/bp16ap26.dbx"
TIMEOUT_S = 60
CENTRAL = ZoneInfo("America/Chicago")
SOURCE_LABEL = "Iowa Environmental Mesonet NWS archive"
STATE_FIPS = {"TX": "48"}
# NWS VTEC phenomena.significance names (NWSI 10-1703).
EVENT_NAMES = {
    "TR.W": "Tropical Storm Warning",
    "HZ.W": "Hard Freeze Warning",
    "FF.W": "Flash Flood Warning",
}
# Each entry names one archived product and the zone whose segment we keep.
ALERTS = [
    {"id": "beryl-harris-tropical-storm-warning", "wfo": "HGX", "year": 2024, "vtec": "TR.W", "etn": 1002,
     "product_id": "202407080859-KHGX-WTUS84-TCVHGX", "ugc": "TXZ213"},
    {"id": "heather-dallas-hard-freeze-warning", "wfo": "FWD", "year": 2024, "vtec": "HZ.W", "etn": 2,
     "product_id": "202401151205-KFWD-WWUS74-NPWFWD", "ugc": "TXZ119"},
    {"id": "heather-harris-hard-freeze-warning", "wfo": "HGX", "year": 2024, "vtec": "HZ.W", "etn": 2,
     "product_id": "202401151918-KHGX-WWUS74-NPWHGX", "ugc": "TXZ213"},
    {"id": "tuning2026-midland-flash-flood-warning", "wfo": "MAF", "year": 2026, "vtec": "FF.W", "etn": 198,
     "product_id": "202609221931-KMAF-WGUS54-FFWMAF", "ugc": "TXC329"},
]
UGC_START = re.compile(r"^[A-Z]{2}[CZ]\d{3}")
UGC_END = re.compile(r"\d{6}-$")
ISSUED_LINE = re.compile(r"^\d{3,4} (AM|PM) [A-Z]{3} ")


def fail(reason):
    sys.exit(f"fetch_nws_alerts failed: {reason}")


def get(url):
    try:
        reply = requests.get(url, timeout=TIMEOUT_S)
    except requests.RequestException as exc:
        fail(f"{url}: {type(exc).__name__}")
    if reply.status_code != 200:
        fail(f"{url}: HTTP {reply.status_code}")
    return reply


def zone_counties():
    """UGC zone (TXZ213) to SAME county codes, from the NWS zone-county correlation file."""
    table = {}
    for line in get(ZONE_COUNTY_URL).text.splitlines():
        cols = line.split("|")
        if len(cols) > 6 and cols[6].isdigit():
            table.setdefault(f"{cols[0]}Z{cols[1]}", []).append("0" + cols[6])
    return table


def expand_ugc(block):
    """'TXZ178-179-210>214-152100-' to ['TXZ178', 'TXZ179', 'TXZ210', ..., 'TXZ214']."""
    codes, prefix = [], None
    for token in block.replace("\n", "").strip("-").split("-")[:-1]:
        if UGC_START.match(token):
            prefix, token = token[:3], token[3:]
        first, _, last = token.partition(">")
        for n in range(int(first), int(last or first) + 1):
            codes.append(f"{prefix}{n:03d}")
    return codes


def segments(text):
    """Each $$-separated segment as (ugc codes, lines after the UGC block)."""
    found = []
    for raw in text.replace("\r", "").split("$$"):
        lines = raw.split("\n")
        start = next((i for i, line in enumerate(lines) if UGC_START.match(line)), None)
        if start is None:
            continue
        end = next(i for i in range(start, len(lines)) if UGC_END.search(lines[i].strip()))
        found.append((expand_ugc("".join(lines[start:end + 1])), lines[end + 1:]))
    return found


def headline_and_body(lines):
    """The '...HEADLINE...' blocks and the text after them, up to '&&'.

    A bulletin without '...' headlines (SVR, TOR) uses its own type, office and time lines.
    """
    lines = [line.rstrip() for line in lines]
    stop = next((i for i, line in enumerate(lines) if line.strip() == "&&"), len(lines))
    lines = lines[:stop]
    heads, current, last_head = [], None, None
    for i, line in enumerate(lines):
        if line.startswith("*"):
            break
        if current is None and line.startswith("..."):
            current = [line]
        elif current is not None:
            current.append(line)
        if current is not None and current[-1].endswith("..."):
            heads.append(" ".join(current).strip(".").strip())
            current, last_head = None, i
    if heads:
        return "; ".join(heads), "\n".join(lines[last_head + 1:]).strip()
    issued = next(i for i, line in enumerate(lines) if ISSUED_LINE.match(line))
    title = [line.strip() for line in lines[issued - 2:issued + 1]]
    return ", ".join(title), "\n".join(lines[issued + 1:]).strip()


def central(utc_text):
    return datetime.fromisoformat(utc_text.replace("Z", "+00:00")).astimezone(CENTRAL).isoformat()


def build(spec, zone_table):
    phen, sig = spec["vtec"].split(".")
    vtec_url = (f"{IEM}/json/vtec_event.py?wfo={spec['wfo']}&year={spec['year']}"
                f"&phenomena={phen}&significance={sig}&etn={spec['etn']}")
    event = get(vtec_url).json()
    zone = next((u for u in event.get("ugcs", []) if u["ugc"] == spec["ugc"]), None)
    if zone is None:
        fail(f"{spec['id']}: {spec['ugc']} is not in the VTEC event record")
    text_url = f"{IEM}/api/1/nwstext/{spec['product_id']}"
    text = get(text_url).text
    segment = next((seg for seg in segments(text) if spec["ugc"] in seg[0]), None)
    if segment is None:
        fail(f"{spec['id']}: no segment for {spec['ugc']} in {spec['product_id']}")
    ugcs, lines = segment
    headline, description = headline_and_body(lines)
    counties = []
    for code in ugcs:
        if code[2] == "C":
            same = [f"0{STATE_FIPS[code[:2]]}{code[3:]}"]
        elif code in zone_table:
            same = zone_table[code]
        else:
            fail(f"{spec['id']}: zone {code} is not in the zone-county correlation file")
        counties += [c for c in same if c not in counties]
    names = {u["ugc"]: u["name"] for u in event["ugcs"]}
    sender = next(line for line in text.split("\n") if line.startswith("National Weather Service "))
    issued = datetime.strptime(spec["product_id"][:12], "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
    return {
        "event": EVENT_NAMES[spec["vtec"]],
        "headline": headline,
        "description": description,
        "areaDesc": "; ".join(names.get(code, code) for code in ugcs),
        "ugc": ugcs,
        "counties": counties,
        "counties_source": "County UGCs converted to SAME; zone UGCs mapped with the NWS zone-county "
                           f"correlation file {ZONE_COUNTY_URL}",
        "sent": issued.astimezone(CENTRAL).isoformat(),
        "onset": central(zone["utc_issue"]),
        "expires": central(zone["utc_expire"]),
        "times_source": f"onset and expires are when the warning began and ended for {spec['ugc']} "
                        "in the IEM VTEC event record; sent is when this product was issued",
        "sender": sender.split("  ")[0].strip(),
        "vtec": f"{spec['wfo']} {spec['vtec']} {spec['etn']} ({spec['year']})",
        "product_id": spec["product_id"],
        "source_url": f"{IEM}/p.php?pid={spec['product_id']}",
        "text_url": text_url,
        "vtec_url": vtec_url,
        "source_label": SOURCE_LABEL,
        "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--only", help="fetch one alert id")
    args = parser.parse_args()
    specs = [s for s in ALERTS if args.only in (None, s["id"])]
    if not specs:
        fail(f"no alert {args.only!r}; known: {', '.join(s['id'] for s in ALERTS)}")
    zone_table = zone_counties()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for spec in specs:
        alert = build(spec, zone_table)
        path = OUT_DIR / f"{spec['id']}.json"
        path.write_text(json.dumps(alert, indent=2) + "\n")
        print(f"{spec['id']}: {alert['event']}, {alert['onset']} to {alert['expires']}, "
              f"{len(alert['counties'])} counties -> {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
