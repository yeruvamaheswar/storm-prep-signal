# Fleet UI at 10k homes

**Status: approved 2026-09-26. Slice 1 done. Slices 2–5 not started.**

Choices already made: the ack rail is stacked bars at every fleet size (no per-home ticks, even at 100). The map cap is `MAX_VISIBLE_POINTS = 500`. One slice at a time, stop after each.

**Decision.** The wall reads the fleet as load-zone aggregates, never as one element per home. The map draws cluster badges plus a capped sample of dots. The ack rail draws one stacked bar per zone. Home ids appear only in an exception list (silent, dead, nack) and in a virtualized search on `/fleet`. The header, brief, and tick chart stay at tick and zone grain.

## Why

The tick carries only fleet counts: `live_homes`, `stale_homes`, `dead_homes` (`web/src/contracts.ts`). `fleetCells(tick)` expands them into one array entry per home, in contiguous runs `reserved, dead, stale, discharging, ok`. Every view then assigns zone by `index % 4` (`ZONE_ORDER`) and walks the array again.

## Measured (Node, vitest, real `geo/ercot-load-zones.json`, 14–31 vertices per ring)

| Step | 100 homes | 10k homes | Runs |
|---|---|---|---|
| `pickLabelAnchor` over every home dot, 4 zones | 8.7 ms | 464 ms | every tick and every resize (`FleetBoard.drawZoneLabels`) |
| `homeNodes` rejection sampling | 1.8 ms | 38 ms | twice per tick (`homeNodeLayer`, `FleetBoard` label job). Points do not depend on the tick, only status does |
| `zoneOutageSeries` over 12 ticks | 0.7 ms | 7.5 ms | every render of `ControlBar`. Needs outage MW only but calls `zoneFacts`, which calls `fleetCells` |
| `fleetCells` | 0.1 ms | 1.1 ms | many callers per render |
| Ack frame (`ackMarkCounts` + `ackZones`) | 0.2 ms | 1.2 ms | every 100 ms for 3.5 s |

Not measurable in Node, and likely the real freeze:

- `syncHomeMarkers` clears and re-adds one Leaflet SVG `circleMarker` per home per tick. The map has no canvas renderer. `layeradd` runs `noteHomeRole` and `pulseDischarging` per marker.
- `AckRail` re-renders one `<span>` per home 35 times per round (10k spans × 35).
- `pickLabelAnchor` uses `Math.min(...obstacles.map(...))`. The spread throws `RangeError` somewhere past ~100k homes.

## Where the views would lie at 10k

- Ack rail: 2,500 ticks per zone in one row are sub-pixel. The color you see is aliasing, not the ratio.
- Map: 10k 3 px dots overplot. Dead dots are 5 px and drawn last, so dead reads larger than its share.
- Zone split is `index % 4`, so every zone always holds a quarter of the fleet. That is a mock (see `zone-lens.md`), and it stays labeled as one until the tick carries per-zone counts.
- Console wall (`features/wall/WallPage.tsx`) draws one button per home in `wall-squares`. `/fleet` (`features/fleet/FleetPage.tsx`) renders every row, with a status filter and no search. `api/client.ts` `homes()` fetches the whole list.

## Every per-home loop on the main thread

- `fleetCells`, `countState` (`components/organisms/fleetCells.ts`)
- `homeNodes`, `pointInZone` (`homeNodes.ts`)
- `useHomeNodes`, `syncHomeMarkers` (`homeNodeLayer.ts`)
- `clusterGroups`, `clusterCounts`, `pickLabelAnchor` obstacles (`zoneLabels.ts`)
- `drawZoneLabels` obstacles, `FleetLegend` via `countState`, caption via `countState` (`FleetBoard.tsx`, `molecules/FleetLegend.tsx`)
- `ackTicks`, `ackZones`, `ackMarkCounts`, `zoneAcked`, per-home spans (`ackTicks.ts`, `AckRail.tsx`)
- `homesInZone`, and through it `zoneFacts` and `zoneOutageSeries` (`zoneLens.ts`)
- Console: `wall-squares` (`WallPage.tsx`), table rows (`FleetPage.tsx`), `homesFor` filter (`features/fleet/main.tsx`)

## Proposed slices (each near 250 lines, web only)

1. **Done. Aggregates, no visual change.** `fleetCounts(tick)` in `fleetCells.ts` holds the per-state math; `fleetCells` now expands it in `FLEET_RUNS` order. `web/src/fleetAggregate.ts` `zoneAggregates(tick)` returns per zone `homes, reserved, discharging, ok, stale, dead, unconfirmed, supplyingMw` from the closed form of `index % 4` over each run, O(zones). `zoneLens`, `FleetLegend` (now takes `counts`), and the call caption read it. `zoneOutageSeries` reads `zonePaint` directly. `web/tests/fleetAggregate.test.ts` checks it against the per-home walk for every tape tick, both scenes, 10,000 and 10,003 homes. The cluster hover moved to slice 3: South has two metro clusters, so zone totals do not map onto it.
2. **Done. Ack rail as bars.** One stacked bar per zone: acked, held, silent, unconfirmed, dead, fail-safe. Live counts come from `TickResult.zone_acks` (`docs/agents/zone-acks.md`). A tape without that field still uses `zoneAggregates`, not 100 spans. `ackSummary` stays. No per-home DOM.
3. **Map clusters with a cap.** Canvas renderer. Cache coordinates by index once per polygon set. One badge per metro cluster with exact counts. At most `MAX_VISIBLE_POINTS` (proposed 500) sampled dots, split by zone and state with largest remainder. Legend says `1 dot ≈ N homes` when sampled. Labels avoid the visible dots and badges only. Dead is no longer drawn larger.
4. **Exceptions on the wall.** Per-zone counts: silent (stale + unconfirmed), dead, nack. The tape has no ack field, so nack reads "not on tape". The console `WallPage` squares become the same counts plus the first 20 exception rows and a link to `/fleet`.
5. **`/fleet` search and exceptions.** Fixed-height windowed table (no new dependency), `home_id` search, status filter, an Exceptions filter (dead, then `rejected`/`timeout` ack, then silent; oldest `last_seen` first). A 10k preview generator.

Feeder and hex aggregates are left out. There is no feeder field, and home points are mock, so a hex grid would claim geography we do not have.

## Not in these slices

- Per-zone fleet counts on the tick, so zones stop being `index % 4`. The engine now fills `TickResult.zone_delivered_mw` and `GET /v1/fleet/rollups` (`docs/agents/fleet-rollups.md`). Live/archive tape targets scale with `FLEET_SIZE` against that cap; the Demo tape stays 100 / 0.40. The map and ack rail still paint `index % 4` until a later gap reads those rollups.
- `GET /v1/homes` paging, `q`, and an exceptions filter, plus a server zone aggregate, so the browser never holds 10k rows.
