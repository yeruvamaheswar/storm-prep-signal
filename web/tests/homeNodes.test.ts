import { describe, expect, it } from "vitest"
import zonesFile from "../../geo/ercot-load-zones.json"
import layoutRun from "../src/fixtures/layout-run.json"
import type { RunFile } from "../src/contracts"
import { countState } from "../src/components/organisms/fleetCells"
import {
  homeNodes,
  homeTooltip,
  inCityWeight,
  parseZonePolygons,
  ZONE_ORDER,
  type ZonePolygon,
} from "../src/components/organisms/homeNodes"

const run = layoutRun as RunFile

function tick(n: number) {
  const found = run.ticks.find((item) => item.tick === n)
  if (found === undefined) {
    throw new Error(`missing tick ${n}`)
  }
  return found
}

/** Two squares. A point on the shared edge is accepted by the even-odd rule of one of them. */
const zones: ZonePolygon[] = [
  {
    name: "North",
    rings: [
      [
        [-100, 32],
        [-97, 32],
        [-97, 34],
        [-100, 34],
        [-100, 32],
      ],
    ],
  },
  {
    name: "Houston",
    rings: [
      [
        [-96, 29],
        [-94, 29],
        [-94, 31],
        [-96, 31],
        [-96, 29],
      ],
    ],
  },
]

function inside(zone: ZonePolygon, lng: number, lat: number): boolean {
  const ring = zone.rings[0] ?? []
  let hits = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [lngI, latI] = ring[i] ?? [0, 0]
    const [lngJ, latJ] = ring[j] ?? [0, 0]
    const crosses = latI > lat !== latJ > lat
    if (crosses && lng < ((lngJ - lngI) * (lat - latI)) / (latJ - latI) + lngI) {
      hits = !hits
    }
  }
  return hits
}

describe("homeNodes", () => {
  it("keeps tick 05 at 50 reserved and 50 discharging, one point per home", () => {
    const nodes = homeNodes(tick(5), zones)
    expect(nodes).toHaveLength(100)
    expect(countState(nodes.map((node) => node.status), "reserved")).toBe(50)
    expect(countState(nodes.map((node) => node.status), "discharging")).toBe(50)
  })

  it("scatters each home inside its own zone and does not move when the tick changes", () => {
    const storm = homeNodes(tick(5), zones)
    const calm = homeNodes(tick(1), zones)
    expect(storm.map((node) => [node.lng, node.lat, node.zone])).toEqual(
      calm.map((node) => [node.lng, node.lat, node.zone]),
    )
    for (const node of storm) {
      const zone = zones.find((item) => item.name === node.zone)
      expect(zone).toBeDefined()
      expect(inside(zone as ZonePolygon, node.lng, node.lat)).toBe(true)
    }
  })

  it("names zone and status in the tooltip and leaves the street out", () => {
    const node = homeNodes(tick(5), zones)[0]
    expect(node).toBeDefined()
    expect(homeTooltip(node!)).toBe(`${node!.zone} · ${node!.status}`)
    expect(homeTooltip(node!)).not.toMatch(/street|address|ave|road/i)
  })

  it("keeps every mock home inside its ERCOT zone and on that zone's metro", () => {
    const polygons = parseZonePolygons(zonesFile)
    expect(polygons.map((zone) => zone.name).sort()).toEqual(["Houston", "North", "South", "West"])
    const nodes = homeNodes(tick(5), polygons)
    expect(nodes).toHaveLength(100)
    for (const name of ZONE_ORDER) {
      expect(nodes.filter((node) => node.zone === name)).toHaveLength(25)
    }
    for (const node of nodes) {
      const zone = polygons.find((item) => item.name === node.zone)
      expect(zone).toBeDefined()
      expect(inside(zone as ZonePolygon, node.lng, node.lat)).toBe(true)
      expect(inCityWeight(node.zone, node.lng, node.lat)).toBe(true)
    }
  })

  it("reads a coarse GeoJSON feature by zone name", () => {
    const parsed = parseZonePolygons({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { zone: "West", note: "approximate" },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [-104, 31],
                [-101, 31],
                [-101, 33],
                [-104, 33],
                [-104, 31],
              ],
            ],
          },
        },
      ],
    })
    expect(parsed).toEqual([
      {
        name: "West",
        rings: [
          [
            [-104, 31],
            [-101, 31],
            [-101, 33],
            [-104, 33],
            [-104, 31],
          ],
        ],
      },
    ])
  })
})
