"""Load an NP3-233-CD response and turn it into the signal that compute_risk reads."""
import json
import os
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

# ERCOT writes times in Central Prevailing Time with no offset, so we attach the zone ourselves.
CENTRAL = ZoneInfo("America/Chicago")
# server/engine/signal.py → repo root is two parents up.
FIXTURE_PATH = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "np3_233_cd.json"
LIVE_PATH = Path("var") / "signal" / "latest_np3.json"
LIVE_SOURCE = "ERCOT NP3-233-CD"

# Auth and endpoint values from docs/agents/research.md sections 3 and 4.
TOKEN_URL = ("https://ercotb2c.b2clogin.com/ercotb2c.onmicrosoft.com/"
             "B2C_1_PUBAPI-ROPC-FLOW/oauth2/v2.0/token")
CLIENT_ID = "fec253ea-0d06-4272-a5e6-b478baeecd70"  # public, the same for every ERCOT user
REPORT_URL = "https://api.ercot.com/api/public-reports/np3-233-cd/hourly_res_outage_cap"
PRICE_URL = "https://api.ercot.com/api/public-reports/np6-905-cd/spp_node_zone_hub"
PRICE_PATH = Path("var") / "signal" / "latest_np6.json"
PRICE_SOURCE = "ERCOT NP6-905-CD"
# The wall's readPrice() only asks LZ_NORTH this pass. Other LZs and DAM NP4-190 stay out.
SETTLEMENT_POINT = "LZ_NORTH"
# SPP settles every 15 minutes; two missed intervals is stale (same as web/src/liveStamp.ts).
PRICE_STALE_MIN = 30


class SignalUnavailable(Exception):
    """A live fetch failed. The message is safe to print: it never holds credentials or tokens."""


def get_id_token(username, password, timeout):
    """Trade the ERCOT username and password for a one-hour id_token.

    Network and JSON errors are left to the caller, which turns them into a secret-free reason.
    """
    # Credentials go in the POST body, not the URL, so they can't land in proxy logs.
    token = requests.post(TOKEN_URL, timeout=timeout, data={
        "username": username, "password": password, "grant_type": "password",
        "scope": f"openid {CLIENT_ID} offline_access", "client_id": CLIENT_ID,
        "response_type": "id_token",
    })
    if token.status_code != 200:
        raise SignalUnavailable(f"ERCOT login refused (HTTP {token.status_code})")
    return json.loads(token.text)["id_token"]


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
        id_token = get_id_token(username, password, timeout)
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


def fetch_price(settings, now, save_to=PRICE_PATH, id_token=None):
    """Get a fresh ERCOT id_token (unless one is passed), then NP6-905-CD at LZ_NORTH.

    Same token helper and secret-free errors as fetch_outages. The raw body is saved
    to `save_to` so a later chat can replay it. This is the one live price GET.
    """
    username, password, key = (os.getenv(name, "") for name in
                               ("ERCOT_USERNAME", "ERCOT_PASSWORD", "ERCOT_SUBSCRIPTION_KEY"))
    if not (username and password and key):
        raise SignalUnavailable("ERCOT credentials missing from .env")
    timeout = settings["fetch_timeout_s"]
    try:
        token = id_token or get_id_token(username, password, timeout)
        today = now.astimezone(CENTRAL).date()
        # Yesterday through today, so the newest interval is found just after midnight too.
        report = requests.get(PRICE_URL, timeout=timeout,
                              params={"settlementPoint": SETTLEMENT_POINT,
                                      "deliveryDateFrom": (today - timedelta(days=1)).isoformat(),
                                      "deliveryDateTo": today.isoformat(),
                                      "size": 500},
                              headers={"Authorization": f"Bearer {token}",
                                       "Ocp-Apim-Subscription-Key": key})
        if report.status_code == 401:
            raise SignalUnavailable("auth rejected (HTTP 401)")
        if report.status_code != 200:
            raise SignalUnavailable(f"ERCOT report request failed (HTTP {report.status_code})")
        raw = json.loads(report.text)
    except requests.Timeout:
        raise SignalUnavailable(f"ERCOT did not answer within {timeout:g} s") from None
    except (ValueError, KeyError):
        raise SignalUnavailable("ERCOT reply was not the expected JSON") from None
    except requests.RequestException as exc:
        raise SignalUnavailable(f"network error reaching ERCOT ({type(exc).__name__})") from None
    save_to = Path(save_to)
    save_to.parent.mkdir(parents=True, exist_ok=True)
    save_to.write_text(report.text)
    return raw


def price_interval_end(delivery_date, hour, interval):
    """Central clock time a 15-minute SPP interval ends. HE 1 interval 1 ends at 00:15."""
    start = datetime.fromisoformat(delivery_date).replace(tzinfo=CENTRAL)
    return start + timedelta(hours=int(hour) - 1, minutes=int(interval) * 15)


def read_price(raw, now):
    """Newest LZ_NORTH settlementPointPrice, keyed by fields names, never column position.

    This is the one price reader. The engine tick and /v1/snapshot both call it.
    Matches the wall's readPrice(): newest deliveryDate / Hour / Interval, then age.
    """
    try:
        rows = rows_by_name(raw)
    except (KeyError, TypeError):
        raise SignalUnavailable("ERCOT reply was not the expected JSON") from None
    newest = None
    for row in rows:
        try:
            end = price_interval_end(row["deliveryDate"], row["deliveryHour"], row["deliveryInterval"])
            usd_mwh = float(row["settlementPointPrice"])
        except (KeyError, TypeError, ValueError):
            raise SignalUnavailable("ERCOT reply was not the expected JSON") from None
        if newest is None or end > newest["end"]:
            newest = {"end": end, "usd_mwh": usd_mwh, "row": row}
    if newest is None:
        raise SignalUnavailable("no LZ_NORTH price interval")
    age_min = (now - newest["end"]).total_seconds() / 60
    if age_min > PRICE_STALE_MIN:
        raise SignalUnavailable(f"price is {int(age_min)} min old (limit {PRICE_STALE_MIN})")
    row = newest["row"]
    return {
        "usd_mwh": newest["usd_mwh"],
        "as_of": newest["end"].isoformat(timespec="seconds"),
        "age_min": age_min,
        "delivery_date": row["deliveryDate"],
        "delivery_hour": row["deliveryHour"],
        "delivery_interval": row["deliveryInterval"],
    }


def load_price(settings, now=None):
    """Live LZ_NORTH price, or SignalUnavailable. Uses the same clock as load_signal."""
    clock = now or datetime.now(CENTRAL)
    return read_price(fetch_price(settings, clock), clock)


def stamp_price(tick, price):
    """Lay the live LZ_NORTH price on a tick dict. A failed read clears the tape number.

    stampTick in the browser keeps tape 185 on a failed pull. The Python live path
    must not: a missing ERCOT price is none, never the synthetic 185.
    """
    stamped = dict(tick)
    if price is None:
        stamped["price_usd_mwh"] = None
        stamped["price_label"] = "none"
        stamped["price_as_of"] = None
        return stamped
    stamped["price_usd_mwh"] = price["usd_mwh"]
    stamped["price_label"] = "ercot"
    stamped["price_as_of"] = price["as_of"]
    return stamped


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
