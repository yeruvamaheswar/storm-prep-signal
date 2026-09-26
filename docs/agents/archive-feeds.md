# Archive price and outage (Demo / Synthetic)

**Decision (2026-09-26).** When the last run is not Live, `GET /v1/snapshot` and `serve_price()` / `serve_outage()` read `public.ercot_postings` and `public.ercot_prices`. Live now reads `event=live` rows from those same tables after `scripts/live_cycle.py` upserts them (`docs/agents/live-ingest.md`). Direct `signal.py` / `var/signal/` is the fallback when that row is missing. The archive tables are durable: a tape reset must never truncate them.

## Reader

`server/api/archive.py` takes `event` + `clock`. It picks:

- Newest NP3-233-CD row for that event with `posted_at <= clock`. The live-shaped body is the saved `payload` plus `postedDatetime` copied from `posted_at` (the loader pops that field; upsert key is `(report, posted_at)`).
- Newest NP6-905-CD `LZ_NORTH` row with `interval_ending <= clock`. The other three load zones (`LZ_HOUSTON`, `LZ_SOUTH`, `LZ_WEST`) are the rows at that same interval. Ignore `LZ_AEN|CPS|LCRA|RAYBN`. Upsert key is `(settlement_point, interval_ending)`. Snapshot stamps `zone_prices` and, when `?zone=` is set, that zone's `price_usd_mwh`. Label `ercot` only when a row exists.

Event is inferred from the clock (`beryl`, `heather`, `tuning-2026`, including each storm’s 30-day baseline window). Demo/Synthetic uses the last tick `ts` as the clock, so a Beryl tape does not pull today’s ERCOT. Missing Supabase keys, a timeout, or no row is quality `unavailable` (fail-safe). A missing price is named and does not hold; a missing outage does.

`check_margin.py` is the older full-table reader (every posting, for margin counts). The wall path is one posting and one interval, GET only. The Feeds catalog (`GET /v1/feeds`) is a different read: latest posting per report, no clock filter. Home: `docs/agents/feeds-proxy.md`.

## Routing

- `source=live` → newest `event=live` posting (`archive_ingest`). Direct `live_ingest` / `signal.py` if that row is missing or stale.
- `source=archive` → `archive_ingest`: GET `ercot_postings` (same payload `check_margin.py` reads) → wrap as an NP3 body → `compute_risk` → `reserve_policy`. Snapshot sends `trigger_mw`, `peak_mw`, zone hour totals, and `policy_reason` from that rating. It does not copy tape `22348`.
- Stale windows stay in Python: 90 minutes for the posting vs the archive clock, 30 minutes for price (`read_price`).
- A missing posting is `signal_unavailable` and floor 60%. A missing price is named and does not hold.

## Not this pass

- Rebuilding the baseline from Supabase (snapshot still uses `data/baseline_by_lead.json`).
- Writing or truncating `ercot_postings` / `ercot_prices`.
- Changing the Demo wall to poll `/v1/snapshot` (it still reads the tape; this path is for the API).
