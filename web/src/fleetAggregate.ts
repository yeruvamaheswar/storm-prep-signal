import type { TickView } from "./contracts"
import { FLEET_RUNS, MW_PER_HOME, fleetCounts, type FleetCounts } from "./components/organisms/fleetCells"
import { ZONE_ORDER } from "./components/organisms/homeNodes"

export type ZoneName = (typeof ZONE_ORDER)[number]

export type ZoneAggregate = FleetCounts & {
  zone: ZoneName
  homes: number
  supplyingMw: number
}

/** Indices in [0, end) that land on slot `slot` of `slots`. */
function slotCount(end: number, slot: number, slots: number): number {
  return end <= slot ? 0 : Math.floor((end - 1 - slot) / slots) + 1
}

/**
 * Homes per load zone, without one entry per home.
 * Same `index % 4` rule as the map dots and the ack rail, over the FLEET_RUNS order,
 * so a zone reads the same counts at 100 homes or 10k.
 */
export function zoneAggregates(tick: TickView): ZoneAggregate[] {
  const counts = fleetCounts(tick)
  const slots = ZONE_ORDER.length
  return ZONE_ORDER.map((zone, slot) => {
    const byState: FleetCounts = { ok: 0, reserved: 0, discharging: 0, stale: 0, dead: 0, unconfirmed: 0 }
    let start = 0
    for (const state of FLEET_RUNS) {
      const end = start + counts[state]
      byState[state] = slotCount(end, slot, slots) - slotCount(start, slot, slots)
      start = end
    }
    const homes = FLEET_RUNS.reduce((sum, state) => sum + byState[state], 0)
    return { zone, homes, supplyingMw: byState.discharging * MW_PER_HOME, ...byState }
  })
}

export function zoneAggregate(tick: TickView, zone: ZoneName): ZoneAggregate | undefined {
  return zoneAggregates(tick).find((item) => item.zone === zone)
}
