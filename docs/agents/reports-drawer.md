# Reports drawer

**Decision.** Quality opens a compact Feeds panel. The same list sits in the side rail. The purpose line is "Which ERCOT products are live". Each row is product, load zone, as-of, last success, and state (`live` / `stale` / `hold` / `auth`). It does not print EMIL rows.

The wall fetchers are in `web/src/liveStamp.ts`. One pull reads two products: NP6-905-CD settlement price at `LZ_NORTH`, and NP3-233-CD hourly resource outage. The outage product posts about hourly. The wall asks again every 5 minutes (`LIVE_POLL_MIN`). A missing token, or HTTP 401 or 403, is quality `auth`.

`web/src/reportFeeds.ts` is the list. Demo fills two fixture rows from the posting on the tape. Live copies ingest health onto those same products. A later engine field with the same `FeedRow` shape is used as written (`readSuppliedFeeds`). Do not add that field to `contracts.py` from this wall; Uma owns shared fields.

Quality already turns that code into Auth error, Stale, Degraded, or Live. The old caption "named fail" stays off the wall. A live failure laid on the pinned synthetic tape is Demo data, so the panel does not call it a live bad pull. A credentialed pull that has spoken binds Quality to ingest health even if the rest of the wall is still the tape. A file or fixture pins the clock to the posting. A live fetch does not.

Late, missing, or auth-fail holds spare energy. The banner sentence is `UNTRUSTED_REPORT` in `web/src/wallLines.ts`. The codes are `untrustedReport` there. The reason list says "Holding spare energy" (`holding_spare_energy` in `web/src/format.ts`). Operator Hold and a storm discharge are different lines, and those stay clear.

Last success is the as-of time when the check passed, the posting is only stale, the clock is pinned to a demo posting, or ingest kept a last good pull. A failed read with no last success is "none".
