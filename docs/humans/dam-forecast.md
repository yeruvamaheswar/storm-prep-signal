# Next 24 h price panel

On the Live wall, under the interval chart, the panel "Next 24 h price (ERCOT DAM, $/MWh)" shows what power will cost in each Texas load zone over the next 24 hours. ERCOT sets these day-ahead prices the afternoon before.

How to read it:

- One row per zone. Each bar is one hour. A taller bar is a higher price.
- Dark bars are the hours that zone picked to charge in. They are its cheapest hours, and it picks as many as it needs to fill up.
- The outlined bar is the current hour.
- The thin line marks the zone's highest price.
- The line under each row says what the zone is doing and why: charging now, charging before a price spike, waiting for a cheaper hour, or not charging because no later hour pays back the energy lost in the battery.

If the panel is missing, we have no current day-ahead prices, and batteries charge at $25/MWh or less, as before.

Details: `docs/agents/dam-forecast.md`.
