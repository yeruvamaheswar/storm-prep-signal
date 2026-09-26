# Zone supervisor acks

**Decision (2026-09-26, updated).** The tick loop runs every tick through `orchestration.orchestrate_tick`: orders go through a lossy simulated `Channel` to a `HomeWorker` per home, retry at 60 s, and the books close at 120 s. `orchestration.zone_acks(homes, cycle)` writes `TickResult.zone_acks`. The snapshot passes that field through. The wall AckRail binds those counts as one stacked bar per zone. It does not paint `index % 4` over 100 spans. There is still no per-home device command API; the channel and workers are a simulation, not hardware.

Delivered MW is confirmed MW. An order we never heard back on is unconfirmed and is not counted in `delivered_mw` or `zone_delivered_mw`.

## Contract

`zone_acks` is add-only on `TickResult`. Each zone maps to `{acked, held, silent, dead, unconfirmed}`. Status is read at the end of the tick.

- **acked:** live home with a confirmed command (its own, or work reassigned to it)
- **held:** live home, no command (0 kW / HOLD)
- **silent:** stale
- **dead:** dead, including a home whose worker crashed during the tick
- **unconfirmed:** live home we sent a command to and never heard back from by 120 s

`command_id` is `{home_id}:{tick}`; a retry reuses it; a reassignment is `{home_id}:{tick}:r`. A worker ignores a repeat id.

Channel faults come from settings (`channel_drop_rate`, `channel_dup_rate`, `channel_late_rate`; default 0). The seed per tick is `settings["seed"]` (default 1) × 100 000 + tick, so a run replays exactly.

## Code

- `server/engine/orchestration.py`: `orchestrate_tick`, `zone_acks`, `ACK_KEYS`. Detail: `docs/agents/epic-3-controller.md`
- `server/engine/loop.py` calls both each tick
- `server/engine/supervisor.py`: the earlier in-process rollup (`simulate_zone_acks`). No longer called by the engine
- `GET /v1/snapshot` copies `zone_acks` with the tick
- `web/src/components/organisms/ackTicks.ts` `zoneAckTotals` prefers `tick.zone_acks`, else `zoneAggregates` so Demo still has four bars
- `AckRail` draws stacked bars

A missing `zone_acks` on an old tape is not invented as devices. The rail falls back to zone aggregates and still draws bars.
