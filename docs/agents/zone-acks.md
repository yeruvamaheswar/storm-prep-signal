# Zone supervisor acks (rollup until devices exist)

**Decision (2026-09-26).** There is no per-home device command API on this branch. After `allocate`, `simulate_zone_acks` rolls command outcomes in-process and writes `TickResult.zone_acks`. The snapshot passes that field through. The wall AckRail binds those counts as one stacked bar per zone. It does not paint `index % 4` over 100 spans.

## What this is not

The other branch's `orchestration.run_cycle` fans `Command` objects through a lossy `Channel` to a `HomeWorker` per home, retries at 60 s, and closes at 120 s. That path is not hardware either, and we did not copy it. `discharge` still applies the allocation. Unconfirmed homes are a rollup status; they do not rewrite `delivered_mw`.

## Contract

`zone_acks` is add-only on `TickResult`. Each zone maps to `{acked, held, silent, dead, unconfirmed}`.

- **acked:** live home, `kw > 0`, send or the one retry arrived
- **held:** live home, no command (0 kW / HOLD)
- **silent:** stale (never commanded)
- **dead:** dead (never commanded)
- **unconfirmed:** live home commanded, both the 0 s send and the 60 s retry dropped

`command_id` is `{home_id}:{tick}`. A retry reuses that id. `HomeWorker.seen` ignores a repeat.

Optional `settings["channel_drop_rate"]` (default 0) drops a send. Seed is `settings["seed"]` (default 1). Virtual deadlines stay `CYCLE_CONFIRM_S = 60` and `CYCLE_CLOSE_S = 120`.

## Code

- `server/engine/supervisor.py`: `Command`, `HomeWorker`, `ZoneSupervisor`, `simulate_zone_acks`
- `server/engine/loop.py` calls it after `allocate`
- `GET /v1/snapshot` copies `zone_acks` with the tick
- `web/src/components/organisms/ackTicks.ts` `zoneAckTotals` prefers `tick.zone_acks`, else `zoneAggregates` so Demo still has four bars
- `AckRail` draws stacked bars

A missing `zone_acks` on an old tape is not invented as devices. The rail falls back to zone aggregates and still draws bars.
