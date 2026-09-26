"""Load an NP3-233-CD response and turn it into the signal that compute_risk reads."""
import json
import os
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

# ERCOT writes times in Central Prevailing Time with no offset, so we attach the zone ourselves.
CENTRAL = ZoneInfo("America/Chicago")
FIXTURE_PATH = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "np3_233_cd.json"
LIVE_PATH = Path("var") / "signal" / "latest_np3.json"
LIVE_SOURCE = "ERCOT NP3-233-CD"

# Auth and endpoint values from docs/agents/research.md sections 3 and 4.
TOKEN_URL = ("https://ercotb2c.b2clogin.com/ercotb2c.onmicrosoft.com/"
             "B2C_1_PUBAPI-ROPC-FLOW/oauth2/v2.0/token")
CLIENT_ID = "fec253ea-0d06-4272-a5e6-b478baeecd70"  # public, the same for every ERCOT user
REPORT_URL = "https://api.ercot.com/api/public-reports/np3-233-cd/hourly_res_outage_cap"


class SignalUnavailable(Exception):
    """A live fetch failed. The message is safe to print: it never holds credentials or tokens."""


def fetch_outages(settings, now, save_to=LIVE_PATH):
    """Get a fresh ERCOT id_token, then the newest NP3-233-CD postings. Returns the raw JSON body.

    The one place that catches network errors; each becomes SignalUnavailable with a short reason.
    The raw body is saved to `save_to` so the run can be replayed with --file.
    """
    username, password, key = (os.getenv(name, "") for name in
                               ("ERCOT_USERNAME", "ERCOT_PASSWORD", "ERCOT_SUBSCRIPTION_KEY"))
    if not (username and password and key):
        raise SignalUnavailable("ERCOT credentials missing from .env")
    timeout = settings["fetch_timeout_s"]
    try:
        # Credentials go in the POST body, not the URL, so they can't land in proxy logs.
        token = requests.post(TOKEN_URL, timeout=timeout, data={
            "username": username, "password": password, "grant_type": "password",
            "scope": f"openid {CLIENT_ID} offline_access", "client_id": CLIENT_ID,
            "response_type": "id_token",
        })
        if token.status_code != 200:
            raise SignalUnavailable(f"ERCOT login refused (HTTP {token.status_code})")
        id_token = json.loads(token.text)["id_token"]
        # The verified query: the last two hours of postings, which always holds the newest one.
        since = (now.astimezone(CENTRAL) - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%S")
        report = requests.get(REPORT_URL, timeout=timeout,
                              params={"postedDatetimeFrom": since, "size": 400},
                              headers={"Authorization": f"Bearer {id_token}",
                                       "Ocp-Apim-Subscription-Key": key})
        if report.status_code == 401:
            raise SignalUnavailable("auth rejected (HTTP 401)")
        if report.status_code != 200:
            raise SignalUnavailable(f"ERCOT report request failed (HTTP {report.status_code})")
        raw = json.loads(report.text)
    # `from None` drops the original exception so no traceback can carry request details.
    except requests.Timeout:
        raise SignalUnavailable(f"ERCOT did not answer within {timeout:g} s") from None
    except (ValueError, KeyError):
        # json errors are ValueErrors; KeyError means the token reply had no id_token.
        raise SignalUnavailable("ERCOT reply was not the expected JSON") from None
    except requests.RequestException as exc:
        raise SignalUnavailable(f"network error reaching ERCOT ({type(exc).__name__})") from None
    save_to = Path(save_to)
    save_to.parent.mkdir(parents=True, exist_ok=True)
    save_to.write_text(report.text)
    return raw


def rows_by_name(raw):
    """Turn each data row (a plain list) into a dict keyed by the names in `fields`.

    ERCOT describes the columns in `fields`, so we never depend on column positions.
    """
    names = [field["name"] for field in raw["fields"]]
    return [dict(zip(names, values)) for values in raw["data"]]


def newest_posting_time(rows):
    # The timestamps share one format, so the largest string is the newest posting.
    return max(row["postedDatetime"] for row in rows)


def parse_central(text):
    return datetime.fromisoformat(text).replace(tzinfo=CENTRAL)


def reject_stale(raw, now, limit_min):
    """An old forecast rated as current would hide a storm, so treat it as no signal at all."""
    posted = parse_central(newest_posting_time(rows_by_name(raw)))
    if now - posted > timedelta(minutes=limit_min):
        # Same rounding as the decision line's "N min old".
        age_min = int((now - posted).total_seconds() // 60)
        raise SignalUnavailable(f"data is {age_min} min old (limit {limit_min})")


def load_signal(args, settings=None):
    """Read a saved response (--fixture or --file), or fetch the live one (--live).

    File modes pin the clock to the posting time so a saved file rates the same way every run.
    Live mode uses the real clock, and only live data can be too old: saved files are old on purpose.
    """
    if not (args.fixture or args.file):
        now = datetime.now(CENTRAL)
        raw = fetch_outages(settings, now)
        reject_stale(raw, now, settings["stale_after_min"])
        return {"raw": raw, "now": now, "source": LIVE_SOURCE, "clock_pinned": False,
                "path": str(LIVE_PATH)}
    path = FIXTURE_PATH if args.fixture else Path(args.file)
    raw = json.loads(path.read_text())
    # A top-level "_note" marks a hand-edited file, so the decision line can say so.
    source = "fixture (synthetic)" if "_note" in raw else "fixture"
    now = parse_central(newest_posting_time(rows_by_name(raw)))
    return {"raw": raw, "now": now, "source": source, "clock_pinned": True, "path": str(path)}


def to_signal(raw, now):
    """Build the plain dict that compute_risk needs. Pure: the clock comes in as `now`."""
    rows = rows_by_name(raw)
    newest = newest_posting_time(rows)
    # Only the newest posting counts; older postings are outdated forecasts.
    posting = [row for row in rows if row["postedDatetime"] == newest]
    posting.sort(key=lambda row: (row["operatingDate"], row["hourEnding"]))
    local_now = now.astimezone(CENTRAL)
    return {
        "posted_at": parse_central(newest),
        "current_date": local_now.date().isoformat(),
        # Hour ending N is the hour that finishes at N:00, so 12:00-12:59 is HE13.
        "current_hour_ending": local_now.hour + 1,
        "rows": posting,
    }
