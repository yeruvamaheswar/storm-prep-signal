"""Ask TypeSafe's Jev one yes/no question about a storm alert and record the answer.

Usage: python scripts/jev_shadow.py
       python scripts/jev_shadow.py --alert <id> [--county FIPS] [--out PATH]
       python scripts/jev_shadow.py --alert <id> --all-counties

The /flow session reads the recordings once per alert and county: a county the alert names gets
its alert floor only when Jev says yes (P(yes) >= policy.JEV_YES_AT); no recording keeps the storm
reserve. With no --alert, reads tests/fixtures/nws_alert_harris.json when it exists, otherwise a
built-in sample, and writes data/fixtures/jev_harris.json (not read by the session). With --alert,
sends the archived NWS alert data/fixtures/nws/<id>.json plus one county and its load zone, and
writes data/fixtures/jev/<id>/<fips>.json. The county is --county (a roster county the alert
names), or with neither flag the anchor county of the alert's one load zone. --all-counties asks
about every roster county the alert names that has no recording yet; a failure stops the run, so
run it again to retry the rest. The key comes from JEV_API_KEY in .env and is sent only in the
Authorization header.
"""
import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server.engine.cli import read_settings  # noqa: E402
from server.engine.policy import JEV_YES_AT  # noqa: E402
from server.engine.scenario import ALERT_DIR, JEV_DIR, alert_counties, load_alert  # noqa: E402

ALERT_FIXTURE = ROOT / "tests" / "fixtures" / "nws_alert_harris.json"
OUTPUT = ROOT / "data" / "fixtures" / "jev_harris.json"
JEV_URL = "https://api.typesafe.ai/v1/systemone"
MODEL = "jev-latest"
TIMEOUT_S = 5
QUESTION = "Does this alert threaten power delivery to homes in this county in the next 6 hours?"
# The answer key is only a label for the reply; TypeSafe does not send it to the model.
QUESTION_ID = "threatens_power"
SAMPLE_ALERT = {
    "headline": "Hurricane Warning issued for Harris County, TX",
    "description": "Hurricane-force winds expected; widespread power outages likely.",
    "county": "Harris (48201)",
}


def fail(reason):
    """The one exit for every failure: a short reason on stderr, exit code 1, never a secret."""
    sys.exit(f"jev_shadow failed: {reason}")


def read_alert():
    """The alert text and where it came from ("fixture" or "sample")."""
    if not ALERT_FIXTURE.exists():
        return SAMPLE_ALERT, "sample"
    try:
        raw = json.loads(ALERT_FIXTURE.read_text())
    except (OSError, ValueError) as exc:
        fail(f"could not read {ALERT_FIXTURE.name} ({type(exc).__name__})")
    # NWS alerts nest the text under "properties" and name the area "areaDesc".
    props = raw.get("properties", raw)
    alert = {"headline": props.get("headline"), "description": props.get("description"),
             "county": props.get("county") or props.get("areaDesc")}
    if not all(alert.values()):
        fail(f"{ALERT_FIXTURE.name} is missing headline, description, or county")
    return alert, "fixture"


def archived_counties(alert_id, county=None, all_counties=False):
    """The archived alert and the (zone, fips, name) roster counties to ask about."""
    alert = load_alert(alert_id, ROOT / ALERT_DIR)
    if alert is None:
        fail(f"no archived alert {alert_id!r} in {ALERT_DIR}")
    settings = read_settings()
    counties, _ = alert_counties(alert, settings)
    if county:
        rows = [row for row in counties if row[1] == county]
        if not rows:
            fail(f"county {county} is not a roster county named by {alert_id}")
    elif all_counties:
        rows = [row for row in counties if not (ROOT / JEV_DIR / alert_id / f"{row[1]}.json").exists()]
    else:
        zones = sorted({zone for zone, _, _ in counties})
        if len(zones) != 1:
            fail(f"{alert_id} maps to {len(zones)} load zones; the question names one county")
        rows = [row for row in counties if row[1] == settings["zones"][zones[0]]]
        if not rows:
            fail(f"{alert_id} does not name the {zones[0]} anchor county")
    return alert, rows


def county_state(alert_id, alert, zone, fips, name):
    """The alert text plus one county and its load zone, and the input label."""
    state = {key: alert.get(key) for key in ("event", "headline", "description", "areaDesc", "sender",
                                             "sent", "onset", "expires")}
    state["county"] = f"FIPS {fips} ({name})"
    state["load_zone"] = zone
    if not all(state.values()):
        fail(f"{alert_id} is missing one of {', '.join(state)}")
    label = f"archived NWS alert {alert.get('product_id', alert_id)}, county {fips} ({name}, {zone} zone)"
    return state, label


def ask_jev(api_key, alert):
    """One POST, no retries. Returns the parsed reply and the round trip in milliseconds."""
    body = {"model": MODEL, "state": alert,
            "questions": {QUESTION_ID: {"type": "noul", "instructions": QUESTION}}}
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    started = time.monotonic()
    try:
        reply = requests.post(JEV_URL, json=body, headers=headers, timeout=TIMEOUT_S)
    except requests.Timeout:
        fail(f"Jev did not answer within {TIMEOUT_S} s")
    except requests.RequestException as exc:
        fail(f"network error reaching Jev ({type(exc).__name__})")
    latency_ms = round((time.monotonic() - started) * 1000)
    if reply.status_code != 200:
        fail(f"Jev returned HTTP {reply.status_code}")
    try:
        return reply.json(), latency_ms
    except ValueError:
        fail("Jev reply was not JSON")


def record_reading(api_key, alert, input_label, output, extra):
    """Ask Jev once and write the reading, with `extra` fields added to the record."""
    output = output if output.is_absolute() else ROOT / output
    called_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    reply, latency_ms = ask_jev(api_key, alert)
    try:
        probability = float(reply["answers"][QUESTION_ID]["noul"])
        model = reply["model"]
    except (KeyError, TypeError, ValueError):
        fail("Jev reply did not contain a noul answer")

    record = {
        "question": QUESTION,
        "answer": "yes" if probability >= JEV_YES_AT else "no",
        "probability": probability,
        "model": model,
        "called_at": called_at,
        "latency_ms": latency_ms,
        "input_label": input_label,
        "recorded": True,
        **extra,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(record, indent=2) + "\n")
    print(f"Jev ({model}, {input_label} input): {record['answer']}, P(yes)={probability:g},"
          f" {latency_ms} ms -> {output}")


def main():
    parser = argparse.ArgumentParser(description="Record one Jev reading per storm alert and county.")
    parser.add_argument("--alert", help="archived alert id in data/fixtures/nws/")
    parser.add_argument("--county", help="county FIPS: a roster county the alert names")
    parser.add_argument("--all-counties", action="store_true",
                        help="every roster county the alert names that has no reading yet")
    parser.add_argument("--out", help="output path (default data/fixtures/jev/<alert>/<fips>.json)")
    args = parser.parse_args()
    if (args.county or args.all_counties) and not args.alert:
        parser.error("--county and --all-counties need --alert")
    if args.county and args.all_counties:
        parser.error("give --county or --all-counties, not both")
    if args.out and args.all_counties:
        parser.error("--out writes one reading; --all-counties writes one per county")
    load_dotenv(ROOT / ".env")
    api_key = os.getenv("JEV_API_KEY", "")
    if not api_key:
        fail("JEV_API_KEY is not set in .env")
    if not args.alert:
        alert, input_label = read_alert()
        record_reading(api_key, alert, input_label, Path(args.out) if args.out else OUTPUT, {})
        return
    alert, rows = archived_counties(args.alert, args.county, args.all_counties)
    if not rows:
        print(f"{args.alert}: every roster county it names already has a reading")
    for zone, fips, name in rows:
        state, input_label = county_state(args.alert, alert, zone, fips, name)
        output = Path(args.out) if args.out else JEV_DIR / args.alert / f"{fips}.json"
        record_reading(api_key, state, input_label, output, {"alert_id": args.alert, "county_fips": fips})


if __name__ == "__main__":
    main()
