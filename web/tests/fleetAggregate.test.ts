import { describe, expect, it } from "vitest"
import { HOME_STATES, fleetCells, fleetCounts, type FleetCounts } from "../src/components/organisms/fleetCells"
import { ZONE_ORDER } from "../src/components/organisms/homeNodes"
import type { TickView } from "../src/contracts"
import { zoneAggregates } from "../src/fleetAggregate"
import layoutRun from "../src/fixtures/layout-run.json"
import { scenes } from "../src/fixtures/scenes"

const ticks = layoutRun.ticks as TickView[]

function tapeTick(tick: number): TickView {
  const found = ticks.find((item) => item.tick === tick)
  if (found === undefined) {
    throw new Error(`tick ${String(tick)} missing`)
  }
  return found
}

/** The per-home reading the wall used before: walk every cell, zone by index % 4. */
function perHomeCounts(tick: TickView): Map<string, FleetCounts> {
  const out = new Map<string, FleetCounts>(
    ZONE_ORDER.map((zone) => [zone, { ok: 0, reserved: 0, discharging: 0, stale: 0, dead: 0, unconfirmed: 0 }]),
  )
  fleetCells(tick).forEach((state, index) => {
    const counts = out.get(ZONE_ORDER[index % ZONE_ORDER.length])
    if (counts !== undefined) counts[state] += 1
  })
  return out
}

function scaled(tick: TickView, homes: number): TickView {
  return {
    ...tick,
    live_homes: Math.round(homes * 0.7),
    stale_homes: Math.round(homes * 0.1),
    dead_homes: Math.round(homes * 0.2),
    delivered_mw: tick.delivered_mw * (homes / 100),
  }
}

describe("zoneAggregates", () => {
  const cases = [
    ...ticks.map((tick) => [`tape tick ${String(tick.tick)}`, tick] as const),
    ...scenes.map((scene) => [`scene ${scene.id}`, scene.tick] as const),
    ["10k homes on the storm tick", scaled(tapeTick(5), 10_000)] as const,
    ["10,003 homes, uneven split", scaled(tapeTick(6), 10_003)] as const,
  ]

  it.each(cases)("matches the per-home walk for %s", (_label, tick) => {
    const expected = perHomeCounts(tick)
    for (const item of zoneAggregates(tick)) {
      const want = expected.get(item.zone)
      for (const state of HOME_STATES) {
        expect(item[state], `${item.zone} ${state}`).toBe(want?.[state])
      }
    }
  })

  it("adds up to the fleet", () => {
    const tick = scaled(tapeTick(6), 10_003)
    const zones = zoneAggregates(tick)
    const counts = fleetCounts(tick)
    for (const state of HOME_STATES) {
      expect(zones.reduce((sum, zone) => sum + zone[state], 0)).toBe(counts[state])
    }
    expect(zones.reduce((sum, zone) => sum + zone.homes, 0)).toBe(10_003)
  })

  it("keeps tick 05 at 50 reserved and 50 discharging", () => {
    const zones = zoneAggregates(tapeTick(5))
    expect(zones.reduce((sum, zone) => sum + zone.reserved, 0)).toBe(50)
    expect(zones.map((zone) => zone.discharging)).toEqual([12, 12, 13, 13])
    expect(zones.every((zone) => zone.homes === 25)).toBe(true)
  })
})
