# Live worker (laptop)

On Live, the wall reads the newest ERCOT posting from Supabase and the last engine tick from `var/runs/latest.json`. A small script on this laptop keeps both fresh.

**Once per cycle it:**

1. Pulls NP3-233-CD and NP6-905-CD from ERCOT.
2. Writes those rows into `ercot_postings` and `ercot_prices` with `event=live`. Older storm weeks stay.
3. Runs one allocate tick and saves `latest.json`. Hold on the wall writes `var/state.json`; that tick delivers 0 with `operator_hold`. Auto is what splits the 0.40 MW call.

**Run it**

Put ERCOT and Supabase names in `server/.env`. In one terminal:

```bash
python scripts/live_cycle.py --loop
```

Leave that running. In another terminal start the API (`uvicorn server.app:app --reload`) and open the wall on Live. One cycle without the loop: `python scripts/live_cycle.py`. `--dry-run` fetches and allocates but does not write to Supabase.

If the keys or the network fail, the local tick file is still written. A missing posting on Live holds the 60% floor.

More: `docs/agents/live-ingest.md`.
