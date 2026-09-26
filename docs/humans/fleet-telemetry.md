# Last reading on the fleet list

The fleet page now shows what each battery last reported: charge state, power, and last seen. It still loads one page at a time, not every home.

A dash means nothing has streamed for that home yet. To fill the columns, run `python scripts/stream_telemetry.py` (or `--loop` to keep them moving). The data is synthetic but looks like a real fleet: most homes hold, some charge or discharge, a few go quiet. The wall map is unchanged.

Detail: `docs/agents/fleet-telemetry.md`.
