# Live and Demo

The wall has two modes. They do not share numbers.

**Demo** plays the 12-tick practice tape at 100 homes and 0.40 MW unless a storm week is selected. Clicking Demo (or `?mode=demo` without `?event=none`) defaults to Beryl. Then the mast says ARCHIVE, the clock is pinned, and risk, floor, and price follow that week's postings instead of the tape numbers. `?event=none` keeps the tape. Heather and tuning-2026 work the same way when those folders have a replay file.

**Live** reads the engine snapshot every 20 seconds. The mast says LIVE.

**Archive** is still that snapshot poll, with a pinned storm-week clock. The mast says ARCHIVE and the event name.

Open with `?mode=demo` or `?mode=live`, or set `VITE_DEFAULT_MODE`. If Live cannot pull, the wall falls back to Demo and Quality names the failed pull.

More: `docs/agents/runtime-mode.md`.
