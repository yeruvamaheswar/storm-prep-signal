# Controller-tied 10k fleet: parallel prompts

Launch prompts 1–7 together. They do not share files. The contract below is the shared API; no prompt waits for another to land.

Copy-paste each block into its own agent. Product limits stay in `CONSTRAINTS.md`. Look stays `DESIGN.md`. Do not edit those two files.

There is no ERCOT product in this repo that asks the fleet for a megawatt number. NP3-233-CD is outages. NP6-905-CD is price. The 0.40 MW figure is the demo tape peak (`DEMO_PEAK_MW` in `server/engine/fleet.py`). Live is supposed to scale that peak with `FLEET_SIZE` (`call_target_mw`: 10,000 homes → 40 MW, cap 50). The wall still shows 0.40 beside 10,000 homes because the live tick is the 100-home tape and the map reads `public.homes`.

## Shared contract

**Call.** Demo (`FLEET_SIZE=100`) stays 0.40 MW, `target_label` `synthetic`. The live worker allocates all 10,000 homes. Its call is `call_target_mw` for that fleet (40 MW unless `CALL_TARGET_MW` is set, never above the 50 MW cap). `target_label` stays `synthetic`. Do not add an ERCOT dispatch fetch.

**One fleet.** The homes `orchestrate_tick` plans are the same ids as `public.homes` (`home-001` … from `new_fleet`). Charge state is not random.

| Controller result | `charge_state` | `power_kw` |
|---|---|---|
| confirmed kW > 0 | `DISCHARGING` | that kW, positive |
| confirmed kW < 0 | `CHARGING` | that kW, negative |
| confirmed kW == 0 and `soc_kwh` at capacity | `FULL` | 0 |
| confirmed kW == 0 and `soc_kwh` == 0 | `EMPTY` | 0 |
| otherwise | `HOLDING` | 0 |

`soc_kwh` is the home after the tick. `assigned_kw` is the planned kW. A home with no confirmation is `HOLDING`, power 0, and its command ack is `timeout`. Console ack is `ok` (confirmed) or `timeout` (unconfirmed, late, or missing). Do not invent `rejected`.

**Emit file** `var/fleet/tick_emit.json` (git-ignored, same folder as `homes.json`):

```json
{
  "tick": 1,
  "ts": "2026-09-26T17:00:00-05:00",
  "target_mw": 40.0,
  "target_label": "synthetic",
  "delivered_mw": 40.0,
  "fleet_size": 10000,
  "homes": {
    "home-001": {
      "soc_kwh": 12.4,
      "assigned_kw": 4.0,
      "power_kw": 4.0,
      "charge_state": "DISCHARGING",
      "status": "live",
      "zone": "South",
      "last_seen": "2026-09-26T22:00:00+00:00",
      "command": {
        "command_id": "home-001:1",
        "kw": 4.0,
        "actual_kw": 4.0,
        "ack": "ok",
        "sent_at": "2026-09-26T22:00:00+00:00"
      }
    }
  }
}
```

`command` is null when the tick sent nothing. The engine never imports Supabase.

**History tables.** `public.homes` stays one current row per home. Append one reading and one command per home per tick. Do not write a row on a timer that has no new tick.

`public.home_readings`: `id` bigint generated always as identity primary key, `home_id` text not null, `tick` int, `seen_at` timestamptz not null, `soc_kwh` numeric not null, `charge_state` text, `power_kw` numeric, `boot_id` text, `seq` int. Unique `(home_id, tick)`. Index `(home_id, seen_at desc)`.

`public.home_commands`: `command_id` text primary key, `home_id` text not null, `tick` int, `kw` numeric not null, `actual_kw` numeric, `ack` text check (`ok` or `timeout`), `sent_at` timestamptz, `parent_command_id` text. Index `(home_id, sent_at desc)`.

No foreign key to `public.homes` (the seed and the first history write must not order each other). Service role can insert. Replica identity is not required.

**History route.** `GET /v1/homes/{home_id}/history?limit=` default 48, max 200. Oldest first.

```json
{
  "home_id": "home-001",
  "readings": [
    {"tick": 1, "seen_at": "2026-09-26T22:00:00+00:00", "soc_kwh": 12.4, "charge_state": "DISCHARGING", "power_kw": 4.0}
  ],
  "commands": [
    {"command_id": "home-001:1", "tick": 1, "kw": 4.0, "actual_kw": 4.0, "ack": "ok", "sent_at": "2026-09-26T22:00:00+00:00"}
  ]
}
```

`GET /v1/homes/{home_id}` `last_command` is `{kw, sent_at, ack}` from the newest command. Missing history is `last_command: null` and empty arrays, not a fake HOLDING series.

## Shared rules

- Do not edit files outside your list. If you need a file you do not own, stop and name it.
- Do not add a dependency. No chart library.
- `allocate` stays pure. The engine never imports Supabase during a tick.
- Fields on `Home`, `TickResult`, and `/v1` shapes are add-only. Do not rename or remove.
- Demo tape stays 100 homes / 0.40 MW.
- `pytest -q` (and `npx vitest run` / `npx tsc --noEmit` when you touch `web/`) before you stop.
- Do not edit `docs/agents/progress.md`. One line in the PR body is enough. Only prompt 3 updates `docs/agents/code-flow.md`, and only because it adds a module.

## Prompt 1 — History tables

```markdown
**[Enhancement] Add Append-Only Battery Reading And Command Tables**: `public.homes` is one current row per battery. `docs/agents/persist-telemetry.md` says there is no history table, and `docs/agents/fleet-telemetry.md` lists history as out of scope, so a restart keeps only the last upsert and the home page cannot show how charge moved or which orders arrived. Add `public.home_readings` and `public.home_commands` exactly as the shared contract in `docs/agents/plans/fleet-controller-prompts.md`: one reading and one command per home per tick, unique `(home_id, tick)` on readings, `command_id` primary key on commands, ack limited to `ok` and `timeout`, indexes on `(home_id, seen_at desc)` and `(home_id, sent_at desc)`, no foreign key, service role insert, no RLS that blocks that role. Leave `public.homes` and `supabase/migrations/20260926_homes.sql` unchanged. Own only `supabase/migrations/20260926_home_history.sql`. Research `supabase/migrations/20260926_homes.sql`, `docs/agents/plans/fleet-persist-prompts.md`, and `docs/agents/persist-telemetry.md` before writing SQL.
```

## Prompt 2 — Live call is the 10k fleet

```markdown
**[Bug] Run The Live Tick On All 10k Homes At The Fleet Call**: Live ERCOT price, outage, floor, and risk are real, but `scripts/live_cycle.py` `one_live_frame` always builds a 0.40 MW frame with `target_label` `synthetic`, and `read_settings()` still has `FLEET_SIZE=100`. `loop.run` then keeps that 0.40 because `scale_target_mw` is an identity at 100 homes. The wall caption still says the call is 0.40 MW from 10,000 homes, because `GET /v1/fleet/rollups` reads `public.homes` (seeded at 10,000) while TARGET and DELIVERED read that 100-home tick. The live worker must allocate the same 10,000 ids as `new_fleet(10000)`, and the call must be `call_target_mw` for that fleet (40 MW unless `CALL_TARGET_MW` is set, capped at 50). Demo stays 100 homes and 0.40 MW; do not change `.env.example` `FLEET_SIZE`. `build_snapshot` must size the tick from the run's own `settings.fleet_size`, not from a 100-home env that would shrink a 10k tick back to 0.40. `target_label` stays `synthetic`. Do not fetch a new ERCOT product. Own only `scripts/live_cycle.py`, the fleet-size argument inside `build_snapshot` in `server/api/snapshot.py`, `tests/test_live_cycle.py`, and `tests/test_snapshot.py`. Research `scripts/live_cycle.py` `one_live_frame`, `server/engine/fleet.py` `call_target_mw` and `scale_target_mw`, `server/engine/loop.py` where it scales the frame, `server/api/snapshot.py` `scale_tick_to_fleet`, `docs/agents/live-ingest.md`, and `docs/agents/fleet-rollups.md` before editing.
```

## Prompt 3 — Emit controller results

```markdown
**[Enhancement] Write Each Tick's Per-Home Commands And Charge State**: `orchestrate_tick` plans, sends, and confirms orders in memory, then `persist_discharged_homes` writes `var/fleet/homes.json` with `soc_kwh` and status only. It does not record `assigned_kw`, confirmed kW, ack, or a charge state. `server/engine/telemetry.py` can label a reading `DISCHARGING` when power is positive, but the live 10k path never runs that feed, so nothing on disk can tell a writer which batteries the controller actually moved. After each tick, write `var/fleet/tick_emit.json` in the shape in `docs/agents/plans/fleet-controller-prompts.md`. Charge state and power come only from confirmed kW (positive discharge, negative charge, zero holding, full or empty only at the rails). Ack is `ok` or `timeout`. `command` is null when the tick sent no order. The file is the whole fleet for that tick, including homes left at 0 kW. The engine still does not import Supabase. Own only `server/engine/tick_emit.py` (new, pure), the call that writes the file at the end of each tick in `server/engine/loop.py`, `tests/test_tick_emit.py`, and the module-and-diagram update in `docs/agents/code-flow.md`. Research `server/engine/loop.py` (the `orchestrate_tick` call and `persist_discharged_homes`), `server/engine/orchestration.py` `CycleResult` events and `command_states`, `server/engine/contracts.py` `Allocation.per_home_kw`, and `docs/agents/epic-3-controller.md` before editing.
```

## Prompt 4 — Telemetry follows the controller

```markdown
**[Bug] Stop Random Charge States And Upsert The Controller Tick**: `scripts/stream_telemetry.py` builds the 10k fleet with `new_fleet`, then `pick_state` rolls HOLDING 70%, DISCHARGING 15%, CHARGING 10%, FULL 3%, EMPTY 2%, and `power_for` / `soc_for` invent kilowatts and charge. That pulse merge-upserts `public.homes` and never reads `allocate`, `orchestrate_tick`, or `assigned_kw`. The fleet list therefore shows discharge on batteries the controller did not call, and `assigned_kw` stays at the seed value because the script omits it. Replace that roll with a read of `var/fleet/tick_emit.json`. Upsert current `soc_kwh`, `assigned_kw`, `charge_state`, `power_kw`, and `last_seen` onto `public.homes`, and append one `home_readings` row and one `home_commands` row per home for that tick. Skip a tick already written (same `tick` and `fleet_size`). If the emit file is missing, print `telemetry_skipped: no_controller` and exit 0; do not invent a charge state. `--loop` waits until the file changes instead of rolling a new random mix every 15 seconds. `--dry-run` counts rows and sends nothing. The engine never imports this module. Own only `scripts/stream_telemetry.py` and `tests/test_stream_telemetry.py`. Research `scripts/stream_telemetry.py` `pick_state`, `scripts/persist_telemetry.py` `row_from_last` and `send()`, `docs/agents/persist-telemetry.md`, and the emit shape in `docs/agents/plans/fleet-controller-prompts.md` before editing.
```

## Prompt 5 — History API and last command

```markdown
**[Enhancement] Serve Per-Home Command History And Fill Last Command**: `server/api/homes.py` `as_console_home` sets `last_command` to `None` on every row, and `HOME_SELECT` never reads a command. `GET /v1/homes/{home_id}` can show capacity and the last charge number, which is why the home page says "Last command: none" even after a tick. Add `GET /v1/homes/{home_id}/history?limit=` (default 48, max 200, oldest first) returning `readings` and `commands` in the shape in `docs/agents/plans/fleet-controller-prompts.md`. Fill `last_command` on the single-home payload from the newest command (`kw`, `sent_at`, `ack`). A missing table or missing config returns empty arrays and `last_command: null`, not a 500 and not a synthetic HOLDING row. Do not return 10,000 history rows. List paging stays as it is. Own only `server/api/homes.py`, the new route next to `get_home` in `server/api/v1.py`, and `tests/test_homes_api.py`. Research `server/api/homes.py` `as_console_home`, `server/api/v1.py` `get_home`, `web/src/domain/types.ts` `HomeCommand`, and `docs/agents/fleet-telemetry.md` before editing.
```

## Prompt 6 — Wall call matches the tick fleet

```markdown
**[Bug] Keep The 0.40 MW Call Off The 10k Map Caption**: The banner is `callCaption` in `web/src/format.ts`, and `FleetBoard` passes `liveHomes` from zone aggregates. Those aggregates prefer `GET /v1/fleet/rollups` when `rollups.n` is larger than the tick's ack totals (`zoneAckTotals` in `web/src/components/organisms/ackTicks.ts`). A 10,000-row rollup therefore produces "ERCOT call 0.40 MW (synthetic) · supplying 0.40 MW from 10000 homes" while TARGET and DELIVERED are still the 100-home tick. The caption's home count must be the fleet that tick allocated (`live_homes + stale_homes + dead_homes`). Use the rollup count only when it equals that total. The map may keep sampling 10k dots. Demo copy for a real 100-home tick stays "from 100 homes" at 0.40 MW. Do not allocate, scale, or fetch. Own only `web/src/format.ts`, `web/src/components/organisms/FleetBoard.tsx`, and `web/tests/format.test.ts`. Research `web/src/format.ts` `callCaption`, `web/src/components/organisms/FleetBoard.tsx` where it computes `liveHomes`, `web/src/fleetAggregate.ts` `zoneAggregates`, and `docs/agents/fleet-intent.md` before editing.
```

## Prompt 7 — Charge graph and command list

```markdown
**[Enhancement] Graph Charge And List Controller Commands On The Home Page**: `/fleet/{home_id}` (`web/src/features/fleet/HomePage.tsx`) shows one `soc_kwh` number and a last-command block that renders "none" whenever `last_command` is null. There is no series, so an operator cannot see charge fall after a discharge order or sit still while the controller held the home. Fetch `GET /v1/homes/{home_id}/history` and draw `soc_kwh` against `seen_at` as an inline SVG polyline on the paper field: ink line, hairline floor, muted axis labels, IBM Plex Sans, no chart library, no new dependency, no shadow, no gradient. An empty history shows an em dash, not a fake curve. Under the graph, list the commands in that payload (kW, ack, sent time), newest at the bottom of the same list the graph uses so the two stay aligned. Add the client method and add-only parse types for the history body. Own only `web/src/features/fleet/HomePage.tsx`, a new `web/src/features/fleet/ChargeHistory.tsx`, `web/src/api/client.ts` (the history method only), `web/src/domain/types.ts` and `web/src/domain/parse.ts` (add-only history types), and the fleet tests you add under `web/tests/`. Research `DESIGN.md`, `web/src/features/fleet/HomePage.tsx`, `web/src/domain/types.ts` `HomeCommand` and `ChargeState`, `web/src/api/client.ts`, and `docs/agents/fleet-telemetry.md` before editing.
```
