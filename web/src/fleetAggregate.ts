import type { FleetRollups, TickView, ZoneRollup } from "./contracts"
import { FLEET_RUNS, HOME_STATES, MW_PER_HOME, fleetCounts, type FleetCounts, type HomeState } from "./components/organisms/fleetCells"
import { ZONE_ORDER, cityWeightBoxes, homeNodes, type HomeNode, type ZonePolygon } from "./components/organisms/homeNodes"

export type ZoneName = (typeof ZONE_ORDER)[number]

export const MAX_VISIBLE_POINTS = 500

/** Map copy when the sample is smaller than the fleet. Null when every home can have a dot. */
export function dotSampleNote(homes: number, cap: number = MAX_VISIBLE_POINTS): string | null {
  if (homes <= cap || cap <= 0) {
    return null
  }
  return `1 dot ≈ ${Math.max(1, Math.round(homes / cap))} homes`
}

/** Metro box centers from homeNodes.ts CITY_WEIGHTS. Same as server/engine/fleet.py CLUSTER_CENTROIDS. */
const DEFAULT_CLUSTERS: NonNullable<FleetRollups["clusters"]> = [
  { id: "South:0", zone: "South", lng: -98.475, lat: 29.45 },
  { id: "South:1", zone: "South", lng: -97.7, lat: 30.275 },
  { id: "North:0", zone: "North", lng: -97.0, lat: 32.825 },
  { id: "West:0", zone: "West", lng: -102.175, lat: 31.925 },
  { id: "Houston:0", zone: "Houston", lng: -95.45, lat: 29.775 },
]

export type ZoneAggregate = FleetCounts & {
  zone: ZoneName
  homes: number
  live: number
  silent: number
  supplyingMw: number
  reservedMw: number
  dischargingMw: number
}

/** Indices in [0, end) that land on slot `slot` of `slots`. */
function slotCount(end: number, slot: number, slots: number): number {
  return end <= slot ? 0 : Math.floor((end - 1 - slot) / slots) + 1
}

function nonNeg(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function finiteMw(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function finishAggregate(zone: ZoneName, byState: FleetCounts, reservedMw: number, dischargingMw: number): ZoneAggregate {
  const live = byState.ok + byState.reserved + byState.discharging
  const silent = byState.stale + byState.unconfirmed
  const homes = HOME_STATES.reduce((sum, state) => sum + byState[state], 0)
  return {
    zone,
    homes,
    live,
    silent,
    supplyingMw: dischargingMw,
    reservedMw,
    dischargingMw,
    ...byState,
  }
}

function fromIndexMod4(tick: TickView): ZoneAggregate[] {
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
    return finishAggregate(zone, byState, byState.reserved * MW_PER_HOME, byState.discharging * MW_PER_HOME)
  })
}

function fromZoneRow(zone: ZoneName, row: ZoneRollup | undefined): ZoneAggregate {
  const live = nonNeg(row?.live)
  const reserved = nonNeg(row?.reserved)
  const discharging = nonNeg(row?.discharging)
  const stale = nonNeg(row?.stale)
  const dead = nonNeg(row?.dead)
  const silent = nonNeg(row?.silent)
  const byState: FleetCounts = {
    ok: Math.max(0, live - reserved - discharging),
    reserved,
    discharging,
    stale,
    dead,
    unconfirmed: Math.max(0, silent - stale),
  }
  return finishAggregate(zone, byState, finiteMw(row?.reserved_mw, reserved * MW_PER_HOME), finiteMw(row?.discharging_mw, discharging * MW_PER_HOME))
}

function hasZoneRows(rollups: FleetRollups): boolean {
  return ZONE_ORDER.some((zone) => rollups.zones[zone] !== undefined)
}

/**
 * Homes per load zone, without one entry per home.
 * Persisted GET /v1/fleet/rollups wins when it has South/North/West/Houston rows.
 * A missing body keeps the same `index % 4` rule as today's map dots.
 */
export function zoneAggregates(tick: TickView, rollups?: FleetRollups | null): ZoneAggregate[] {
  if (rollups != null && hasZoneRows(rollups)) {
    return ZONE_ORDER.map((zone) => fromZoneRow(zone, rollups.zones[zone]))
  }
  return fromIndexMod4(tick)
}

export function zoneAggregate(tick: TickView, zone: ZoneName, rollups?: FleetRollups | null): ZoneAggregate | undefined {
  return zoneAggregates(tick, rollups).find((item) => item.zone === zone)
}

function share(total: number, parts: readonly number[]): number[] {
  const weight = parts.reduce((sum, part) => sum + part, 0)
  if (total <= 0 || weight <= 0) {
    return parts.map(() => 0)
  }
  const capped = Math.min(total, weight)
  const raw = parts.map((part) => (capped * part) / weight)
  const ints = raw.map((value) => Math.floor(value))
  let leftover = capped - ints.reduce((sum, value) => sum + value, 0)
  const order = raw.map((_, index) => index).sort((a, b) => raw[b] - ints[b] - (raw[a] - ints[a]))
  for (const index of order) {
    if (leftover <= 0) {
      break
    }
    const part = parts[index] ?? 0
    const taken = ints[index] ?? 0
    if (taken < part) {
      ints[index] = taken + 1
      leftover -= 1
    }
  }
  return ints
}

function clustersFor(zone: ZoneName, clusters: NonNullable<FleetRollups["clusters"]>): NonNullable<FleetRollups["clusters"]> {
  const named = clusters.filter((item) => item.zone === zone)
  if (named.length > 0) {
    return named
  }
  return DEFAULT_CLUSTERS.filter((item) => item.zone === zone)
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

function pointNear(
  zone: ZoneName,
  clusterIndex: number,
  lng: number,
  lat: number,
  index: number,
): { lng: number; lat: number } {
  const random = mulberry32((Math.imul(index + 1, 0x27d4eb2d) ^ 0x4552434f) >>> 0)
  const box = cityWeightBoxes(zone)[clusterIndex]
  if (box !== undefined) {
    return {
      lng: box.minLng + random() * (box.maxLng - box.minLng),
      lat: box.minLat + random() * (box.maxLat - box.minLat),
    }
  }
  return { lng: lng + (random() - 0.5) * 0.08, lat: lat + (random() - 0.5) * 0.06 }
}

function sampleNodes(
  zones: readonly ZoneAggregate[],
  clusters: NonNullable<FleetRollups["clusters"]>,
  cap: number,
): HomeNode[] {
  const cells: { zone: ZoneName; status: HomeState; count: number }[] = []
  for (const row of zones) {
    for (const status of HOME_STATES) {
      cells.push({ zone: row.zone, status, count: row[status] })
    }
  }
  const allocated = share(cap, cells.map((cell) => cell.count))
  const nodes: HomeNode[] = []
  let index = 0
  cells.forEach((cell, cellIndex) => {
    const take = allocated[cellIndex] ?? 0
    const spots = clustersFor(cell.zone, clusters)
    for (let step = 0; step < take; step += 1) {
      const slot = step % spots.length
      const spot = spots[slot] ?? spots[0]
      const point = pointNear(cell.zone, slot, spot?.lng ?? 0, spot?.lat ?? 0, index)
      nodes.push({
        index,
        zone: cell.zone,
        status: cell.status,
        lng: point.lng,
        lat: point.lat,
      })
      index += 1
    }
  })
  return nodes
}

/**
 * At most MAX_VISIBLE_POINTS dots. Rollup bodies paint from zone counts and cluster
 * centroids. A missing fetch keeps today's homeNodes path when the tape is small.
 */
export function visibleHomeNodes(
  tick: TickView,
  polygons: readonly ZonePolygon[],
  rollups?: FleetRollups | null,
): HomeNode[] {
  if (rollups == null || !hasZoneRows(rollups)) {
    const counts = fleetCounts(tick)
    const total = HOME_STATES.reduce((sum, state) => sum + counts[state], 0)
    if (total <= MAX_VISIBLE_POINTS) {
      return homeNodes(tick, polygons)
    }
    return sampleNodes(fromIndexMod4(tick), DEFAULT_CLUSTERS, MAX_VISIBLE_POINTS)
  }
  const zones = zoneAggregates(tick, rollups)
  const total = zones.reduce((sum, zone) => sum + zone.homes, 0)
  const clusters = rollups.clusters != null && rollups.clusters.length > 0 ? rollups.clusters : DEFAULT_CLUSTERS
  return sampleNodes(zones, clusters, Math.min(MAX_VISIBLE_POINTS, total))
}
