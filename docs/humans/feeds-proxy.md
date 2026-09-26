# Live grid data stays on the server

The wall no longer logs into ERCOT. Python does that.

Two reads drive the floor and the price: outages (`/v1/feeds/outage`) and price (`/v1/feeds/price`). Live logs into ERCOT. Demo and Synthetic read the saved archive for the tape clock. `GET /v1/feeds` is the product list: the newest saved posting for each report in the selected storm, plus whether the live files on disk are good. Username, password, and the subscription key stay in `server/.env` on the API box. The browser never gets the login token. Each answer may include the last HTTP status, with no secrets.

The Feeds panel shows those saved reports as small chips (zip vs API). Only the outage report and the LZ_NORTH price move the floor and the price this pass.

If ERCOT says the login is wrong, Quality shows an auth error. If ERCOT is busy or down, we keep the last good file for a while (90 minutes for outages, 30 minutes for price). Older than that is stale.

More detail: `docs/agents/feeds-proxy.md`.
