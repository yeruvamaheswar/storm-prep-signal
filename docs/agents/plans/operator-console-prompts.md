# Operator console: parallel prompts

Launch prompts 1–4 together. They do not share files. Launch prompt 5 only after those four are in the tree. Prompt 5 is the only one that imports the others.

The product contract is `docs/agents/plans/operator-console.md`. Look is `DESIGN.md`. Do not edit either file.

Shared rules for every prompt:

- Do not edit files outside your list. If you need a file you do not own, stop and name it.
- Do not add a dependency. Prompt 1 is the only prompt that edits `web/package.json`.
- The UI does not decide reserve, allocation, or data quality. It shows what the server sent and sends operator intent.
- No path turns a bad reading into normal selling. Approve, retry, and skip do not resume selling.
- `RESERVE` is the safety stop. `HOLD` is the operator stop. Both deliver 0. The label says which.
- Playback is never the default. Live never loads a tape by itself.

## Prompt 1 — Domain, client, CI, and tests

```
Read docs/agents/plans/operator-console.md and DESIGN.md. Do not edit them.

You own only:
- web/package.json
- web/package-lock.json
- web/vite.config.ts
- web/tsconfig.json
- web/vitest.config.ts
- web/src/domain/**
- web/src/api/**
- web/src/fixtures/console/**
- web/tests/**
- .github/workflows/ci.yml

Do not edit web/src/components, web/src/pages, web/src/main.tsx, web/src/features, or any HTML file.

Build the typed core the console will share, and a CI pipeline that proves it.

Public surface other agents will import. Do not rename these.

- web/src/domain/types.ts — Zone, Tick, Home, Tape, Playback, Attention, Quality, Mode, and the nested target, price, reserve, stress, and fleet objects from the plan. mode is AUTO, HOLD, or RESERVE. quality is ok, timeout, http, bad_payload, missing_field, impossible_value, or stale. home status is live, stale, dead, or unconfirmed.
- web/src/domain/parse.ts — parseZone, parseTick, parseHome, parseTape, parsePlayback. Unknown enums throw. parseTick rejects a tick whose missed_mw is more than 0.001 away from target.mw - delivered_mw, or whose breaches is missing. parsePlayback accepts null.
- web/src/domain/attention.ts — remainingChoices(attention) returns the plan's choices. When retry_spent is true, retry is absent.
- web/src/domain/age.ts — oldestAsOf(tick) returns the earliest as_of among target, price, and stress, or null if one is missing.
- web/src/api/client.ts — createClient({ fetch, baseUrl, operatorId }). Reads: zone, live, homes(status?), home(id), ticks({ from, to }), tick(id), tapes, playback. Writes send header X-Operator-Id: mode(HOLD|AUTO), attention(id, approve|retry|skip), startPlayback(tapeId), stopPlayback(). A 409 body { error, brief } throws an error whose message is brief. liveStream(onEvent) reads GET /v1/live/stream as SSE events named tick, attention, and home. If the stream errors, the caller is told. The client does not keep showing the last tick as current.

Fixtures in web/src/fixtures/console/, each valid for the parsers:
- live-ok.json — AUTO, source live, delivering under the target from surplus, quality ok, calm_streak 2, attention null
- stress-reserve.json — RESERVE, stress HIGH, delivered 0, reason stress_high
- bad-feed.json — RESERVE, quality timeout, attention with retry available, input stress
- retry-spent.json — same attention with retry_spent true
- playback.json — source playback, tape_id set
- homes.json — one live home above the floor with assigned_kw, one unconfirmed home with ack timeout and skip_reason unconfirmed, one dead home
- tapes.json — one synthetic tape
- playback-state.json and playback-off.json — the running object, and null

Add web scripts "test": "vitest run" and "typecheck": "tsc --noEmit". Add vitest and jsdom as devDependencies. Do not add a UI kit or react-router. Dev server must keep serving any extra HTML file at the web root without listing it, so other agents can add wall.html, fleet.html, and history.html.

CI file .github/workflows/ci.yml runs on push and pull_request.
- Python job: checkout, Python 3.12, pip install -r requirements.txt, pytest -q from the repo root.
- Web job: checkout, Node 22, npm ci in web/, npm test, npm run typecheck.
Both jobs must pass.

Tests in web/tests only:
- Each fixture parses, and playback-off parses as null.
- A tick with a bad quality string, a bad mode, or a missed_mw that is not target minus delivered is rejected.
- remainingChoices drops retry after retry_spent.
- oldestAsOf picks the earliest stamp.
- createClient sends X-Operator-Id on POST /v1/fleet/mode and POST /v1/attention/{id}.
- A 409 resolves to the brief string.
- An SSE frame "event: tick" plus data yields a parsed tick to the callback.
- Do not snapshot React components. Do not import web/src/features or web/src/components.

End state:
- npm test and npm run typecheck pass in web/.
- pytest -q still passes at the repo root.
- The workflow file exists and runs those three commands.
- No page, route, or visual component was added.
```

## Prompt 2 — Wall

```
Read docs/agents/plans/operator-console.md (the Wall section and the Tick contract) and DESIGN.md. Do not edit them.

You own only:
- web/src/features/wall/**
- web/wall.html

Do not edit package.json, vite config, workflows, web/src/domain, web/src/api, web/src/pages, web/src/main.tsx, web/src/components, or any other feature folder.

Build the shift screen as a presentational React page. It takes data through props. It does not fetch, and it does not import web/src/domain. Put the prop types in web/src/features/wall/types.ts, matching the Tick, Zone, and Home objects in the plan.

Export WallPage from web/src/features/wall/WallPage.tsx with props:
- zone
- tick
- recentTicks (target and delivered for the strip)
- homes (id and status only, for the squares)
- onMode(mode: "HOLD" | "AUTO")
- onAttention(choice: "approve" | "retry" | "skip")
- onOpenHome(homeId)

The page shows every Wall region in the plan: mast, money, safety, stress, quality, fleet squares, brief, reasons, attention, hold/auto, and the recent-tick strip. Each MW and $/MWh shows its source and as_of. RESERVE and HOLD are labeled as the safety stop and the operator stop. Attention renders only when tick.attention is set. Its copy says selling does not resume from these actions. Hide Retry when retry_spent is true. Hold and Auto are disabled when tick.source is playback. Squares call onOpenHome. There is no per-home dispatch control.

Style only in web/src/features/wall/wall.css. Prefix classes with wall-. Obey DESIGN.md: IBM Plex Sans is already loaded by the app, paper field, ink type, hairline separators, 2px controls, no shadow, no gradient, no dark page, no card grid.

web/wall.html and web/src/features/wall/main.tsx mount WallPage with preview data in web/src/features/wall/preview-data.ts covering three states a reviewer can switch: a normal delivering tick, a stress RESERVE tick, and a timeout attention with retry available. Preview buttons only switch that local state. They are not part of WallPage.

End state:
- npm run dev in web/, then open http://localhost:5173/wall.html
- The three preview states are visible without a tour: surplus delivery, stress stop, and the attention choice.
- Hold, Auto, Approve, Retry, and Skip call the props and do not change mode by themselves.
- No file outside your list was edited.
```

## Prompt 3 — Fleet and home

```
Read docs/agents/plans/operator-console.md (the /fleet sections and the Home contract) and DESIGN.md. Do not edit them.

You own only:
- web/src/features/fleet/**
- web/fleet.html

Do not edit package.json, vite config, workflows, web/src/domain, web/src/api, web/src/pages, web/src/main.tsx, web/src/components, or any other feature folder.

Build two presentational pages. They do not fetch and do not import web/src/domain. Put prop types in web/src/features/fleet/types.ts, matching the Home object in the plan.

Export FleetPage from web/src/features/fleet/FleetPage.tsx with props:
- homes
- statusFilter: "all" | "live" | "stale" | "dead" | "unconfirmed"
- onFilter(status)
- onOpenHome(homeId)

It is a list, not a map. Columns: home id, status, state of charge, floor, kilowatts assigned this tick, last seen, last ack. The filter changes which rows are passed in; the page also shows the active filter.

Export HomePage from web/src/features/fleet/HomePage.tsx with props:
- home
- onBack()

Read-only. Show capacity, charge, floor in kWh, max kW, assigned kW, status, eligible, skip_reason, last seen, last command and its ack. There is no discharge, hold, or mode button.

Style only in web/src/features/fleet/fleet.css with a fleet- prefix. Obey DESIGN.md.

web/fleet.html and web/src/features/fleet/main.tsx preview the list and, when a row is chosen, the home page, using web/src/features/fleet/preview-data.ts. Include one live home above the floor, one below the floor, one stale, one dead, and one unconfirmed with ack timeout.

End state:
- npm run dev in web/, then open http://localhost:5173/fleet.html
- Filtering to unconfirmed shows only that home.
- Opening it shows the timeout ack and skip_reason, and no control that could dispatch the battery.
- No file outside your list was edited.
```

## Prompt 4 — Playback and log

```
Read docs/agents/plans/operator-console.md (the /playback and /log sections, plus Tape and Playback contracts) and DESIGN.md. Do not edit them.

You own only:
- web/src/features/history/**
- web/history.html

Do not edit package.json, vite config, workflows, web/src/domain, web/src/api, web/src/pages, web/src/main.tsx, web/src/components, or any other feature folder.

Build two presentational pages. They do not fetch and do not import web/src/domain. Put prop types in web/src/features/history/types.ts, matching Tape, Playback, and Tick in the plan.

Export PlaybackPage from web/src/features/history/PlaybackPage.tsx with props:
- tapes
- playback (the running object, or null when live)
- onStart(tapeId)
- onStop()

The page lists tapes with title, tick count, and the labeled line. Start is an explicit button per tape. While playback is set, the page says PLAYBACK and the tape id, and Start is disabled. Stop is visible only then. Copy says live data is not a tape, and stopping does not promise the fleet is selling.

Export LogPage from web/src/features/history/LogPage.tsx with props:
- ticks
- selectedTickId
- onSelect(tickId)

Columns: time, mode, target, delivered, missed, price, stress level, quality, breaches, calm streak. A playback tick is marked PLAYBACK in the row. Selecting a row shows that tick's brief and reasons. Live ticks are not marked as playback.

Style only in web/src/features/history/history.css with a history- prefix. Obey DESIGN.md.

web/history.html and web/src/features/history/main.tsx preview both pages from web/src/features/history/preview-data.ts. Include one synthetic tape, a playback-running state, a playback-off state, one live tick, and one playback tick. A local toggle may switch playback on and off. That toggle is preview-only and is not part of PlaybackPage.

End state:
- npm run dev in web/, then open http://localhost:5173/history.html
- Choosing a tape calls onStart. Stop calls onStop. Neither page fetches.
- The log marks the playback tick and shows its brief only after the row is selected.
- No file outside your list was edited.
```

## Prompt 5 — Shell (after 1–4)

```
Read docs/agents/plans/operator-console.md and DESIGN.md. Do not edit them.

Start only after these exist: web/src/domain, web/src/api, web/src/features/wall/WallPage.tsx, web/src/features/fleet/FleetPage.tsx, web/src/features/fleet/HomePage.tsx, web/src/features/history/PlaybackPage.tsx, web/src/features/history/LogPage.tsx.

You own only:
- web/index.html
- web/src/main.tsx
- web/src/app/**
- web/src/index.css
- deletion of the old wall: web/src/components/**, web/src/pages/**, web/src/loadRun.ts, web/src/format.ts, web/src/contracts.ts, web/src/fixtures/layout-run.json
- deletion of the previews: web/wall.html, web/fleet.html, web/history.html, and each feature's main.tsx and preview-data.ts

Do not edit web/package.json, web/src/domain, web/src/api, web/src/features/** except to delete those preview entry files, workflows, or DESIGN.md.

Add react-router only if Prompt 1 already added it. It did not. Use the History API yourself in web/src/app/router.tsx, or use a tiny path switch on window.location and popstate. Do not add a dependency.

Wire one app:
- / renders WallPage
- /fleet renders FleetPage
- /fleet/{homeId} renders HomePage
- /playback renders PlaybackPage
- /log renders LogPage
- A mast link row between those routes, present on every page, showing LIVE or PLAYBACK from the client

Data comes from createClient in web/src/api/client.ts. baseUrl is /v1. operatorId is the query param operator, defaulting to operator-demo. On load, read zone, live, homes, and the last ticks for the strip. Subscribe with liveStream. When the stream errors, poll GET live once and show the tick's quality and ages. Do not freeze the previous tick and label it current.

Bind onMode, onAttention, onStart, and onStop to the client. Show a 409 brief on the page. Do not change local mode ahead of the server. After a write, render the next live tick the server returns. If a write does not return a tick, call live() again.

Map domain types into the feature props. Delete the feature-local preview types' unused exports only if nothing else in that feature still needs the prop types file. Keep features/wall/types.ts, features/fleet/types.ts, and features/history/types.ts.

Until a real /v1 exists, add web/src/app/demoServer.ts and point the client at it only when import.meta.env.VITE_DEMO=1. Document that in a comment at the top of demoServer.ts. The demo server implements the plan's reads and writes in memory, including: bad-feed attention, retry once then retry_spent, stop playback back to a live tick, and a 409 if playback starts twice. This file is the stand-in, not a second product.

web/src/index.css keeps the token import and the font, and drops rules that only belonged to the old wall.

End state:
- VITE_DEMO=1 npm run dev, open http://localhost:5173/?operator=operator-demo
- The wall shows a live tick from the demo server, not the layout fixture.
- Hold and a refresh of the tick agree. Attention retry can be used once.
- /fleet opens a home with no dispatch control.
- /playback starts a tape, every page says PLAYBACK, and Stop returns to a live tick.
- /log marks playback rows.
- npm test and npm run typecheck still pass. pytest -q still passes.
- The old fixture wall is gone.
```
