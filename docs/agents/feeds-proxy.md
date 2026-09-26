# ERCOT feed proxy

**Decision (2026-09-26).** The wall never holds `ERCOT_USERNAME`, `ERCOT_PASSWORD`, `ERCOT_SUBSCRIPTION_KEY`, or the B2C `id_token`. `GET /v1/feeds/outage` and `GET /v1/feeds/price` do the ROPC login and the ERCOT GETs. `GET /v1/feeds?event=` is the product catalog: latest `ercot_postings` row per report for that event, plus live quality from `var/signal/`. The wall's Live path polls `/v1/snapshot` only for floor and price. Vite has no `VITE_ERCOT_*` keys.

## Response

Always HTTP 200:

```json
{ "quality": "ok", "cached": false, "body": {}, "http_status": 200 }
```

`quality` is `ok`, `auth`, `timeout`, `stale`, `malformed`, or `unavailable`. `body` is the last ERCOT JSON, or `null`. `http_status` is the last ERCOT code, or null. It never holds a token.

## Mapping

- HTTP 401 or 403, or missing `.env` credentials → `auth`. A cached file is not treated as a good read.
- HTTP 429 or 5xx, or a timeout → last good body if it is still inside the stale window (`ok` + `cached: true`); else `unavailable` or `stale`.
- Outage posting older than 90 minutes → `stale`. Price interval older than 30 minutes → `stale`.

## Catalog (`GET /v1/feeds`)

`event` is `beryl`, `heather`, or `tuning-2026`. Omitted, it uses the archive clock's event, else `beryl`. Each product is `{ report, posted_at, row_count, event, file_name, quality, role }`.

- `file_name` set = zip from `load_ercot_archive.py`. `file_name` null = API from `load_ercot_reports.py`.
- Live `quality` (`ok|auth|timeout|stale|malformed|unavailable`) is read from `var/signal/` only. This route does not call ERCOT.
- `role` is `floor` (NP3-233-CD), `price` (NP6-905-CD), or `history` (NP3-565-CD, NP4-732/733/737/738-CD when loaded). History `quality` is null.
- Missing Supabase keys or a failed read still returns the two drivers. Only NP3-233-CD and NP6-905-CD drive floor and price this pass (`GET /v1/snapshot`).

## Code

- `server/api/feeds.py`: Live uses `fetch_outages` and `fetch_price` from `server/engine/signal.py`. Cache at `var/signal/latest_np3.json` and `var/signal/latest_np6.json`. Demo/Synthetic uses `server/api/archive.py` at the tape clock (`docs/agents/archive-feeds.md`). The price parser is `read_price` (`docs/agents/price-live.md`). `list_feeds()` builds the catalog.
- `server/api/snapshot.py`: `live_ingest` reads those two feeds. It does not call ERCOT itself.
- `web/src/vite-env.d.ts`: only `VITE_API_BASE_URL`.
