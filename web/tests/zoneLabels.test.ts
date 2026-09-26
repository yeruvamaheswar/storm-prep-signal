import { describe, expect, it } from "vitest"
import zonesFile from "../../geo/ercot-load-zones.json"
import layoutRun from "../src/fixtures/layout-run.json"
import type { RunFile } from "../src/contracts"
import { homeNodes, labelCandidates, parseZonePolygons, zoneContains } from "../src/components/organisms/homeNodes"
import { clusterCaption } from "../src/format"
import { zonePaint } from "../src/zonePaint"
import {
  clusterCounts,
  clusterGroups,
  haloCandidates,
  labelSize,
  pickLabelAnchor,
  rectCentered,
  type LabelCandidate,
  type PlaneRect,
} from "../src/zoneLabels"

const run = layoutRun as RunFile

function tick(n: number) {
  const found = run.ticks.find((item) => item.tick === n)
  if (found === undefined) {
    throw new Error(`missing tick ${n}`)
  }
  return found
}

/** Same window the wall fits: Texas, about a pane wide. */
function project(lng: number, lat: number, width = 720, height = 560) {
  const west = -106.65
  const east = -93.51
  const south = 25.84
  const north = 36.5
  return {
    x: ((lng - west) / (east - west)) * width,
    y: ((north - lat) / (north - south)) * height,
  }
}

describe("zone labels", () => {
  it("keeps Houston, West, and South captions off their dots", () => {
    const zones = parseZonePolygons(zonesFile)
    const nodes = homeNodes(tick(5), zones)
    const paint = zonePaint(tick(5))
    const blocked: PlaneRect[] = []
    const frame = { x: 0, y: 0, w: 720, h: 560 }
    const ordered = [...zones].sort((a, b) => labelCandidates(a).length - labelCandidates(b).length)
    for (const zone of ordered) {
      const posted = paint.zones.find((item) => item.zone === zone.name)
      const text = posted?.mw == null ? zone.name : `${zone.name} ${posted.mw} MW`
      const { w, h } = labelSize(text.toUpperCase())
      const interior: LabelCandidate[] = labelCandidates(zone).map(([lng, lat]) => ({
        ...project(lng, lat),
        inside: true,
      }))
      const candidates = haloCandidates(interior, w, h, (x, y) => {
        const lng = -106.65 + (x / 720) * (-93.51 - -106.65)
        const lat = 36.5 - (y / 560) * (36.5 - 25.84)
        return { x, y, inside: zoneContains(zone, lng, lat) }
      })
      const obstacles = nodes.map((node) => project(node.lng, node.lat))
      const anchor = pickLabelAnchor(candidates, w, h, obstacles, blocked, frame)
      expect(anchor).not.toBeNull()
      if (anchor === null) {
        return
      }
      blocked.push(rectCentered(anchor, w, h))
      const box = rectCentered(anchor, w, h)
      const hits = obstacles.filter(
        (point) => point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h,
      )
      const gap = Math.min(
        ...obstacles.map((point) => {
          const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.w))
          const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.h))
          return Math.hypot(dx, dy)
        }),
      )
      expect(hits, zone.name).toHaveLength(0)
      expect(gap, zone.name).toBeGreaterThanOrEqual(14)
    }
  })

  it("prefers a clear interior point over a clear point outside the zone", () => {
    const obstacles = [{ x: 0, y: 0 }]
    const anchor = pickLabelAnchor(
      [
        { x: 0, y: 0, inside: true },
        { x: 80, y: 0, inside: false },
        { x: 40, y: 0, inside: true },
      ],
      10,
      10,
      obstacles,
      [],
    )
    expect(anchor).toEqual({ x: 40, y: 0, inside: true })
  })

  it("steps outside the zone when every interior label still touches the dots", () => {
    const anchor = pickLabelAnchor(
      [
        { x: 10, y: 10, inside: true },
        { x: 10, y: 40, inside: false },
      ],
      20,
      12,
      [{ x: 10, y: 18 }],
      [],
    )
    expect(anchor).toEqual({ x: 10, y: 40, inside: false })
  })
})

describe("cluster tips", () => {
  it("splits South into two metros and names homes, reserved, discharging, and MW", () => {
    const zones = parseZonePolygons(zonesFile)
    const nodes = homeNodes(tick(5), zones)
    const groups = clusterGroups(nodes)
    const south = groups.filter((group) => group[0]?.zone === "South")
    expect(south.length).toBe(2)
    const mw = zonePaint(tick(5)).zones.find((zone) => zone.zone === "Houston")?.mw ?? null
    const houston = groups.find((group) => group[0]?.zone === "Houston")
    if (houston === undefined) {
      throw new Error("missing Houston cluster")
    }
    const text = clusterCaption(clusterCounts(houston, mw))
    expect(text).toContain(`${houston.length} homes`)
    expect(text).toContain("reserved")
    expect(text).toContain("discharging")
    expect(text).toContain("supplying")
    expect(text).toContain("MW")
    expect(text).toContain("zone")
  })
})
