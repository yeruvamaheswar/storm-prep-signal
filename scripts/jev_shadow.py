"""Ask TypeSafe's Jev one yes/no question about a storm alert and record the answer.

Usage: python scripts/jev_shadow.py

Shadow only: nothing in the engine or policy reads the recording, so Jev never makes a
dispatch decision. Reads the alert from tests/fixtures/nws_alert_harris.json when it exists,
otherwise a built-in sample, and writes data/fixtures/jev_harris.json. The key comes from
JEV_API_KEY in .env and is sent only in the Authorization header.
"""
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
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
    load_dotenv(ROOT / ".env")
    api_key = os.getenv("JEV_API_KEY", "")
    if not api_key:
        fail("JEV_API_KEY is not set in .env")
    alert, input_label = read_alert()

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
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(record, indent=2) + "\n")
    print(f"Jev ({model}, {input_label} input): {record['answer']}, P(yes)={probability:g},"
          f" {latency_ms} ms -> {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
