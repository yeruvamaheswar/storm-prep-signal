# Live worker

On Live, the wall reads the newest ERCOT posting from Supabase and the last engine tick from `var/runs/latest.json`. A small script keeps both fresh. Since PR #60 it runs on Render, in the same service as the API.

**Once per cycle it:**

1. Pulls NP3-233-CD and NP6-905-CD from ERCOT.
2. Writes those rows into `ercot_postings` and `ercot_prices` with `event=live`. Older storm weeks stay.
3. Reads Hold or Auto from the `operator_settings` row, runs one allocate tick, and saves `latest.json`. Hold delivers 0 with `operator_hold`. Auto is what splits the call.

If one cycle hits an error, the worker logs it and tries again next cycle.

**The free plan sleeps, so we ping it.** Render's free plan puts the service to sleep after about 15 minutes with no visitors. While asleep, no ticks run, and the Live page says the worker looks stopped or asleep. On wake, the local files (last tick, fleet charge, day-ahead cache) are gone. A GitHub job now visits the service every 10 minutes to keep it awake. GitHub can run that job late, so a short nap can still happen.

**Run it on a laptop**

Put ERCOT and Supabase names in `server/.env`, then run `python scripts/live_cycle.py --loop` beside the API (`uvicorn server.app:app --reload`). `--dry-run` fetches and allocates but writes nothing to Supabase.

More: `docs/agents/live-ingest.md`.
