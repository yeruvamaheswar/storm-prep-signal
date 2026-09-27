"""Ask TypeSafe's Jev one yes/no question about a storm alert and record the answer.

Usage: python scripts/jev_shadow.py
       python scripts/jev_shadow.py --alert <id> [--out data/fixtures/jev/<id>.json]

Shadow only: the engine and policy never read the recording, so Jev never makes a dispatch
decision; the /flow page only shows it next to the rule. With no --alert, reads
tests/fixtures/nws_alert_harris.json when it exists, otherwise a built-in sample, and writes
data/fixtures/jev_harris.json. With --alert, sends the archived NWS alert
data/fixtures/nws/<id>.json plus the load zone its county maps to, and writes
data/fixtures/jev/<id>.json. The key comes from JEV_API_KEY in .env and is sent only in the
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
from server.engine.scenario import ALERT_DIR, JEV_DIR, alert_zones, load_alert  # noqa: E402

ALERT_FIXTURE = ROOT / "tests" / "fixtures" / "nws_alert_harris.json"
OUTPUT = ROOT / "data" / "fixtures" / "jev_harris.json"
JEV_URL = "https://api.typesafe.ai/v1/systemone"
MODEL = "jev-latest"
TIMEOUT_S = 5
QUESTION = "Does this alert threaten power delivery to homes in this county in the next 6 hours?"
# The answer key is only a label for the reply; TypeSafe does not send it to the model.
QUESTION_ID = "threatens_power"
# Jev returns P(yes); "yes" at 0.5 or above is our reading, not something Jev reports.
YES_AT = 0.5
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


def read_archived_alert(alert_id):
    """The archived alert text plus the one load zone and county it maps to, and its input label."""
    alert = load_alert(alert_id, ROOT / ALERT_DIR)
    if alert is None:
        fail(f"no archived alert {alert_id!r} in {ALERT_DIR}")
    settings = read_settings()
    zones, _ = alert_zones(alert, settings)
    if len(zones) != 1:
        fail(f"{alert_id} maps to {len(zones)} load zones; the question names one county")
    zone = zones[0]
    county = settings["zones"][zone]
    state = {key: alert.get(key) for key in ("event", "headline", "description", "areaDesc", "sender",
                                             "sent", "onset", "expires")}
    state["county"] = f"FIPS {county}"
    state["load_zone"] = zone
    if not all(state.values()):
        fail(f"{alert_id} is missing one of {', '.join(state)}")
    label = f"archived NWS alert {alert.get('product_id', alert_id)}, county {county} ({zone} zone)"
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


def main():
    parser = argparse.ArgumentParser(description="Record one shadow Jev reading for a storm alert.")
    parser.add_argument("--alert", help="archived alert id in data/fixtures/nws/")
    parser.add_argument("--out", help="output path (default data/fixtures/jev/<alert>.json)")
    args = parser.parse_args()
    load_dotenv(ROOT / ".env")
    api_key = os.getenv("JEV_API_KEY", "")
    if not api_key:
        fail("JEV_API_KEY is not set in .env")
    if args.alert:
        alert, input_label = read_archived_alert(args.alert)
        output = Path(args.out) if args.out else ROOT / JEV_DIR / f"{args.alert}.json"
    else:
        alert, input_label = read_alert()
        output = Path(args.out) if args.out else OUTPUT
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
        "answer": "yes" if probability >= YES_AT else "no",
        "probability": probability,
        "model": model,
        "called_at": called_at,
        "latency_ms": latency_ms,
        "input_label": input_label,
        "recorded": True,
    }
    if args.alert:
        record["alert_id"] = args.alert
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(record, indent=2) + "\n")
    print(f"Jev ({model}, {input_label} input): {record['answer']}, P(yes)={probability:g},"
          f" {latency_ms} ms -> {output}")


if __name__ == "__main__":
    main()
