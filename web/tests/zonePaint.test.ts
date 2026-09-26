import { describe, expect, it } from "vitest"
import layoutRun from "../src/fixtures/layout-run.json"
import { scenes } from "../src/fixtures/scenes"
import type { RunFile, TickView } from "../src/contracts"
import { countState, fleetCells } from "../src/components/organisms/fleetCells"
import { zoneHierarchyPaint, zonePaint, zonePathPaint } from "../src/zonePaint"

const run = layoutRun as RunFile

function tick(n: number): TickView {
  const found = run.ticks.find((item) => item.tick === n)
  if (found === undefined) {
    throw new Error(`missing tick ${n}`)
  }
  return found
}

function zoneTotal(item: TickView): number {
  const houston = item.houston_mw
  const north = item.north_mw
  const south = item.south_mw
  const west = item.west_mw
  if (houston === undefined || north === undefined || south === undefined || west === undefined) {
    throw new Error(`tick ${item.tick} is missing zone MW columns`)
  }
  return houston + north + south + west
}

function withoutZoneMw(item: TickView): TickView {
  const row = { ...item }
  delete row.houston_mw
  delete row.north_mw
  delete row.south_mw
  delete row.west_mw
  return row
}

describe("zonePaint", () => {
  it("carries houston_mw, north_mw, south_mw, and west_mw on every tape tick", () => {
    expect(run.ticks).toHaveLength(12)
    for (const item of run.ticks) {
      expect(item.houston_mw).toEqual(expect.any(Number))
      expect(item.north_mw).toEqual(expect.any(Number))
      expect(item.south_mw).toEqual(expect.any(Number))
      expect(item.west_mw).toEqual(expect.any(Number))
    }
    expect(tick(5).north_mw).toBe(9294)
    expect(zoneTotal(tick(5))).toBe(22539)
    for (const item of run.ticks) {
      if (item.risk_level === "LOW") {
        expect(zoneTotal(item)).toBeLessThan(22348)
      }
    }
  })

  it("paints fills from houston_mw columns on the tick", () => {
    const paint = zonePaint({
      ...tick(1),
      risk_level: "HIGH",
      houston_mw: 50,
      north_mw: 10,
      south_mw: 10,
      west_mw: 10,
    })
    const houston = paint.zones.find((zone) => zone.zone === "Houston")
    expect(paint.muted).toBe(false)
    expect(houston?.mw).toBe(50)
    expect(houston?.emphasized).toBe(true)
  })

  it("does not invent spike fills when the tick has no zone MW columns", () => {
    const paint = zonePaint(withoutZoneMw(tick(5)))
    expect(paint.muted).toBe(true)
    expect(paint.zones.every((zone) => zone.mw === null && zone.emphasized === false)).toBe(true)
  })

  it("emphasizes North on tick 05 from the spike posting", () => {
    const paint = zonePaint(tick(5))
    const north = paint.zones.find((zone) => zone.zone === "North")
    const others = paint.zones.filter((zone) => zone.zone !== "North")

    expect(paint.muted).toBe(false)
    expect(north?.mw).toBe(9294)
    expect(north?.emphasized).toBe(true)
    expect(north?.share).toBeGreaterThan(0)
    for (const zone of others) {
      expect(zone.emphasized).toBe(false)
      expect(north?.share ?? 0).toBeGreaterThan(zone.share ?? 0)
    }
    expect(countState(fleetCells(tick(5)), "reserved")).toBeGreaterThan(countState(fleetCells(tick(5)), "ok"))
  })

  it("keeps dead homes on tick 06 while North stays the driving zone", () => {
    const paint = zonePaint(tick(6))
    expect(paint.zones.find((zone) => zone.zone === "North")?.emphasized).toBe(true)
    expect(countState(fleetCells(tick(6)), "dead")).toBe(20)
  })

  it("mutes every zone on the fail-safe scene", () => {
    const failsafe = scenes.find((scene) => scene.id === "failsafe")
    if (failsafe === undefined) {
      throw new Error("missing fail-safe scene")
    }
    const paint = zonePaint(failsafe.tick)
    expect(paint.muted).toBe(true)
    expect(paint.zones.every((zone) => zone.mw === null && zone.emphasized === false)).toBe(true)
  })

  it("reads NP3 zone columns on the tick instead of the fallback posting", () => {
    const custom = {
      ...tick(1),
      risk_level: "HIGH" as const,
      driving_zone: "Houston",
      totalResourceMWZoneHouston: 100,
      totalIRRMWZoneHouston: 0,
      totalNewEquipResourceMWZoneHouston: 0,
      totalResourceMWZoneNorth: 10,
      totalIRRMWZoneNorth: 0,
      totalNewEquipResourceMWZoneNorth: 0,
      totalResourceMWZoneSouth: 10,
      totalIRRMWZoneSouth: 0,
      totalNewEquipResourceMWZoneSouth: 0,
      totalResourceMWZoneWest: 10,
      totalIRRMWZoneWest: 0,
      totalNewEquipResourceMWZoneWest: 0,
    }
    const paint = zonePaint(custom)
    const houston = paint.zones.find((zone) => zone.zone === "Houston")
    expect(paint.muted).toBe(false)
    expect(houston?.mw).toBe(100)
    expect(houston?.emphasized).toBe(true)
  })

  it("paints tick 05 North darker than the other zones and mutes a missing report", () => {
    const storm = zonePaint(tick(5))
    const north = storm.zones.find((zone) => zone.zone === "North")
    const houston = storm.zones.find((zone) => zone.zone === "Houston")
    if (north === undefined || houston === undefined) {
      throw new Error("missing zone")
    }
    const northPaint = zonePathPaint(north, storm.muted, "HIGH")
    const houstonPaint = zonePathPaint(houston, storm.muted, "HIGH")
    expect(northPaint.fill).toBe("#B45309")
    expect(northPaint.weight).toBe(2)
    expect(northPaint.fillOpacity).toBeGreaterThan(houstonPaint.fillOpacity)

    const failsafe = scenes.find((scene) => scene.id === "failsafe")
    if (failsafe === undefined) {
      throw new Error("missing fail-safe scene")
    }
    const muted = zonePaint(failsafe.tick)
    const paints = muted.zones.map((zone) => zonePathPaint(zone, muted.muted, failsafe.tick.risk_level))
    expect(paints.every((paint) => paint.fill === "#6B645B" && paint.fillOpacity === 0.22)).toBe(true)
  })

  it("fills the selected zone and mutes the others", () => {
    const storm = zonePaint(tick(5))
    const north = storm.zones.find((zone) => zone.zone === "North")
    const houston = storm.zones.find((zone) => zone.zone === "Houston")
    if (north === undefined || houston === undefined) {
      throw new Error("missing zone")
    }
    const selected = zoneHierarchyPaint(north, storm.muted, "HIGH", true)
    const quiet = zoneHierarchyPaint(houston, storm.muted, "HIGH", false)
    expect(selected.fill).toBe("#B45309")
    expect(selected.fillOpacity).toBeGreaterThan(quiet.fillOpacity)
    expect(quiet.fill).toBe("#6B645B")
    const chosen = zoneHierarchyPaint(houston, false, "HIGH", true)
    expect(chosen.fill).toBe("#B45309")
    expect(chosen.weight).toBe(2)
  })
})
