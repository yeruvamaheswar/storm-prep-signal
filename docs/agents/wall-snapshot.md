# Header snapshot

Decision (2026-09-26, Sunny): TARGET, DELIVERED, MISSED, PRICE, FLOOR, RISK, CALM, OUTAGE, MARGIN, ZONE, AS OF, and QUALITY read one `WallSnapshot`. Demo maps the tape into that type. Live maps the backend snapshot. The tiles do not mix a tape tick with a live stamp.

## Contract

`web/src/wallSnapshot.ts` is the type. Fields: `targetMw`, `deliveredMw`, `missedMw`, `priceMwh`, `floorPct`, `risk`, `calm`, `outageMw`, `outageThresholdMw`, `marginMw`, `zone`, `asOf`, `quality`, `reasonCodes[]`, `mode`, `brief`. `asOf` is `{ ageMin, label, pinned }`. `zoneMw` sits next to `zone` so the Zone caption can keep its MW line.

Demo (`demoSnapshot`) copies the tape, including a pinned fixture clock and the layout-run.json brief. Quality may be Demo data or Unchecked. If Live fell back to Demo, pass `fallbackQuality` so the cell names the failed pull instead of "Demo data".

Live (`liveSnapshot`) reads `GET /v1/snapshot`. Floor and risk come from `reserve_policy` on that posting: HIGH is 60% `storm_risk_high`, LOW is 30% `normal`. Price is shown only when the label is `ercot`, and only when that number came from a row. A selected zone uses `zone_prices` for that LZ; a missing row stays unread. The outage line uses `trigger_mw` from `compute_risk`; it does not borrow 22348 from the tape. Archive (`source=archive`) is the same path: `ercot_postings` payload → `compute_risk` → `reserve_policy`. A stale or missing report is fail-safe: risk None, floor 60%, reason `signal_unavailable`. QUALITY and the banner say that in Live. They do not relabel it Demo data. `brief` is generated from the tick's reason codes (`tickBrief` / `write_brief`). It does not keep "missed on purpose" or a tape index. `wallSnapshot({ runtime })` is the one entry both modes use.

## Live QUALITY and AS OF

Live QUALITY is only Live, Stale, Auth error, or Degraded. `liveQuality` in `web/src/qualityStatus.ts` maps the raw poll code. Demo data and Unchecked stay off the Live cell.

AS OF in Live is feed lag (`ageMin` and the posting label). A pinned fixture clock is blanked (`waiting on pull`) until a pull replaces it. The operator pin (`operatorPinned`, or choosing Demo) is the only way the cell says "clock pinned".

`GET /v1/snapshot` also sends `feeds[]` (NP3-233-CD and NP6-905-CD). The Quality drawer reads that list via `readSuppliedFeeds`. Hold-on-fail is the outage row, not a derived stamp failure.

The same poll, plus `GET /v1/meta`, stamps `source`, `event`, and `clock` on the mast. LIVE is the wall clock. ARCHIVE names the event and uses the pinned posting clock. Demo fixture is `layout-fixture`. The wall does not open a Supabase browser client.

## Code

- `web/src/wallOrigin.ts`: `wallOrigin` (LIVE / ARCHIVE / Demo fixture)
- `web/src/wallSnapshot.ts`: `WallSnapshot`, `demoSnapshot`, `liveSnapshot`, `wallSnapshot`
- `web/src/qualityStatus.ts`: `liveQuality`, `qualityView`
- `web/src/components/organisms/TopStrip.tsx`: every header tile reads the snapshot
- Mode choice stays in `docs/agents/runtime-mode.md`. If `GET /v1/snapshot` is called in Demo/Synthetic, price and outage come from the archive (`docs/agents/archive-feeds.md`), not live ERCOT.
