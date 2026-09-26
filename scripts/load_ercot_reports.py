"""Pull ERCOT reports for the Beryl and Heather weeks and the tuning month from the public API into Supabase.

Usage: python scripts/load_ercot_reports.py [--window beryl] [--report NP4-732-CD]
                                            [--start 2024-07-05 --end 2024-07-05]

Posted reports go to public.ercot_postings, one row per ERCOT posting, upserted on (report, posted_at).
NP6-905-CD prices have no posting time, so they go to public.ercot_prices, one row per load zone
per 15-minute interval, upserted on (settlement_point, interval_ending). Running again updates rows.
Needs ERCOT_USERNAME, ERCOT_PASSWORD, ERCOT_SUBSCRIPTION_KEY, SUPABASE_URL, SUPABASE_SECRET_KEY in server/.env.
"""
import argparse
import os
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT), str(ROOT / "scripts")]

from load_ercot_archive import BatchFailed, send  # noqa: E402
from server.env import ENV_PATH, load_env  # noqa: E402
from server.engine.signal import CENTRAL, SignalUnavailable, get_id_token, parse_central, rows_by_name  # noqa: E402

API_URL = "https://api.ercot.com/api/public-reports"
WINDOWS = {"beryl": ("2024-07-05", "2024-07-11"), "heather": ("2024-01-12", "2024-01-17"),
           "tuning-2026": ("2026-08-25", "2026-09-25")}
# report -> (API path, extra query filters). Every one of these has a postedDatetime per row.
POSTED = {
    "NP3-233-CD": ("np3-233-cd/hourly_res_outage_cap", {}),
    # Seven forecast models per posting; keep only the one ERCOT marks in use.
    "NP3-565-CD": ("np3-565-cd/lf_by_model_weather_zone", {"inUseFlag": "true"}),
    "NP4-732-CD": ("np4-732-cd/wpp_hrly_avrg_actl_fcast", {}),
    "NP4-737-CD": ("np4-737-cd/spp_hrly_avrg_actl_fcast", {}),
    "NP4-733-CD": ("np4-733-cd/wpp_actual_5min_avg_values", {}),
    "NP4-738-CD": ("np4-738-cd/spp_actual_5min_avg_values", {}),
}
PRICES = ("NP6-905-CD", "np6-905-cd/spp_node_zone_hub", {"settlementPointType": "LZ"})
# Beryl and Heather NP3-233-CD came from the saved zips (scripts/load_ercot_archive.py). Their posted_at
# is the file-name time, seconds off the API's postedDatetime, so an API copy would sit beside it, not on it.
SKIP = {("beryl", "NP3-233-CD"), ("heather", "NP3-233-CD")}
PAGE_SIZE = 10000
TIMEOUT_S = 60
# ERCOT answered HTTP 429 after about 30 calls in one minute, so stay under 30 a minute.
PAUSE_S = 2.2
RATE_LIMIT_WAIT_S = 60


def ercot_client(timeout=TIMEOUT_S):
    """A get(path, params) that logs in on first use, logs in again on 401, and waits out a 429."""
    username, password, key = (os.getenv(name, "") for name in
                               ("ERCOT_USERNAME", "ERCOT_PASSWORD", "ERCOT_SUBSCRIPTION_KEY"))
    if not (username and password and key):
        raise SignalUnavailable("ERCOT credentials missing from .env")
    headers = {}

    def get(path, params):
        for _ in range(3):
            if not headers:
                headers.update({"Authorization": f"Bearer {get_id_token(username, password, timeout)}",
                                "Ocp-Apim-Subscription-Key": key})
            time.sleep(PAUSE_S)
            reply = requests.get(f"{API_URL}/{path}", params=params, headers=headers, timeout=timeout)
            if reply.status_code == 200:
                return reply.json()
            if reply.status_code == 401:
                headers.clear()  # id_tokens last an hour
            elif reply.status_code == 429:
                time.sleep(RATE_LIMIT_WAIT_S)
            else:
                break
        raise SignalUnavailable(f"ERCOT {path} failed (HTTP {reply.status_code})")
    return get


def fetch_rows(get, path, params):
    """Every row for one query, as dicts keyed by the API field names, one page at a time."""
    rows, page = [], 1
    while True:
        body = get(path, {**params, "page": page, "size": PAGE_SIZE})
        rows += rows_by_name(body)
        if page >= body["_meta"]["totalPages"]:
            return rows
        page += 1


def posting_rows(report, event, rows):
    """Group API rows by postedDatetime: one ercot_postings row per posting, oldest first."""
    by_posting = {}
    for row in rows:
        row = dict(row)
        by_posting.setdefault(row.pop("postedDatetime"), []).append(row)
    return [{"report": report, "posted_at": parse_central(posted).isoformat(), "event": event,
             "file_name": None, "payload": payload}
            for posted, payload in sorted(by_posting.items())]


def interval_ending(delivery_date, hour, interval, dst_flag):
    """Central clock time a 15-minute interval ends. HE 1 interval 1 ends at 00:15."""
    start = datetime.combine(date.fromisoformat(delivery_date), datetime.min.time())
    # DSTFlag marks the repeated hour on the fall-back day, which is the second (fold=1) 01:00-02:00.
    end = start + timedelta(hours=hour - 1, minutes=15 * interval)
    return end.replace(tzinfo=CENTRAL, fold=int(dst_flag))


def price_rows(event, rows):
    return [{"settlement_point": row["settlementPoint"],
             "interval_ending": interval_ending(row["deliveryDate"], row["deliveryHour"],
                                                row["deliveryInterval"], row["DSTFlag"]).isoformat(),
             "delivery_date": row["deliveryDate"], "delivery_hour": row["deliveryHour"],
             "delivery_interval": row["deliveryInterval"], "dst_flag": row["DSTFlag"],
             "settlement_point_type": row["settlementPointType"],
             "price_usd_mwh": row["settlementPointPrice"], "report": PRICES[0], "event": event}
            for row in rows]


def days(first, last):
    day = first
    while day <= last:
        yield day
        day += timedelta(days=1)


def load_report(get, report, event, first, last, url, key):
    """Fetch and send one day at a time, so a failure keeps the days already sent."""
    sent_rows = sent_items = 0
    for day in days(first, last):
        if report == PRICES[0]:
            _, path, extra = PRICES
            rows = fetch_rows(get, path, {**extra, "deliveryDateFrom": day.isoformat(),
                                          "deliveryDateTo": day.isoformat()})
            items = price_rows(event, rows)
            send(items, url, key, table="ercot_prices", on_conflict="settlement_point,interval_ending")
        else:
            path, extra = POSTED[report]
            rows = fetch_rows(get, path, {**extra, "postedDatetimeFrom": f"{day}T00:00:00",
                                          "postedDatetimeTo": f"{day}T23:59:59"})
            items = posting_rows(report, event, rows)
            send(items, url, key)
        sent_rows += len(rows)
        sent_items += len(items)
    unit = "intervals x zones" if report == PRICES[0] else "postings"
    print(f"{event} {report}: {sent_items} {unit} from {sent_rows} API rows sent ({first} to {last})")


def main(argv=None):
    reports = [*POSTED, PRICES[0]]
    parser = argparse.ArgumentParser(description="Load ERCOT reports into Supabase.")
    parser.add_argument("--window", choices=sorted(WINDOWS), help="load only this window")
    parser.add_argument("--report", choices=reports, help="load only this report")
    parser.add_argument("--start", type=date.fromisoformat, help="first day, overrides the window's")
    parser.add_argument("--end", type=date.fromisoformat, help="last day, overrides the window's")
    args = parser.parse_args(argv)

    load_env(ENV_PATH)
    url, key = os.getenv("SUPABASE_URL", ""), os.getenv("SUPABASE_SECRET_KEY", "")
    if not (url and key):
        print("skipped: no_config")
        return 0
    try:
        get = ercot_client()
        for event in [args.window] if args.window else WINDOWS:
            first, last = (date.fromisoformat(day) for day in WINDOWS[event])
            for report in [args.report] if args.report else reports:
                if (event, report) in SKIP:
                    print(f"{event} {report}: skipped, already loaded from the saved archive")
                    continue
                load_report(get, report, event, args.start or first, args.end or last, url, key)
    except (SignalUnavailable, BatchFailed) as exc:
        print(f"failed: {exc}")
        return 1
    except requests.Timeout:
        print(f"failed: ERCOT did not answer within {TIMEOUT_S} s")
        return 1
    except requests.RequestException as exc:
        # The exception text can include the request, so only its type is shown.
        print(f"failed: network error reaching ERCOT ({type(exc).__name__})")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
