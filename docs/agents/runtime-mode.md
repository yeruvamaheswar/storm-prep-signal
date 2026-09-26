# Live and Demo

Decision (2026-09-26, Sunny): the wall has a run mode, Live or Demo. Demo is the 12-tick tape. Live is the ERCOT clock. The weekend demo still runs when the pull fails.

## What each mode shows

Demo keeps the tape, the pinned 12:00 CT clock, the 01–12 scrubber, the sparkline playhead and its tick 05/06 marks, the SYNTHETIC and Demo badges, and the fixture brief.

Live replaces the tick counter with the current 15-minute ERCOT interval in Central time, and the mast clock is the wall clock. As of is the last successful pull, and it stays that time if a later pull fails. The 01–12 scrubber and the tape scenes (Fail-safe, High risk, 15% offline) are not on the page. The bottom chart is the interval strip, and it does not fall back to ticks 01–12. Hold and Auto do not jump to a tape tick. Header tiles bind to the snapshot in `docs/agents/wall-snapshot.md`. Quality is the feed health (Live, Degraded, Stale, Auth error), never Demo data, Unchecked, or "layout fixture". The rail brief does not use the fixture sentence, and the rail stamp does not name a tape index. Radar stays.

## How the mode is chosen

Live is the default when `VITE_ERCOT_SUBSCRIPTION_KEY` and `VITE_ERCOT_ID_TOKEN` are both set and the first pull has not failed. While that pull is in flight the scrubber stays hidden. If there are no credentials, or the first pull fails, the wall falls back to Demo. After one good pull, a later failure stays on Live and keeps that as-of. Choosing Demo keeps the tape even when the pull is healthy. Live cannot be chosen when the first pull has already failed.

## Code

- `web/src/runtimeMode.ts`: `resolveRuntimeMode`, `ercotIntervalLabel`, `readingForMode`, `liveBrief`
- `web/src/liveStamp.ts`: `rememberLive`, `viewTick`. A failed pull does not clear `lastOk`.
- The scrubber is `TapeScrubber` in `web/src/components/organisms/ControlBar.tsx`. It renders only in Demo. Live renders `IntervalStrip`.
