import { centroid, type Point } from "../flow/flowMath"
import type { FlowHome, FlowTick, FlowZoneRow, OrderTimelineEntry } from "../flow/types"
import { kw, plainReason } from "./format"
import { splitOrders } from "./orderState"

/** A geographic point, Leaflet order. */
export type LatLng = { lat: number; lng: number }

/** The controller node sits in the Austin area; every arc starts here. */
export const CONTROLLER_LATLNG: LatLng = { lat: 30.27, lng: -97.74 }

export type ZoneGeo = {
  zone: string
  /** Outer ring as [lng, lat] pairs, as in the GeoJSON. */
  ring: Point[]
  /** A point inside the zone: the area centroid, or the nearest interior sample when the centroid falls outside. */
  anchor: LatLng
}

type GeoFeature = { properties?: { zone?: unknown }; geometry?: { type?: string; coordinates?: unknown } }

/** Ray-casting point-in-polygon on [lng, lat] pairs. */
export function insideRing(lng: number, lat: number, ring: Point[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** A point guaranteed to be inside the ring, as close to its area centroid as a 40x40 sample allows. */
export function interiorAnchor(ring: Point[]): LatLng {
  const [cx, cy] = centroid(ring)
  if (insideRing(cx, cy, ring)) return { lat: cy, lng: cx }
  const xs = ring.map((p) => p[0])
  const ys = ring.map((p) => p[1])
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  let best: LatLng | null = null
  let bestD = Infinity
  const steps = 40
  for (let i = 1; i < steps; i += 1) {
    for (let j = 1; j < steps; j += 1) {
      const x = minX + ((maxX - minX) * i) / steps
      const y = minY + ((maxY - minY) * j) / steps
      if (!insideRing(x, y, ring)) continue
      const d = (x - cx) ** 2 + (y - cy) ** 2
      if (d < bestD) {
        bestD = d
        best = { lat: y, lng: x }
      }
    }
  }
  return best ?? { lat: cy, lng: cx }
}

/** Zone rings and inside anchors from geo/ercot-load-zones.json. */
export function zoneGeos(geo: unknown): ZoneGeo[] {
  const features = (geo as { features?: GeoFeature[] } | null)?.features ?? []
  const out: ZoneGeo[] = []
  for (const feature of features) {
    const zone = feature.properties?.zone
    const coords = feature.geometry?.coordinates as number[][][] | undefined
    if (typeof zone !== "string" || feature.geometry?.type !== "Polygon" || !coords?.[0]) continue
    const ring = coords[0].map(([lng, lat]) => [lng, lat] as Point)
    out.push({ zone, ring, anchor: interiorAnchor(ring) })
  }
  return out
}

/** [[south, west], [north, east]] around every zone ring. */
export function geoBounds(zones: ZoneGeo[]): [[number, number], [number, number]] {
  const lngs = zones.flatMap((z) => z.ring.map((p) => p[0]))
  const lats = zones.flatMap((z) => z.ring.map((p) => p[1]))
  return [[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]]
}

export type ZoneActivity = {
  /** Homes in the zone with a `sent` order at or before the playhead. */
  asked: number
  /** Homes in the zone with a `conf` at or before the playhead. */
  confirmed: number
  /** Confirmed discharge kW at the playhead, from each `conf`'s actual kW. Undefined when a confirmed
   * discharge has no kW on record, so the chip says "Not reported" instead of an invented sum. */
  soldKw: number | undefined
  /** At least one `sent` at or before the playhead: the zone gets the highlight and its arc. */
  sent: boolean
  /** At least one lost order or report at or before the playhead: the zone gets a loss mark. */
  dropped: boolean
}

/** Everything a zone's chip, arc and loss mark show, read from logged order events up to `tSeconds`. */
export function zoneActivity(
  zone: string,
  homes: FlowHome[],
  orders: Record<string, OrderTimelineEntry[]> | undefined,
  tSeconds: number,
): ZoneActivity {
  const ids = new Set(homes.filter((home) => home.zone === zone).map((home) => home.id))
  let asked = 0
  let confirmed = 0
  let soldKw: number | undefined = 0
  let dropped = false
  for (const [id, timeline] of Object.entries(orders ?? {})) {
    if (!ids.has(id)) continue
    const seen = timeline.filter(([at]) => at <= tSeconds)
    if (seen.some(([, kind]) => kind === "sent")) asked += 1
    if (seen.some(([, kind]) => kind === "conf")) confirmed += 1
    if (seen.some(([, kind]) => kind === "drop" || kind === "rdrop")) dropped = true
    const split = splitOrders(seen)
    for (const unit of [split.own, split.r]) {
      const conf = unit.find(([, kind]) => kind === "conf")
      if (!conf) continue
      const sentKw = unit.find(([, kind]) => kind === "sent")?.[2]
      const actual = conf[2]
      if (typeof actual === "number") {
        if (actual > 0 && soldKw !== undefined) soldKw += actual
      } else if (!(typeof sentKw === "number" && sentKw < 0)) {
        // A confirmed discharge with no kW on record: the zone total is unknown.
        soldKw = undefined
      }
    }
  }
  return { asked, confirmed, soldKw, sent: asked > 0, dropped }
}

/** A zone's floor is raised only when both its floor this tick and the fleet's base floor are reported. */
export function zoneRaised(zone: string, tick: Pick<FlowTick, "zone_reserve_pct"> | null | undefined, baseFloorPct: number | undefined): boolean {
  const floor = tick?.zone_reserve_pct?.[zone]
  if (typeof floor !== "number" || typeof baseFloorPct !== "number") return false
  return floor > baseFloorPct
}

export type ChipLens = "send" | "keep" | "trust"

export function chipLines(
  zone: string,
  activity: ZoneActivity | null,
  row: FlowZoneRow | undefined,
  tick: Pick<FlowTick, "zone_reserve_pct" | "zone_reasons"> | null | undefined,
  lens: ChipLens,
): [string, string] {
  if (lens === "keep") {
    const floor = tick?.zone_reserve_pct?.[zone] ?? row?.reserve_pct
    const reason = tick?.zone_reasons?.[zone] ?? row?.reason
    return [
      typeof floor === "number" ? `Floor ${floor}%` : "Floor not reported",
      reason ? plainReason(reason) : "Reason not reported",
    ]
  }
  if (!activity) return ["Not reported", "Open zone"]
  const asked = `${activity.asked} ${activity.asked === 1 ? "home" : "homes"} asked`
  if (lens === "trust") return [asked, `${activity.confirmed} confirmed`]
  return [asked, activity.soldKw === undefined ? "kW sold not reported" : `${kw(activity.soldKw, 1)} sold`]
}

/** Quadratic arc from `from` to `to`, bowed sideways by a fifth of its length. */
export function arcControl(from: Point, to: Point): Point {
  const [x0, y0] = from
  const [x1, y1] = to
  const dx = x1 - x0
  const dy = y1 - y0
  return [(x0 + x1) / 2 - dy * 0.2, (y0 + y1) / 2 + dx * 0.2]
}

export function arcPath(from: Point, to: Point): string {
  const [cx, cy] = arcControl(from, to)
  return `M${from[0].toFixed(1)},${from[1].toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${to[0].toFixed(1)},${to[1].toFixed(1)}`
}

/** A point `t` of the way along the arc (0 at the controller, 1 at the zone). */
export function arcPoint(from: Point, to: Point, t: number): Point {
  const c = arcControl(from, to)
  const u = 1 - t
  return [u * u * from[0] + 2 * u * t * c[0] + t * t * to[0], u * u * from[1] + 2 * u * t * c[1] + t * t * to[1]]
}

const CHIP_W = 150
const CHIP_H = 74

/** Where a zone chip sits: above its dot cluster, or below it when above would cover the controller node. */
export function chipPlacement(anchor: Point, radius: number, node: Point): { top: number; below: boolean } {
  const aboveBottom = anchor[1] - radius - 8
  const coversNode = Math.abs(node[0] - anchor[0]) < CHIP_W / 2 + 18
    && node[1] > aboveBottom - CHIP_H - 18 && node[1] < aboveBottom + 18
  return coversNode ? { top: anchor[1] + radius + 8, below: true } : { top: aboveBottom, below: false }
}

/** Dot-cluster radius in pixels, growing with the zone's home count. */
export function clusterRadius(homeCount: number): number {
  return Math.min(30, Math.max(12, 10 + Math.sqrt(homeCount) * 2))
}
