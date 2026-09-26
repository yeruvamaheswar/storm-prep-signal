import { describe, expect, it } from "vitest"
import zonesFile from "../../geo/ercot-load-zones.json"
import { scenes } from "../src/fixtures/scenes"
import { ackCaption } from "../src/format"
import {
  ACK_TIMEOUT_MS,
  DEAD_AFTER_MS,
  ackAtMs,
  ackCounts,
  ackState,
  ackTicks,
  ackZones,
} from "../src/components/organisms/ackTicks"
import { homeNodes, parseZonePolygons, ZONE_ORDER } from "../src/components/organisms/homeNodes"

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
