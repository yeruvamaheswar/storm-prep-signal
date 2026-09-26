# The backend

We now have a small web server in `server/`. It uses FastAPI.

It answers the same questions the operator wall asks. `GET /v1/meta` says Live or Demo, fleet size, the last run's source (`live`, `archive`, or `fixture`), the event (`beryl`, `heather`, `tuning-2026`, or none), and whether the clock is the wall, a pinned archive posting, or the fixture. The demo tape stays 100 homes and 0.40 MW. Live uses the real fleet size (10,000 homes cap at 50 MW). `GET /v1/snapshot` is the tick the wall polls every 20 seconds in Live (ERCOT login stays on this server). Demo with `?event=` pins that week's posting so risk, floor, and price are not the 12-tick tape. Demo and Synthetic without an event look up the saved posting and North price for the tape clock instead. Archive risk still uses the same storm rule as Live, not a fixed 22,348 MW line. The Live brief is written from the tick's reason codes, not the demo-tape sentence. That tick now includes `feeds[]` for NP3-233-CD and NP6-905-CD so Quality can show each product. A failed outage pull holds spare energy (`signal_unavailable`). A failed pull does not keep tape 185. The wall then falls back to Demo and Quality names the failed pull. When the last engine tick has `zone_acks`, that field is on the snapshot too. `GET /v1/live/stream` sends the same facts as named events (`tick`, `feeds`, `attention`, and a `home` count rollup — not thousands of homes). `GET /v1/runs/latest` is the last engine run file. The Supabase `runs` table can be empty; that does not clear the wall. The demo tape is the last fallback. `GET /v1/fleet/rollups` is the zone counts. The other `/v1` answers still come from sample files.

It never decides how much a home sells or what the reserve floor is. The engine in `server/engine/` still does that. Live Hold and Auto write `var/state.json`. The next tick delivers 0 on Hold.

**Run it on your laptop**

```bash
pip install -r requirements.txt
uvicorn server.app:app --reload
```

Then open http://localhost:8000/docs to try each call. For a live snapshot, keep the ERCOT names in `server/.env` (the API loads them, then the process env). Without them, `/v1/feeds/outage` returns quality `auth` and `/v1/snapshot` still answers with the demo tape. `/v1/feeds` is the product list for the Feeds chips.

**Put it online.** In Render, choose New, then Blueprint, and pick this repo. Render reads `render.yaml`.

More detail for agents: `docs/agents/backend.md`.
