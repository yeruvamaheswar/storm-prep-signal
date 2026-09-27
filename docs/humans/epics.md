# What is left to build

We still work one gap at a time (`docs/humans/gap-work.md`). This page groups those gaps into nine big areas, so you can see the whole picture. The order is not a queue. Details and checks: `docs/agents/epics.md`.

## Done

- The storm rule reads real ERCOT outage data and raises the backup floor.
- The fleet splits a target without draining any home below its floor. 50 random runs, 0 breaches.
- The wall shows Live, Demo, and saved storm weeks. Hold and Auto work.
- Batteries charge when power is cheap and never fill past full. The `/flow` page shows it (`docs/humans/grid-flow.md`).

## Left to do

1. **Wait for two calm readings.** Only the wall counts them today. The engine must count them too before it sells again.
2. **Ask a person when data is bad.** Approve, retry once, or skip. The buttons exist, but the engine never asks.
3. **Keep score.** Show delivered versus target, money, and breaches for the whole run.
4. **Count only confirmed power.** The engine should use the code that handles slow and silent homes.
5. **Catch a real storm.** Our rule missed Hurricane Beryl. On `/flow` you can now send the real Beryl alert and Houston keeps more backup. The main engine still needs its own alert feed.
6. **Show real numbers everywhere.** Some screens still show sample data.
7. **Charging.** Done.
8. **Run the demo with no wifi.** Add one laptop command that plays a saved storm.
9. **Ship.** Put it online, write the README with our honest limits, and record the video.
