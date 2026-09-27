/**
 * Pure model for the /fleet battery grid (mockup/Fleet.dc.html): one shape for both sources,
 * filters and counts, short labels, cell geometry and colours. No React, no fetch.
 * Honesty: a missing charge, floor or zone stays null and is shown as "Not reported".
 */
import type { FlowHome } from "../flow/types"
import { hrefForUrlState, readUrlState } from "../shell/urlState"

export const NOT_REPORTED = "Not reported"

/** Mockup order, left to right. */
export const GRID_ZONES = ["North", "Houston", "West", "South"] as const
export type GridZone = (typeof GRID_ZONES)[number]
export const NO_ZONE = "Zone not reported"

/** live, stale, offline (dead), or other (unconfirmed or a status this page does not know). */
export type GridStatus = "live" | "stale" | "offline" | "other"
export type GridAction = "selling" | "charging" | "full" | "holding" | "islanded" | "reserved" | "unconfirmed"

export type GridHome = {
  id: string
  zone: GridZone | null
  status: GridStatus
  /** The status text the source sent, for the detail panel. */
  rawStatus: string
  socPct: number | null
  floorPct: number | null
  /** Positive sells, negative charges. Null when not reported. */
  kw: number | null
  /** What the battery is doing, only for a home whose reading is current. */
  action: GridAction | null
}

export type SourceKey = "live" | "scenario"
export type FilterKey = "all" | "live" | "stale" | "offline" | "below"

export const FILTERS: Array<[FilterKey, string]> = [
  ["all", "All"], ["live", "Live"], ["stale", "Stale"], ["offline", "Offline"], ["below", "Under floor"],
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function zoneOf(value: unknown): GridZone | null {
  return GRID_ZONES.find((z) => z === value) ?? null
}

function statusOf(raw: string): GridStatus {
  if (raw === "live") return "live"
  if (raw === "stale") return "stale"
  if (raw === "dead" || raw === "offline") return "offline"
  return "other"
}

function pctOf(kwh: number | null, capacity: number | null): number | null {
  if (kwh === null || capacity === null || capacity <= 0) return null
  return (kwh / capacity) * 100
}

const LIVE_ACTIONS: Record<string, GridAction> = {
  DISCHARGING: "selling", CHARGING: "charging", FULL: "full", HOLDING: "holding", EMPTY: "holding",
}

/** GET /v1/homes rows. Floor is floor_kwh / capacity_kwh, charge is soc_kwh / capacity_kwh. */
export function fromLiveRows(body: unknown): GridHome[] {
  if (!Array.isArray(body)) return []
  const out: GridHome[] = []
  for (const row of body) {
    if (!isRecord(row) || typeof row.home_id !== "string" || row.home_id === "") continue
    const rawStatus = typeof row.status === "string" ? row.status : ""
    const status = statusOf(rawStatus)
    const capacity = num(row.capacity_kwh)
    const cs = typeof row.charge_state === "string" ? LIVE_ACTIONS[row.charge_state] ?? null : null
    out.push({
      id: row.home_id,
      zone: zoneOf(row.zone),
      status,
      rawStatus,
      socPct: pctOf(num(row.soc_kwh), capacity),
      floorPct: pctOf(num(row.floor_kwh), capacity),
      kw: num(row.power_kw),
      action: status === "live" ? cs : null,
    })
  }
  return out
}

/** Engine BatteryState (server/engine/scenario.py home_state) to what the cell shows. Unknown states stay null. */
const SCENARIO_ACTIONS: Record<string, GridAction> = {
  selling: "selling",
  charging: "charging",
  holding: "holding",
  at_floor: "holding",
  below_floor: "holding",
  islanded: "islanded",
  reserved: "reserved",
  unconfirmed: "unconfirmed",
}

/** Scenario session homes (SessionState.homes). */
export function fromScenarioHomes(homes: FlowHome[]): GridHome[] {
  return homes.filter((h) => isRecord(h) && typeof h.id === "string").map((h) => {
    const rawStatus = typeof h.status === "string" ? h.status : ""
    const status = statusOf(rawStatus)
    const action = status === "live" ? SCENARIO_ACTIONS[h.state as string] ?? null : null
    return {
      id: h.id,
      zone: zoneOf(h.zone),
      status,
      rawStatus,
      socPct: num(h.soc_pct),
      floorPct: num(h.floor_pct),
      kw: num(h.kw),
      action,
    }
  })
}

/** Only a live home whose reported charge is below its reported floor. */
export function isUnderFloor(h: GridHome): boolean {
  return h.status === "live" && h.socPct !== null && h.floorPct !== null && h.socPct < h.floorPct
}

export function matchesFilter(h: GridHome, f: FilterKey): boolean {
  if (f === "all") return true
  if (f === "below") return isUnderFloor(h)
  return h.status === f
}

export function filterCounts(homes: GridHome[]): Record<FilterKey, number> {
  const counts: Record<FilterKey, number> = { all: 0, live: 0, stale: 0, offline: 0, below: 0 }
  for (const h of homes) {
    for (const [k] of FILTERS) if (matchesFilter(h, k)) counts[k] += 1
  }
  return counts
}

export function shortId(id: string): string {
  return id.startsWith("home-") ? id.slice(5) : id
}

export function pctLabel(h: GridHome): string {
  if (h.status === "offline") return "off"
  return h.socPct === null ? NOT_REPORTED : `${Math.round(h.socPct)}%`
}

export function statusLabel(h: GridHome): string {
  if (h.status === "live") return "Live"
  if (h.status === "stale") return "Stale"
  if (h.status === "offline") return "Offline"
  if (h.rawStatus === "") return NOT_REPORTED
  return h.rawStatus.charAt(0).toUpperCase() + h.rawStatus.slice(1)
}

function kwText(kw: number | null): string {
  return kw === null ? "" : ` ${Math.abs(kw).toFixed(1)}`
}

/** Short state, as in the mockup's short(h). */
export function shortState(h: GridHome): string {
  if (h.status === "offline") return "Offline"
  if (h.status === "stale") return "No reading"
  if (h.status === "other") return statusLabel(h)
  if (h.action === "selling") return `Selling${kwText(h.kw)}`
  if (h.action === "charging") return `Charging${kwText(h.kw)}`
  if (h.action === "full") return "Full"
  if (h.action === "islanded") return "Islanded"
  if (h.action === "reserved") return "Reserved"
  if (h.action === "unconfirmed") return "Not confirmed"
  if (isUnderFloor(h)) return "Under floor"
  if (h.action === "holding") return "Holding"
  return NOT_REPORTED
}

/** "Right now" line for the detail panel, as in the mockup's now(h). */
export function nowText(h: GridHome): string {
  if (h.status === "offline") return "Offline, gets no work"
  if (h.status === "stale") return "No reading"
  if (h.status === "other") return statusLabel(h)
  const kw = h.kw === null ? "" : `${kwText(h.kw)} kW`
  if (h.action === "selling") return `Selling${kw}`
  if (h.action === "charging") return `Charging${kw}`
  if (h.action === "full") return "Full, holding"
  if (h.action === "islanded") return "Islanded: backing up its own home"
  if (h.action === "reserved") return "Reserved for backup"
  if (h.action === "unconfirmed") return "Order not confirmed"
  if (isUnderFloor(h)) return "Under its floor, holding"
  if (h.action === "holding") return "Holding"
  return NOT_REPORTED
}

// The inner well is 26 × 50 at (5, 5) in the 36 × 60 cell; its bottom is y = 55.
const WELL_BOTTOM = 55
const WELL_H = 50
const clampPct = (p: number) => Math.min(100, Math.max(0, p))

export type CellGeometry = { fillY: number | null; fillH: number | null; floorY: number | null }

export function cellGeometry(h: GridHome): CellGeometry {
  let fillY: number | null = null
  let fillH: number | null = null
  if (h.status !== "offline" && h.socPct !== null) {
    fillH = Math.max(3, (clampPct(h.socPct) * WELL_H) / 100)
    fillY = WELL_BOTTOM - fillH
  }
  const floorY = h.floorPct === null ? null : WELL_BOTTOM - (clampPct(h.floorPct) * WELL_H) / 100
  return { fillY, fillH, floorY }
}

export type CellLook = {
  fill: string
  shell: string
  well: string
  edge: string
  dash: string
  word: string
  wordEdge: string
}

export function fillColor(h: GridHome): string {
  if (h.status !== "live") return "var(--rg-not-counted)"
  if (h.action === "selling") return "var(--rg-order-way)"
  if (h.action === "charging") return "var(--rg-charging)"
  // Islanded is a battery rightly backing up its own home in an outage: never the red "lost" colour.
  if (h.action === "islanded") return "var(--rg-islanded)"
  if (h.action === "reserved") return "var(--rg-fleet-reserved)"
  if (h.action === "unconfirmed") return "var(--rg-not-counted)"
  if (isUnderFloor(h)) return "var(--rg-fleet-under)"
  if (h.action === null) return "var(--rg-not-counted)"
  // "Charge above its floor" needs a reported floor; without one the fill stays neutral.
  if (h.floorPct === null) return "var(--rg-not-counted)"
  return "var(--rg-confirmed)"
}

export function cellLook(h: GridHome): CellLook {
  const off = h.status === "offline"
  const stale = h.status === "stale"
  return {
    fill: fillColor(h),
    shell: off ? "var(--rg-fleet-off-shell)" : "var(--rg-fleet-shell)",
    well: off ? "var(--rg-fleet-off-well)" : "var(--rg-clay-tile)",
    edge: stale ? "var(--rg-fleet-stale-edge)" : off ? "var(--rg-fleet-off-well)" : "var(--rg-fleet-edge)",
    dash: stale ? "4 3" : "none",
    word: off ? "var(--rg-fleet-off-word)" : "var(--rg-surface)",
    wordEdge: off ? "var(--rg-fleet-off-well)" : "var(--rg-fleet-word-edge)",
  }
}

export type ZoneBank = { key: string; name: string; zone: GridZone | null; homes: GridHome[]; note: string }

export function bankNote(homes: GridHome[]): string {
  const off = homes.filter((h) => h.status !== "live").length
  const under = homes.filter(isUnderFloor).length
  return `${off ? `${off} not answering, ` : ""}${under} under floor`
}

/** Four zone banks in mockup order, plus one for homes with no zone so the counts add up. */
export function zoneBanks(homes: GridHome[]): ZoneBank[] {
  const banks: ZoneBank[] = GRID_ZONES.map((zone) => {
    const zh = homes.filter((h) => h.zone === zone)
    return { key: zone, name: zone, zone, homes: zh, note: bankNote(zh) }
  })
  const loose = homes.filter((h) => h.zone === null)
  if (loose.length) banks.push({ key: "none", name: NO_ZONE, zone: null, homes: loose, note: bankNote(loose) })
  return banks
}

/** Exact id, then home number (7, 007), then the first id that contains the text. */
export function findHome(homes: GridHome[], query: string): GridHome | null {
  const q = query.trim().toLowerCase()
  if (q === "") return null
  const exact = homes.find((h) => h.id.toLowerCase() === q)
  if (exact) return exact
  if (/^\d+$/.test(q)) {
    const id = `home-${q.padStart(3, "0")}`
    const byNumber = homes.find((h) => h.id === id)
    if (byNumber) return byNumber
  }
  return homes.find((h) => h.id.toLowerCase().includes(q)) ?? null
}

export function replayHref(h: GridHome): string {
  return hrefForUrlState("/", { scenario: null, zone: h.zone, home: h.id, tick: null })
}

export function floorLegend(homes: GridHome[]): string {
  const floors = homes.map((h) => h.floorPct).filter((f): f is number => f !== null).map((f) => Math.round(f))
  if (!floors.length) return "Backup floor, not reported"
  const lo = Math.min(...floors)
  const hi = Math.max(...floors)
  return lo === hi ? `Backup floor, ${lo}% now` : `Backup floor, ${lo}% to ${hi}% now`
}

export function floorText(h: GridHome): string {
  return h.floorPct === null ? NOT_REPORTED : `${Math.round(h.floorPct)}%`
}

export function chargeText(h: GridHome): string {
  return h.socPct === null ? NOT_REPORTED : `${Math.round(h.socPct)}%`
}

export function tileAria(h: GridHome): string {
  return `${h.id}, ${nowText(h)}, charge ${chargeText(h)}`
}

export function homesTitle(n: number): string {
  return n === 1 ? "1 home" : `${n} homes`
}

/** The ?zone= the grid scrolls to and highlights, when it names one of the four zones. */
export function focusZoneFromSearch(search: string): GridZone | null {
  return zoneOf(readUrlState(search).zone)
}

/** GET /v1/homes answers at most 200 rows; say so when the page is full. */
export const LIVE_LIMIT = 200

export function liveSourceNote(n: number): string {
  return n >= LIVE_LIMIT
    ? `Live homes from the local API (GET /v1/homes), the first ${LIVE_LIMIT} only.`
    : "Live homes from the local API (GET /v1/homes)."
}

export function scenarioSourceNote(state: {
  scenario: { name: string } | null
  tick_index: number
  tick_count: number
  status: string
}): string {
  if (state.scenario === null) return "Scenario: none started yet."
  return `Scenario: ${state.scenario.name}, tick ${state.tick_index} of ${state.tick_count}, ${state.status}.`
}

/** Homes counted under All only (not live, stale or offline), so the filter counts visibly add up. */
export function otherNote(homes: GridHome[]): string | null {
  const counts = new Map<string, number>()
  for (const h of homes) {
    if (h.status !== "other") continue
    const label = statusLabel(h).toLowerCase()
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  if (!counts.size) return null
  return `${[...counts].map(([label, n]) => `${n} ${label}`).join(", ")}, shown under All`
}

/** "http 500: <brief or detail>" from an error reply body, when the server sent words. */
export function errorText(status: number, body: unknown): string {
  const words = isRecord(body)
    ? [body.brief, body.detail, body.error].find((v): v is string => typeof v === "string" && v.trim() !== "")
    : undefined
  return words ? `http ${status}: ${words}` : `http ${status}`
}
