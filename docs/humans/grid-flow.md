# Grid flow page

Open `/flow` to watch power move between the grid, the four Texas zones, and 100 home batteries. The engine plays a real stretch of ERCOT history, one 5-minute step at a time.

- Pick a scenario, such as Winter Storm Heather or Hurricane Beryl. The side panel lists the real ERCOT rows being played.
- Each battery starts at a random charge. **Reshuffle** gives a new mix. The seed is shown, so the same seed replays the same run.
- Each battery belongs to a county, and its name says so, for example `Houston-FortBend-005`.
- Send a real, saved National Weather Service alert. JEV was asked once, ahead of time, whether it threatens power in each county it names. On the next step, a county where JEV said yes, or gave no answer, keeps more backup (60%). A county where JEV said no stays at 30%.
- A battery under its backup floor charges back up to it from the grid, at any price. It fills past the floor only when power is cheap. None ever sells below its backup floor.
- In Beryl you can mark Houston's grid as down. Its batteries then only power their own homes.
- Today only Beryl raises backup, and only in Harris County. JEV said no everywhere in the Heather and Midland alerts.

Try it online: open `https://storm-prep-signal.vercel.app/flow`. After 15 quiet minutes the server sleeps, so the first visit can take a minute, and you press Start again.

Try it on your laptop: start the API and the wall, run `python scripts/scenario_session.py`, then open `http://localhost:5173/flow`.

Details: `docs/agents/grid-flow.md`.
