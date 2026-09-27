# Grid flow page

Open `/flow` to watch power move between the grid, the four Texas zones, and 100 home batteries. The engine plays a real stretch of ERCOT history, one 5-minute step at a time.

- Pick a scenario, such as Winter Storm Heather or Hurricane Beryl. The side panel lists the real ERCOT rows being played.
- Each battery starts at a random charge. **Reshuffle** gives a new mix. The seed is shown, so the same seed replays the same run.
- Each battery belongs to a county, and its name says so, for example `Houston-FortBend-005`.
- Send a real, saved National Weather Service alert. On the next step, every county the alert names keeps more backup (60%). Other counties in the same zone stay at 30%. The type of alert does not matter.
- A battery under its backup floor charges back up to it from the grid, at any price. It fills past the floor only in its zone's cheapest hours of ERCOT's day-ahead prices, or at $25/MWh or less when a scenario has none. None ever sells below its backup floor.
- In Beryl you can mark Houston's grid as down. Its batteries then only power their own homes.
- We used to ask an outside model (JEV) whether each alert was dangerous. It said no to the 2021 winter storm, so we removed it on 2026-09-27.

Try it online: open `https://storm-prep-signal.vercel.app/flow`. After 15 quiet minutes the server sleeps, so the first visit can take a minute, and you press Start again.

Try it on your laptop: start the API and the wall, run `python scripts/scenario_session.py`, then open `http://localhost:5173/flow`.

Details: `docs/agents/grid-flow.md`.
