# Header snapshot

Decision (2026-09-26, Sunny): TARGET, DELIVERED, MISSED, PRICE, FLOOR, RISK, CALM, OUTAGE, MARGIN, ZONE, AS OF, and QUALITY read one `WallSnapshot`. Demo maps the tape into that type. Live maps the backend poll. The tiles do not read a tape tick or a live stamp directly.

## Contract

`web/src/wallSnapshot.ts` is the type. Fields: `targetMw`, `deliveredMw`, `missedMw`, `priceMwh`, `floorPct`, `risk`, `calm`, `outageMw`, `outageThresholdMw`, `marginMw`, `zone`, `asOf`, `quality`, `reasonCodes[]`, `mode`. `asOf` is `{ ageMin, label, pinned }`. `zoneMw` sits next to `zone` so the Zone caption can keep its MW line.

Demo (`demoSnapshot`) copies the tape, including a pinned fixture clock. Quality may be Demo data or Unchecked.

Live (`liveSnapshot`) keeps target, delivered, missed, floor, risk, calm, reasons, and mode on the tape. Price, outage, zone, as-of, and quality come from `LiveWatch`. Threshold and margin stay empty on a live posting: the tape trigger is not this report. `wallSnapshot({ runtime })` is the one entry both modes use.

## Live QUALITY and AS OF

Live QUALITY is only Live, Stale, Auth error, or Degraded. `liveQuality` in `web/src/qualityStatus.ts` maps the raw poll code. `unchecked` and fixture overlays become Degraded. Demo data and Unchecked stay off the Live cell.

AS OF in Live is feed lag (`ageMin` and the posting label). A pinned fixture clock is blanked (`waiting on pull`) until a pull replaces it. The operator pin (`operatorPinned`, or choosing Demo) is the only way the cell says "clock pinned".

## Code

- `web/src/wallSnapshot.ts`: `WallSnapshot`, `demoSnapshot`, `liveSnapshot`, `wallSnapshot`
- `web/src/qualityStatus.ts`: `liveQuality`, `qualityView`
- `web/src/components/organisms/TopStrip.tsx`: every header tile reads the snapshot
- Mode choice stays in `docs/agents/runtime-mode.md`
