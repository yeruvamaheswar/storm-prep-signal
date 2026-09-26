"""Fetch newest ERCOT outage and price, upsert event=live, run one allocate tick.

Usage:
  python scripts/live_cycle.py            # one cycle
  python scripts/live_cycle.py --loop     # every tick_minutes
  python scripts/live_cycle.py --dry-run  # build rows, no Supabase, no persist

The engine never imports Supabase. This script upserts, then calls loop.run()
with the same posting it just stored.
"""
import argparse
import os
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT), str(ROOT / "scripts")]

from load_ercot_archive import BatchFailed, send  # noqa: E402
from load_ercot_reports import posting_rows, price_rows  # noqa: E402
from persist_run import persist_latest  # noqa: E402
from server.env import ENV_PATH, load_env  # noqa: E402
from server.engine.baseline import load_baseline  # noqa: E402
from server.engine.cli import read_settings  # noqa: E402
from server.engine.contracts import TapeFrame  # noqa: E402
from server.engine.fleet import DEMO_PEAK_MW  # noqa: E402
from server.engine.fleet_state import STATE_PATH  # noqa: E402
from server.engine.loop import LOG_DIR, RUNS_DIR, run  # noqa: E402
from server.engine.risk import compute_risk  # noqa: E402
from server.engine.signal import (  # noqa: E402
    CENTRAL,
    SignalUnavailable,
    fetch_outages,
    fetch_price,
    read_price,
    reject_stale,
    rows_by_name,
    to_signal,
)

LIVE_EVENT = "live"


def unique_rows(rows, keys):
    """Last row wins for each upsert key so one POST cannot hit ON CONFLICT twice."""
    by_key = {}
    for row in rows:
        by_key[tuple(row[k] for k in keys)] = row
    return list(by_key.values())


def live_posting_rows(raw, event=LIVE_EVENT):
    """One ercot_postings row per posting in a live NP3 body."""
    return unique_rows(posting_rows("NP3-233-CD", event, rows_by_name(raw)), ("report", "posted_at"))


def live_price_rows(raw, event=LIVE_EVENT):
    """NP6 rows for ercot_prices. Live fetch is LZ_NORTH; missing type/DST stay LZ / False."""
    filled = []
    for row in rows_by_name(raw):
        item = dict(row)
        item.setdefault("settlementPointType", "LZ")
        item.setdefault("DSTFlag", False)
        filled.append(item)
    return unique_rows(price_rows(event, filled), ("settlement_point", "interval_ending"))


def one_live_frame(now):
    """One 0.40 MW call. loop.run scales it to this fleet."""
    return TapeFrame(
        tick=1, ts=now.isoformat(timespec="seconds"),
        target_mw=DEMO_PEAK_MW, target_label="synthetic",
        price_usd_mwh=None, price_label="none",
    )


def upsert_live(postings, prices, url, key, send=send):
    """Best-effort upsert. Never deletes archive weeks."""
    if not (url and key) or send is None:
        return "skipped: no_config"
    try:
        if postings:
            send(unique_rows(postings, ("report", "posted_at")), url, key,
                 table="ercot_postings", on_conflict="report,posted_at")
        if prices:
            send(unique_rows(prices, ("settlement_point", "interval_ending")), url, key,
                 table="ercot_prices", on_conflict="settlement_point,interval_ending")
    except BatchFailed as exc:
        return f"skipped: {exc}"
    return "ok"


def rate_live(raw, settings, now):
    """Same posting the table just got. Stale or broken is fail-safe None."""
    try:
        reject_stale(raw, now, settings["stale_after_min"])
        signal = to_signal(raw, now)
        return compute_risk(
            signal, load_baseline(lookahead_hours=settings["lookahead_hours"]),
            margin_pct=settings["margin_pct"], lookahead_hours=settings["lookahead_hours"],
        )
    except (SignalUnavailable, KeyError, TypeError, ValueError):
        return None


def fetch_live(settings, now):
    """One outage GET, then a price GET. Price failure is None, not a hold."""
    outage = fetch_outages(settings, now)
    try:
        price = fetch_price(settings, now)
    except SignalUnavailable:
        price = None
    return outage, price


def run_cycle(settings, now=None, runs_dir=RUNS_DIR, log_dir=LOG_DIR, state_path=STATE_PATH,
              url=None, key=None, persist=True, send=send):
    """Fetch → upsert event=live → one allocate tick → optional persist_run."""
    now = now or datetime.now(CENTRAL)
    outage, price_raw = fetch_live(settings, now)
    postings = live_posting_rows(outage)
    prices = live_price_rows(price_raw) if price_raw is not None else []
    upsert = upsert_live(postings, prices, url or "", key or "", send=send)
    risk = rate_live(outage, settings, now)
    priced = None
    if price_raw is not None:
        try:
            priced = read_price(price_raw, now)
        except SignalUnavailable:
            priced = None
    record = run(
        None, settings, log_dir=log_dir, runs_dir=runs_dir, live=True,
        state_path=state_path, frames=[one_live_frame(now)],
        live_risk=risk, live_price=priced,
    )
    persist_status = "skipped: dry_run"
    if persist:
        persist_status = persist_latest(Path(runs_dir) / "latest.json", url=url, key=key)
    return {"record": record, "upsert": upsert, "persist": persist_status}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Pull live ERCOT into Supabase and run one tick.")
    parser.add_argument("--loop", action="store_true", help="repeat every tick_minutes")
    parser.add_argument("--dry-run", action="store_true", help="fetch and allocate, send nothing")
    args = parser.parse_args(argv)
    load_env(ENV_PATH)
    settings = read_settings()
    url, key = os.getenv("SUPABASE_URL", ""), os.getenv("SUPABASE_SECRET_KEY", "")
    persist = not args.dry_run
    sender = None if args.dry_run else send
    if args.dry_run:
        url = key = ""

    def once():
        try:
            result = run_cycle(settings, url=url, key=key, persist=persist, send=sender)
        except SignalUnavailable as exc:
            print(f"live_cycle: {exc}")
            return 0
        tick = result["record"]["ticks"][-1] if result["record"]["ticks"] else {}
        print(f"live_cycle: upsert {result['upsert']} | persist {result['persist']} | "
              f"{tick.get('mode', '?')} delivered {tick.get('delivered_mw', 0):.3f} of "
              f"{tick.get('target_mw', 0):.3f} MW")
        return 0

    if not args.loop:
        return once()
    pause = max(1, int(settings["tick_minutes"]) * 60)
    while True:
        once()
        time.sleep(pause)


if __name__ == "__main__":
    sys.exit(main())
