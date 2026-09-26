# Live and Demo

Decision (2026-09-26, Sunny): the wall has a run mode, Live or Demo. They do not share numbers. Live is `GET /v1/snapshot` on the wall clock. Demo without an event is `layout-run.json` (pinned 12:00 CT). Demo with an event (`?event=beryl|heather|tuning-2026`, or Demo click defaulting to beryl) pins the archive posting clock so risk, floor, and price come from the saved week, not the 12-tick layout numbers. `layout-run.json` is the no-archive fallback (the copy path in discovery). The weekend demo still runs when the live pull is quiet or fails.

## What each mode shows

Demo without an event keeps the tape, the pinned 12:00 CT clock, the 01–12 scrubber, the sparkline playhead and its tick 05/06 marks, the SYNTHETIC and Demo badges, scenes, and the fixture brief. No ERCOT overlay is required. Demo with an event polls `/v1/snapshot?event=&clock=` and pins risk, floor, and price to the archive posting.

Live replaces the tick counter with the current 15-minute ERCOT interval in Central time, and the mast clock is the wall clock. As of is the last successful pull. The 01–12 scrubber and the tape scenes (Fail-safe, High risk, 15% offline) are not on the page. Archive-clocked snapshot polls hide them too. Only `layout-fixture` keeps buttons 01–12. The bottom chart is the interval strip. Hold and Auto do not jump to a tape tick. Header tiles bind to the snapshot in `docs/agents/wall-snapshot.md`. Price is shown only when `price_label` is `ercot` (no tape 185). The outage trigger is shown only when `trigger_mw` arrived (no tape 22348). Quality is the feed health (Live, Degraded, Stale, Auth error). The rail brief is generated from reason codes (`storm_reserve`, `fleet_headroom_short`, `homes_dead:n`, `homes_stale:n`, `signal_unavailable`). The rail stamp does not name a tape index. Radar stays.

## How the mode is chosen

Order: operator click, `?mode=live|demo`, `VITE_DEFAULT_MODE`, then `GET /v1/meta` `{ mode, fleet_size, source, event, clock }`. `source` is `live`, `archive`, or `fixture`. `event` is `beryl`, `heather`, `tuning-2026`, or null. `clock` is `wall`, `archive`, or `fixture`. Live/archive allocate against the fleet cap, not the Demo 0.40 MW tape. The mast chip is LIVE, ARCHIVE plus the event name, or Demo fixture. Live still needs a reachable API. If the first snapshot fails, the wall falls back to Demo and Quality names that failed pull. After one good pull, a later failure stays on Live and keeps that as-of. Choosing Demo with `?event=none` keeps the tape. Demo without `?event=` defaults to beryl when that replay exists. Live cannot be chosen when the first pull has already failed.

The browser does not call ERCOT and does not need Vite ERCOT keys. Fixture Demo does not poll `/v1/snapshot`. Event Demo and Live do. Discovery uses `data/events/<event>/replay.csv`; `layout-run.json` is the copy/fallback path.

## Code

- `web/src/runtimeMode.ts`: `preferredMode`, `resolveRuntimeMode`, `ercotIntervalLabel`, `readingForMode`, `liveBrief`
- `web/src/loadRun.ts`: `requestedMode`, `requestedEvent`, `loadMeta`. `loadRun()` is the layout tape only.
- `web/src/liveStamp.ts`: `useLiveStamp(enabled, event, clock)` polls `/v1/snapshot` every 20 s. `liveSafeTick` drops tape 185 and the tape trigger.
- `web/src/wallOrigin.ts`: mast source, event, clock, and whether 01–12 may show.
- The scrubber is `TapeScrubber` in `web/src/components/organisms/ControlBar.tsx`. It renders only for `layout-fixture`. Live and archive-clocked render `IntervalStrip`.
