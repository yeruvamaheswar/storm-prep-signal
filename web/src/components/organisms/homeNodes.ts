import type { TickView } from "../../contracts"
import { fleetCells, type HomeState } from "./fleetCells"

/**
 * ERCOT does not publish home coordinates. NP3-233-CD only returns outage MW
 * by load-zone name, so these points are a deterministic mock inside the zone polygon.
 */

/** Same order as storm_prep.risk.ZONES, so a feature-order change cannot move a home. */
export const ZONE_ORDER = ["South", "North", "West", "Houston"] as const

export type LngLat = readonly [number, number]

/** Exterior rings only, [lng, lat] in GeoJSON order. Holes are ignored for the mock scatter. */
export type ZonePolygon = {
  name: string
  rings: readonly (readonly LngLat[])[]
}

export type HomeNode = {
  index: number
  zone: string
  status: HomeState
  lng: number
  lat: number
}

type GeoJson = {
  type?: string
  features?: GeoFeature[]
  geometry?: GeoGeometry
  properties?: Record<string, unknown>
}

type GeoFeature = {
  type?: string
  properties?: Record<string, unknown>
  geometry?: GeoGeometry
}

type GeoGeometry = {
  type?: string
  coordinates?: unknown
}

const CITY_TRIES = 48
const SAMPLE_TRIES = 80

export type LngLatBox = {
  minLng: number
  maxLng: number
  minLat: number
  maxLat: number
}

/**
 * County-scale boxes around the metros the wall should read as occupied.
 * Uniform samples across a whole ERCOT ring leave those cities empty.
 */
const CITY_WEIGHTS: Record<(typeof ZONE_ORDER)[number], readonly LngLatBox[]> = {
  Houston: [{ minLng: -96.05, maxLng: -94.85, minLat: 29.35, maxLat: 30.2 }],
  North: [{ minLng: -97.55, maxLng: -96.45, minLat: 32.45, maxLat: 33.2 }],
  South: [
    { minLng: -98.8, maxLng: -98.15, minLat: 29.2, maxLat: 29.7 },
    { minLng: -97.95, maxLng: -97.45, minLat: 30.05, maxLat: 30.5 },
  ],
  West: [{ minLng: -102.55, maxLng: -101.8, minLat: 31.7, maxLat: 32.15 }],
}

/** Houston, DFW, San Antonio / Austin, and Midland–Odessa. Unknown names get no bias. */
export function cityWeightBoxes(zoneName: string): readonly LngLatBox[] {
  switch (zoneName) {
    case "South":
    case "North":
    case "West":
    case "Houston":
      return CITY_WEIGHTS[zoneName]
    default:
      return []
  }
}

export function inCityWeight(zoneName: string, lng: number, lat: number): boolean {
  return cityWeightBoxes(zoneName).some((box) => pointInBox(box, lng, lat))
}

/** Which metro box holds this point. South has two, so a hover can name one cluster. */
export function clusterOf(node: Pick<HomeNode, "zone" | "lng" | "lat">): string {
  const boxes = cityWeightBoxes(node.zone)
  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index]
    if (box !== undefined && pointInBox(box, node.lng, node.lat)) {
      return `${node.zone}:${index}`
    }
  }
  return node.zone
}

export function zoneContains(zone: ZonePolygon, lng: number, lat: number): boolean {
  return zone.rings.some((ring) => ring.length >= 3 && ringContains(ring, lng, lat))
}

/** Interior samples. The label picker chooses one that clears the metro dots. */
export function labelCandidates(zone: ZonePolygon, columns = 8): LngLat[] {
  const rings = zone.rings.filter((ring) => ring.length >= 3)
  const exterior = rings[0]
  if (exterior === undefined) {
    return []
  }
  const box = bounds(rings.flat())
  const points: LngLat[] = []
  for (let col = 0; col < columns; col += 1) {
    for (let row = 0; row < columns; row += 1) {
      const lng = box.minLng + ((col + 0.5) / columns) * (box.maxLng - box.minLng)
      const lat = box.minLat + ((row + 0.5) / columns) * (box.maxLat - box.minLat)
      if (rings.some((ring) => ringContains(ring, lng, lat))) {
        points.push([lng, lat])
      }
    }
  }
  return points
}

/** Legend colors from web/src/design/tokens.css. Leaflet cannot paint a CSS variable. */
const NODE_FILL: Record<HomeState, string> = {
  ok: "#2f6b4f",
  discharging: "#2f6b4f",
  reserved: "#b45309",
  stale: "#7a746c",
  dead: "#9b2c2c",
  unconfirmed: "#f4f1ea",
}

const NODE_STROKE: Record<HomeState, string> = {
  ok: "#2f6b4f",
  discharging: "#2f6b4f",
  reserved: "#b45309",
  stale: "#7a746c",
  dead: "#9b2c2c",
  unconfirmed: "#1c1917",
}

export function homeNodePaint(status: HomeState): { fill: string; stroke: string } {
  switch (status) {
    case "ok":
    case "discharging":
    case "reserved":
    case "stale":
    case "dead":
    case "unconfirmed":
      return { fill: NODE_FILL[status], stroke: NODE_STROKE[status] }
    default: {
      const unexpected: never = status
      return unexpected
    }
  }
}

/** Zone and status only. A mock point is not a street address. */
export function homeTooltip(node: Pick<HomeNode, "zone" | "status">): string {
  return `${node.zone} · ${node.status}`
}

export function zonesInOrder(zones: readonly ZonePolygon[]): ZonePolygon[] {
  const byName = new Map(zones.map((zone) => [zone.name, zone]))
  const ordered = ZONE_ORDER.flatMap((name) => {
    const zone = byName.get(name)
    return zone === undefined ? [] : [zone]
  })
  if (ordered.length > 0) {
    return ordered
  }
  return [...zones]
}

/**
 * One home keeps its zone and its point across ticks. Status still comes from
 * fleetCells, so tick 05 stays 50 reserved and 50 discharging without the dots moving.
 */
export function homeNodes(tick: TickView, zones: readonly ZonePolygon[]): HomeNode[] {
  const ordered = zonesInOrder(zones)
  if (ordered.length === 0) {
    return []
  }
  const statuses = fleetCells(tick)
  const zoneCount = ordered.length
  return statuses.map((status, index) => {
    const zone = ordered[index % zoneCount]
    const slot = Math.floor(index / zoneCount)
    const point = pointInZone(zone, index, slot)
    return {
      index,
      zone: zone.name,
      status,
      lng: point[0],
      lat: point[1],
    }
  })
}

export function parseZonePolygons(geo: unknown): ZonePolygon[] {
  if (geo === null || typeof geo !== "object") {
    return []
  }
  const root = geo as GeoJson
  const features = root.type === "FeatureCollection" ? root.features ?? [] : root.type === "Feature" ? [root] : []
  const zones: ZonePolygon[] = []
  for (const feature of features) {
    const name = zoneName(feature.properties)
    const rings = geometryRings(feature.geometry)
    if (name !== null && rings.length > 0) {
      zones.push({ name, rings })
    }
  }
  return zones
}

function zoneName(properties: Record<string, unknown> | undefined): string | null {
  if (properties === undefined) {
    return null
  }
  for (const key of ["zone", "name", "zone_name", "ZONE_NAME"]) {
    const value = properties[key]
    if (typeof value === "string" && value.length > 0) {
      return value
    }
  }
  return null
}

function geometryRings(geometry: GeoGeometry | undefined): LngLat[][] {
  if (geometry?.type === "Polygon") {
    return polygonRings(geometry.coordinates)
  }
  if (geometry?.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates.flatMap((polygon) => polygonRings(polygon))
  }
  return []
}

function polygonRings(coordinates: unknown): LngLat[][] {
  if (!Array.isArray(coordinates)) {
    return []
  }
  const rings: LngLat[][] = []
  for (const ring of coordinates) {
    const parsed = parseRing(ring)
    if (parsed.length >= 3) {
      rings.push(parsed)
    }
  }
  return rings.length > 0 ? [rings[0]] : []
}

function parseRing(ring: unknown): LngLat[] {
  if (!Array.isArray(ring)) {
    return []
  }
  const points: LngLat[] = []
  for (const pair of ring) {
    if (!Array.isArray(pair) || pair.length < 2) {
      continue
    }
    const lng = pair[0]
    const lat = pair[1]
    if (typeof lng === "number" && typeof lat === "number") {
      points.push([lng, lat])
    }
  }
  return points
}

function pointInZone(zone: ZonePolygon, index: number, slot: number): LngLat {
  const rings = zone.rings.filter((ring) => ring.length >= 3)
  const exterior = rings[0]
  if (exterior === undefined) {
    return [0, 0]
  }
  const box = bounds(rings.flat())
  const random = mulberry32(seedFor(zone.name, index))
  for (const city of cityBoxesInRing(zone.name, rings, slot)) {
    const clustered = sampleInBox(rings, city, random, CITY_TRIES)
    if (clustered !== null) {
      return clustered
    }
  }
  const scattered = sampleInBox(rings, box, random, SAMPLE_TRIES)
  if (scattered !== null) {
    return scattered
  }
  for (let step = 0; step < 24; step += 1) {
    const lng = box.minLng + (((index * 17 + step * 3) % 97) + 1) / 98 * (box.maxLng - box.minLng)
    const lat = box.minLat + (((index * 13 + step * 5) % 97) + 1) / 98 * (box.maxLat - box.minLat)
    if (rings.some((ring) => ringContains(ring, lng, lat))) {
      return [lng, lat]
    }
  }
  const middle = centroid(exterior)
  if (ringContains(exterior, middle[0], middle[1])) {
    return middle
  }
  return exterior[0] ?? middle
}

/** Prefer a metro that actually sits in this ring. Slot rotates South across SA and Austin. */
function cityBoxesInRing(
  zoneName: string,
  rings: readonly (readonly LngLat[])[],
  slot: number,
): LngLatBox[] {
  const usable = cityWeightBoxes(zoneName).filter((city) => {
    const lng = (city.minLng + city.maxLng) / 2
    const lat = (city.minLat + city.maxLat) / 2
    return rings.some((ring) => ringContains(ring, lng, lat))
  })
  if (usable.length === 0) {
    return []
  }
  const start = ((slot % usable.length) + usable.length) % usable.length
  return [...usable.slice(start), ...usable.slice(0, start)]
}

function sampleInBox(
  rings: readonly (readonly LngLat[])[],
  box: LngLatBox,
  random: () => number,
  tries: number,
): LngLat | null {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const lng = box.minLng + random() * (box.maxLng - box.minLng)
    const lat = box.minLat + random() * (box.maxLat - box.minLat)
    if (rings.some((ring) => ringContains(ring, lng, lat))) {
      return [lng, lat]
    }
  }
  return null
}

function pointInBox(box: LngLatBox, lng: number, lat: number): boolean {
  return lng >= box.minLng && lng <= box.maxLng && lat >= box.minLat && lat <= box.maxLat
}

function seedFor(zone: string, index: number): number {
  let hash = 0x4552434f
  for (let i = 0; i < zone.length; i += 1) {
    hash = Math.imul(hash ^ zone.charCodeAt(i), 0x5bd1e995)
  }
  return (hash ^ Math.imul(index + 1, 0x27d4eb2d)) >>> 0
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

function bounds(ring: readonly LngLat[]): LngLatBox {
  let minLng = ring[0]?.[0] ?? 0
  let maxLng = minLng
  let minLat = ring[0]?.[1] ?? 0
  let maxLat = minLat
  for (const [lng, lat] of ring) {
    minLng = Math.min(minLng, lng)
    maxLng = Math.max(maxLng, lng)
    minLat = Math.min(minLat, lat)
    maxLat = Math.max(maxLat, lat)
  }
  return { minLng, maxLng, minLat, maxLat }
}

function ringContains(ring: readonly LngLat[], lng: number, lat: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [lngI, latI] = ring[i] ?? [0, 0]
    const [lngJ, latJ] = ring[j] ?? [0, 0]
    const crosses = latI > lat !== latJ > lat
    if (!crosses) {
      continue
    }
    const atLng = ((lngJ - lngI) * (lat - latI)) / (latJ - latI) + lngI
    if (lng < atLng) {
      inside = !inside
    }
  }
  return inside
}

function centroid(ring: readonly LngLat[]): LngLat {
  let lng = 0
  let lat = 0
  const count = Math.max(ring.length, 1)
  for (const point of ring) {
    lng += point[0]
    lat += point[1]
  }
  return [lng / count, lat / count]
}
