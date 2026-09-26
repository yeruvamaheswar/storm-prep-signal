# Reports drawer

**Decision.** Quality opens a compact Feeds panel. The same list sits in the side rail. The purpose line is "Which ERCOT products are live". Each row is product, load zone, as-of, last success, and state (`live` / `stale` / `hold` / `auth`). It does not print EMIL rows.

The wall fetcher is in `web/src/liveStamp.ts`. Live polls `GET /v1/snapshot` every 20 s (`LIVE_POLL_MS`). It does not call ERCOT or `/v1/feeds/outage` / `/v1/feeds/price`. The drawer also loads `GET /v1/feeds` once for history chips. One snapshot still covers two products: NP6-905-CD settlement price at `LZ_NORTH`, and NP3-233-CD hourly resource outage. HTTP 401 or 403, mapped by the API, is quality `auth`. The browser does not send a B2C token. Stream events: `docs/agents/backend.md`.

`web/src/reportFeeds.ts` is the list. Demo fills two fixture rows from the posting on the tape. Live copies ingest health onto those same products. `GET /v1/snapshot` now sends `feeds[]` as `{ product, path, as_of, age_min, quality, hold_on_fail, http_status }`. `readSuppliedFeeds` maps that shape onto drawer rows. A `FeedRow` list is still used as written. Do not add that field to `contracts.py` from this wall; Uma owns shared fields.

`GET /v1/feeds` adds read-only history chips: NP3-233-CD plus whatever is loaded (NP3-565-CD, NP4-732/733/737/738-CD). `file_name` set marks a zip; null marks an API posting. NP6-905-CD is not a chip. QUALITY still reads snapshot ingest health, not those chips. Details: `docs/agents/feeds-proxy.md`.

Quality already turns that code into Auth error, Stale, Degraded, or Live. The old caption "named fail" stays off the wall. A live failure laid on the pinned synthetic tape is Demo data, so the panel does not call it a live bad pull. A credentialed pull that has spoken binds Quality to ingest health even if the rest of the wall is still the tape. A file or fixture pins the clock to the posting. A live fetch does not.

Late, missing, or auth-fail holds spare energy. The banner sentence is `UNTRUSTED_REPORT` in `web/src/wallLines.ts`. The codes are `untrustedReport` there. The reason list says "Holding spare energy" (`holding_spare_energy` in `web/src/format.ts`). Operator Hold and a storm discharge are different lines, and those stay clear.

Last success is the as-of time when the check passed, the posting is only stale, the clock is pinned to a demo posting, or ingest kept a last good pull. A failed read with no last success is "none".
