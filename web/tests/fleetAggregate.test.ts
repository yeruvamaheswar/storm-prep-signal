import { describe, expect, it } from "vitest"
import { HOME_STATES, fleetCells, fleetCounts, type FleetCounts } from "../src/components/organisms/fleetCells"
import { ZONE_ORDER } from "../src/components/organisms/homeNodes"
import type { FleetRollups, TickView, ZoneRollup } from "../src/contracts"
import { MAX_VISIBLE_POINTS, dotSampleNote, visibleHomeNodes, zoneAggregates } from "../src/fleetAggregate"
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

  it("paints an uneven 10k assign_zone split from rollups, not index % 4", () => {
    const tick = scaled(tapeTick(5), 10_000)
    const even = zoneAggregates(tick)
    expect(even.every((zone) => zone.homes === 2500)).toBe(true)
    const zones = zoneAggregates(tick, unevenTenK)
    expect(zones.map((zone) => zone.zone)).toEqual([...ZONE_ORDER])
    expect(zones.find((zone) => zone.zone === "South")).toMatchObject({
      live: 4100,
      reserved: 80,
      discharging: 220,
      stale: 12,
      dead: 8,
      silent: 12,
      ok: 3800,
      unconfirmed: 0,
      homes: 4120,
      supplyingMw: 1.1,
      reservedMw: 0.4,
    })
    expect(zones.find((zone) => zone.zone === "Houston")?.homes).toBe(3260)
    expect(zones.reduce((sum, zone) => sum + zone.homes, 0)).toBe(10_000)
  })

  it("keeps today's index % 4 reading when rollups are missing", () => {
    const tick = tapeTick(5)
    expect(zoneAggregates(tick, null)).toEqual(zoneAggregates(tick))
    expect(zoneAggregates(tick, { n: 4, zones: {} })).toEqual(zoneAggregates(tick))
  })
})

const emptyZone: ZoneRollup = {
  live: 0,
  reserved: 0,
  discharging: 0,
  stale: 0,
  dead: 0,
  silent: 0,
  reserved_mw: 0,
  discharging_mw: 0,
}

const unevenTenK: FleetRollups = {
  n: 10_000,
  zones: {
    South: { ...emptyZone, live: 4100, reserved: 80, discharging: 220, stale: 12, dead: 8, silent: 12, reserved_mw: 0.4, discharging_mw: 1.1 },
    North: { ...emptyZone, live: 1700, reserved: 40, discharging: 60, stale: 6, dead: 4, silent: 6, reserved_mw: 0.2, discharging_mw: 0.3 },
    West: { ...emptyZone, live: 900, reserved: 20, discharging: 30, stale: 4, dead: 6, silent: 4, reserved_mw: 0.1, discharging_mw: 0.15 },
    Houston: { ...emptyZone, live: 3180, reserved: 50, discharging: 90, stale: 20, dead: 60, silent: 20, reserved_mw: 0.25, discharging_mw: 0.45 },
  },
  clusters: [
    { id: "South:0", zone: "South", lng: -98.475, lat: 29.45 },
    { id: "South:1", zone: "South", lng: -97.7, lat: 30.275 },
    { id: "North:0", zone: "North", lng: -97.0, lat: 32.825 },
    { id: "West:0", zone: "West", lng: -102.175, lat: 31.925 },
    { id: "Houston:0", zone: "Houston", lng: -95.45, lat: 29.775 },
  ],
}

describe("visibleHomeNodes", () => {
  const box: { name: string; rings: readonly (readonly [number, number][])[] }[] = [
    { name: "South", rings: [[[-99, 29], [-97, 29], [-97, 31], [-99, 31], [-99, 29]]] },
    { name: "North", rings: [[[-98, 32], [-96, 32], [-96, 34], [-98, 34], [-98, 32]]] },
    { name: "West", rings: [[[-103, 31], [-101, 31], [-101, 33], [-103, 33], [-103, 31]]] },
    { name: "Houston", rings: [[[-96, 29], [-94, 29], [-94, 31], [-96, 31], [-96, 29]]] },
  ]

  it("never expands a 10k rollup past MAX_VISIBLE_POINTS", () => {
    const nodes = visibleHomeNodes(scaled(tapeTick(5), 10_000), box, unevenTenK)
    expect(MAX_VISIBLE_POINTS).toBe(500)
    expect(nodes.length).toBeLessThanOrEqual(MAX_VISIBLE_POINTS)
    expect(nodes.length).toBe(MAX_VISIBLE_POINTS)
    expect(nodes.some((node) => node.zone === "South" && node.status === "discharging")).toBe(true)
    expect(nodes.filter((node) => node.zone === "South").length).toBeGreaterThan(nodes.filter((node) => node.zone === "West").length)
    const cells = new Set(nodes.map((node) => `${node.lng.toFixed(3)}:${node.lat.toFixed(3)}`))
    expect(cells.size).toBeGreaterThan(50)
  })

  it("names the sample ratio when the fleet is larger than the cap", () => {
    expect(dotSampleNote(10_000)).toBe("1 dot ≈ 20 homes")
    expect(dotSampleNote(100)).toBeNull()
  })

  it("falls back to today's index % 4 dots when rollups are missing", () => {
    const tick = tapeTick(5)
    const fallback = visibleHomeNodes(tick, box, null)
    expect(fallback.map((node) => node.zone)).toEqual(
      [...Array(100)].map((_, index) => ZONE_ORDER[index % 4]),
    )
    expect(fallback.filter((node) => node.status === "reserved").length).toBe(50)
  })
})
