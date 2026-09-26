import { describe, expect, it } from "vitest"
import zonesFile from "../../geo/ercot-load-zones.json"
import layoutRun from "../src/fixtures/layout-run.json"
import type { RunFile } from "../src/contracts"
import { scenes } from "../src/fixtures/scenes"
import { ackCaption } from "../src/format"
import {
  ACK_TIMEOUT_MS,
  DEAD_AFTER_MS,
  ackAtMs,
  ackCounts,
  ackMarkCounts,
  ackState,
  ackSummary,
  ackTicks,
  ackZones,
  tickFailSafe,
  zoneAcked,
} from "../src/components/organisms/ackTicks"
import { homeNodes, parseZonePolygons, ZONE_ORDER } from "../src/components/organisms/homeNodes"

const run = layoutRun as RunFile

function tapeTick(n: number) {
  const found = run.ticks.find((item) => item.tick === n)
  if (found === undefined) {
    throw new Error(`missing tick ${n}`)
  }
  return found
}

const devices = scenes.find((scene) => scene.id === "devices")
if (devices === undefined) {
  throw new Error("missing 15% dead scene")
}
const tick = devices.tick

describe("ackTicks", () => {
  it("gives 100 ticks, 25 per zone, in the zone each map dot sits in", () => {
    const ticks = ackTicks(tick)
    expect(ticks).toHaveLength(100)
    expect(ackZones(ticks).map((group) => [group.zone, group.ticks.length])).toEqual(
      ZONE_ORDER.map((zone) => [zone, 25]),
    )
    const nodes = homeNodes(tick, parseZonePolygons(zonesFile))
    expect(ticks.map((item) => [item.zone, item.home])).toEqual(nodes.map((node) => [node.zone, node.status]))
  })

  it("starts every worker pending and lands every live answer inside the timeout", () => {
    const ticks = ackTicks(tick)
    expect(ackCounts(ticks, 0).pending).toBe(100)
    for (const item of ticks) {
      expect(ackAtMs(item.index)).toBeLessThan(ACK_TIMEOUT_MS)
    }
  })

  it("moves the 15 dead homes to unconfirmed at 2s, then dead, while the rest stay acked", () => {
    const ticks = ackTicks(tick)
    expect(ackCounts(ticks, ACK_TIMEOUT_MS - 1)).toEqual({ pending: 15, acked: 85, unconfirmed: 0, dead: 0 })
    expect(ackCounts(ticks, ACK_TIMEOUT_MS)).toEqual({ pending: 0, acked: 85, unconfirmed: 15, dead: 0 })
    expect(ackCounts(ticks, DEAD_AFTER_MS)).toEqual({ pending: 0, acked: 85, unconfirmed: 0, dead: 15 })
  })

  it("keeps every discharging home acked once it answers", () => {
    const discharging = ackTicks(tick).filter((item) => item.home === "discharging")
    expect(discharging.length).toBeGreaterThan(0)
    for (const item of discharging) {
      for (const at of [ackAtMs(item.index), ACK_TIMEOUT_MS, DEAD_AFTER_MS, DEAD_AFTER_MS * 2]) {
        expect(ackState(item, at)).toBe("acked")
      }
    }
  })
})

describe("ack marks", () => {
  it("paints the storm tick as discharging acks and held homes, per zone", () => {
    const storm = tapeTick(5)
    const ticks = ackTicks(storm)
    expect(tickFailSafe(storm)).toBe(false)
    expect(ackMarkCounts(ticks, DEAD_AFTER_MS, false)).toEqual({
      pending: 0,
      acked: 50,
      held: 50,
      silent: 0,
      dead: 0,
      failsafe: 0,
    })
    expect(ackZones(ticks).map((group) => zoneAcked(group.ticks, DEAD_AFTER_MS, false))).toEqual([12, 12, 13, 13])
    expect(ackSummary(ackMarkCounts(ticks, DEAD_AFTER_MS, false), storm.delivered_mw)).toBe(
      "0 silent · 50 acked · 50 held · call 0.31 MW",
    )
  })

  it("keeps dead homes out of the zone ack count on the tick where homes died", () => {
    const died = tapeTick(6)
    const ticks = ackTicks(died)
    expect(ackMarkCounts(ticks, DEAD_AFTER_MS, false)).toEqual({
      pending: 0,
      acked: 40,
      held: 40,
      silent: 0,
      dead: 20,
      failsafe: 0,
    })
    expect(ackZones(ticks).map((group) => zoneAcked(group.ticks, DEAD_AFTER_MS, false))).toEqual([10, 10, 10, 10])
    expect(ackMarkCounts(ticks, ACK_TIMEOUT_MS, false).silent).toBe(20)
  })

  it("marks stale homes silent and a missing signal fail-safe, without counting them acked", () => {
    const ticks = ackTicks(tick)
    const settled = ackMarkCounts(ticks, DEAD_AFTER_MS, false)
    expect(settled.silent).toBe(4)
    expect(settled.dead).toBe(15)
    expect(settled.acked).toBe(81)
    expect(zoneAcked(ticks, DEAD_AFTER_MS, false)).toBe(81)

    const failsafe = scenes.find((scene) => scene.id === "failsafe")
    if (failsafe === undefined) {
      throw new Error("missing fail-safe scene")
    }
    const failed = ackTicks(failsafe.tick)
    expect(tickFailSafe(failsafe.tick)).toBe(true)
    expect(ackMarkCounts(failed, DEAD_AFTER_MS, true).failsafe).toBe(100)
    expect(zoneAcked(failed, DEAD_AFTER_MS, true)).toBe(0)
    expect(ackSummary(ackMarkCounts(failed, DEAD_AFTER_MS, true), failsafe.tick.delivered_mw)).toBe(
      "0 silent · 0 acked · 100 fail-safe · call still 0.00 MW",
    )
  })
})

describe("ackCaption", () => {
  it("reads the settled 15% dead scene", () => {
    const counts = ackCounts(ackTicks(tick), DEAD_AFTER_MS)
    expect(ackCaption(counts, tick.delivered_mw)).toBe("15 silent · 85 acked · call still 0.34 MW")
  })

  it("names pending workers and drops 'still' when nobody is silent", () => {
    expect(ackCaption({ pending: 3, acked: 97, unconfirmed: 0, dead: 0 }, 0.4)).toBe(
      "3 pending · 0 silent · 97 acked · call 0.40 MW",
    )
  })
})
