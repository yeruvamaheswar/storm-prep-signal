# Grid flow page

Open `/flow` to watch power move between the grid, the four Texas zones, and 100 home batteries. The engine plays a real stretch of ERCOT history, one 5-minute step at a time.

- Pick a scenario, such as Winter Storm Heather or Hurricane Beryl. The side panel lists the real ERCOT rows being played.
- Each battery starts at a random charge. **Reshuffle** gives a new mix. The seed is shown, so the same seed replays the same run.
- Send a real, saved National Weather Service alert. On the next step, that zone keeps more backup and sells less.
- Batteries refill only when power is cheap. None ever sells below its backup floor.
- In Beryl you can mark Houston's grid as down. Its batteries then only power their own homes.
- JEV gives a second opinion on each alert. It never makes a decision.

Try it: start the API and the wall, run `python scripts/scenario_session.py`, then open `http://localhost:5173/flow`.

Details: `docs/agents/grid-flow.md`.
