import type { FlowRequest } from "./api"
import type {
  ActiveAlert,
  BatteryState,
  FlowCounty,
  FlowHome,
  FlowZoneRow,
  NamedCounty,
  Provenance,
  SessionState,
} from "./types"

export type Point = [number, number]
export type ZoneShape = { zone: string; path: string; centroid: Point }

export const VIEW_W = 640
export const VIEW_H = 600
// The map sits under the grid node, which lives in the top band.
const MAP_TOP = 120
const PAD = 16
// Bounds of geo/ercot-load-zones.json (approximate rings, not survey lines).
const LON: [number, number] = [-106.62, -93.52]
const LAT: [number, number] = [25.88, 36.5]
const LON_SCALE = Math.cos((31 * Math.PI) / 180)

export const GRID_NODE: Point = [VIEW_W / 2, 56]

/** Equirectangular, scaled by cos(31°) so Texas keeps its shape, fitted under the grid band. */
export function project(lon: number, lat: number): Point {
  const spanX = (LON[1] - LON[0]) * LON_SCALE
  const spanY = LAT[1] - LAT[0]
  const scale = Math.min((VIEW_W - 2 * PAD) / spanX, (VIEW_H - MAP_TOP - PAD) / spanY)
  const offsetX = (VIEW_W - spanX * scale) / 2
  return [offsetX + (lon - LON[0]) * LON_SCALE * scale, MAP_TOP + (LAT[1] - lat) * scale]
}

/** Area centroid of a projected ring (falls back to the vertex mean for a degenerate ring). */
export function centroid(points: Point[]): Point {
  let area = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < points.length; i += 1) {
    const [x0, y0] = points[i]
    const [x1, y1] = points[(i + 1) % points.length]
    const cross = x0 * y1 - x1 * y0
    area += cross
    cx += (x0 + x1) * cross
    cy += (y0 + y1) * cross
  }
  if (Math.abs(area) < 1e-9) {
    const n = Math.max(points.length, 1)
    return [points.reduce((s, p) => s + p[0], 0) / n, points.reduce((s, p) => s + p[1], 0) / n]
  }
  return [cx / (3 * area), cy / (3 * area)]
}

type GeoFeature = { properties?: { zone?: unknown }; geometry?: { type?: string; coordinates?: unknown } }

/** Zone outlines from the GeoJSON the Vite server already serves at /geo/ercot-load-zones.json. */
export function zoneShapes(geo: unknown): ZoneShape[] {
  const features = (geo as { features?: GeoFeature[] } | null)?.features ?? []
  const shapes: ZoneShape[] = []
  for (const feature of features) {
    const zone = feature.properties?.zone
    const coords = feature.geometry?.coordinates as number[][][] | undefined
    if (typeof zone !== "string" || feature.geometry?.type !== "Polygon" || !coords?.[0]) continue
    const points = coords[0].map(([lon, lat]) => project(lon, lat))
    const path = `M${points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L")} Z`
    shapes.push({ zone, path, centroid: centroid(points) })
  }
  return shapes
}

/** Curved line from a zone up to the grid node, bowed sideways so four lines do not overlap. */
export function flowPath(from: Point, to: Point = GRID_NODE): string {
  const midX = (from[0] + to[0]) / 2 + (from[0] - to[0]) * 0.25
  const midY = (from[1] + to[1]) / 2
  return `M${from[0].toFixed(1)} ${from[1].toFixed(1)} Q${midX.toFixed(1)} ${midY.toFixed(1)} ${to[0].toFixed(1)} ${to[1].toFixed(1)}`
}

export type FlowDirection = "export" | "import" | "idle" | "down"

/** Which way power moves on a zone's line this tick. Net of selling and charging. */
export function flowDirection(row: FlowZoneRow | undefined): FlowDirection {
  if (!row) return "idle"
  if (row.grid_down) return "down"
  const net = row.selling_mw - row.charging_mw
  if (Math.abs(net) < 1e-6) return "idle"
  return net > 0 ? "export" : "import"
}

/** Stroke width and dash speed from MW, relative to the zone's pack cap. More MW, thicker and faster. */
export function flowStroke(mw: number, capMw: number): { width: number; seconds: number } {
  const frac = capMw > 0 ? Math.min(1, Math.max(0, Math.abs(mw) / capMw)) : 0
  const eased = Math.sqrt(frac)
  return { width: 1.5 + 6.5 * eased, seconds: 2.4 - 1.8 * eased }
}

export const BATTERY_LABEL: Record<BatteryState, string> = {
  selling: "Selling to grid",
  charging: "Charging from grid",
  holding: "Holding",
  reserved: "Reserved for backup",
  at_floor: "At floor, nothing left to sell",
  below_floor: "Under floor: never sells, refills from the grid at any price",
  islanded: "Grid down, backing up home",
  unconfirmed: "No reply yet",
  stale: "Stale data",
  dead: "Offline",
}

/** DESIGN.md color roles: OK sells, Ink charges, Reserved keeps backup, Stale/Dead are not dispatched. */
export const BATTERY_COLOR: Record<BatteryState, string> = {
  selling: "var(--ok)",
  charging: "var(--ink)",
  holding: "var(--muted)",
  reserved: "var(--reserved)",
  at_floor: "var(--reserved)",
  below_floor: "var(--warn)",
  islanded: "var(--dead)",
  unconfirmed: "var(--stale)",
  stale: "var(--stale)",
  dead: "var(--dead)",
}

export type ContributionPart = "selling" | "charging" | "reserved" | "idle" | "down"

export const CONTRIBUTION_ORDER: ContributionPart[] = ["selling", "charging", "reserved", "idle", "down"]

const CONTRIBUTION_OF: Record<BatteryState, ContributionPart> = {
  selling: "selling",
  charging: "charging",
  reserved: "reserved",
  at_floor: "reserved",
  below_floor: "reserved",
  holding: "idle",
  unconfirmed: "idle",
  stale: "idle",
  dead: "idle",
  islanded: "down",
}

export const CONTRIBUTION_LABEL: Record<ContributionPart, string> = {
  selling: "Selling",
  charging: "Charging",
  reserved: "Keeping backup (floor)",
  idle: "Holding, unheard, or offline",
  down: "Grid down",
}

export const CONTRIBUTION_COLOR: Record<ContributionPart, string> = {
  selling: "var(--ok)",
  charging: "var(--ink)",
  reserved: "var(--reserved)",
  idle: "var(--line)",
  down: "var(--dead)",
}

/** A zone's homes grouped by what they give the grid this tick. Counts sum to row.homes. */
export function contributionParts(row: FlowZoneRow | undefined): Record<ContributionPart, number> {
  const parts: Record<ContributionPart, number> = { selling: 0, charging: 0, reserved: 0, idle: 0, down: 0 }
  if (!row) return parts
  for (const [state, count] of Object.entries(row.states) as [BatteryState, number][]) {
    parts[CONTRIBUTION_OF[state] ?? "idle"] += count
  }
  return parts
}

/** The zone's share of the fleet's confirmed delivery this tick, or null when the fleet sold nothing. */
export function deliveryShare(zone: string, zones: Partial<Record<string, FlowZoneRow>>): number | null {
  const total = Object.values(zones).reduce((sum, row) => sum + (row?.selling_mw ?? 0), 0)
  if (total <= 0) return null
  return (zones[zone]?.selling_mw ?? 0) / total
}

export const REASON_LABEL: Record<string, string> = {
  normal: "Base floor",
  storm_risk_high: "ERCOT outage rule HIGH",
  weather_alert: "NWS weather alert",
  signal_unavailable: "Outage report unreadable (fail safe)",
  not_in_alert: "County not named by the alert (base floor)",
}

export function reasonLabel(code: string | null | undefined): string {
  if (!code) return "No reason"
  return REASON_LABEL[code] ?? code.replace(/_/g, " ")
}

/** "floor 60% (NWS weather alert)", or "floor 30–60% by county (...)" when the alert names only some of the zone's counties. */
export function zoneFloorText(row: FlowZoneRow, homes: FlowHome[]): string {
  const low = homes.length ? Math.min(...homes.map((home) => home.floor_pct)) : row.reserve_pct
  const pct = low < row.reserve_pct ? `${low}–${row.reserve_pct}% by county` : `${row.reserve_pct}%`
  return `floor ${pct} (${reasonLabel(row.reason)})`
}

export type CountyGroup = { fips: string; name: string; homes: FlowHome[] }

/** A zone's homes by county, in roster order. Homes with no county (older worker) share one group with fips "". */
export function countyGroups(homes: FlowHome[], counties: FlowCounty[]): CountyGroup[] {
  const byFips = new Map<string, FlowHome[]>()
  for (const home of homes) {
    const fips = home.county ?? ""
    byFips.set(fips, [...(byFips.get(fips) ?? []), home])
  }
  const rostered = counties.map((county) => county.fips).filter((fips) => byFips.has(fips))
  const others = [...byFips.keys()].filter((fips) => !rostered.includes(fips))
  return [...rostered, ...others].map((fips) => {
    const members = byFips.get(fips) ?? []
    const name = counties.find((county) => county.fips === fips)?.name ?? members[0]?.county_name ?? fips
    return { fips, name, homes: members }
  })
}

const FLEET_REASONS = new Set(["storm_risk_high", "signal_unavailable"])

const ALERT_COUNTY_WORDS: Record<string, string> = {
  weather_alert: "named in alert",
  not_in_alert: "not named",
}

/** "named in alert · floor 60%" or "not named · floor 30%". A fleet-wide reason (ERCOT HIGH, no signal) outranks the alert. */
export function countyFloorNote(group: CountyGroup, zoneReason: string | undefined): string {
  const home = group.homes[0]
  if (!home) return ""
  const floor = `floor ${home.floor_pct}%`
  const reason = zoneReason && FLEET_REASONS.has(zoneReason) ? zoneReason : home.floor_reason ?? zoneReason
  const words = reason ? ALERT_COUNTY_WORDS[reason] : undefined
  return words ? `${words} · ${floor}` : `${floor} · ${reasonLabel(reason)}`
}

/** The roster counties an alert names, in the roster order the worker sends. */
export function alertCountyRows(alert: ActiveAlert): NamedCounty[] {
  return alert.named_counties ?? []
}

export function fmtMw(mw: number | null | undefined, digits = 3): string {
  return typeof mw === "number" && Number.isFinite(mw) ? `${mw.toFixed(digits)} MW` : "n/a"
}

export function fmtKw(kw: number): string {
  const sign = kw > 0.0005 ? "+" : kw < -0.0005 ? "−" : ""
  return `${sign}${Math.abs(kw).toFixed(1)} kW`
}

export function fmtUsd(price: number | null | undefined): string {
  return typeof price === "number" && Number.isFinite(price) ? `$${price.toFixed(2)}/MWh` : "no price"
}

/** "2024-01-15T13:35:00-06:00" → "Jan 15 13:35 CT", read from the string so no timezone shift. */
export function fmtScenarioTime(ts: string | null | undefined): string {
  if (!ts) return "n/a"
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(ts)
  if (!match) return ts
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  const offset = ts.endsWith("-06:00") ? " CST" : ts.endsWith("-05:00") ? " CDT" : ""
  return `${months[Number(match[2]) - 1]} ${Number(match[3])}, ${match[1]} ${match[4]}:${match[5]}${offset}`
}

export function timeLapseLabel(speed: number, tickMinutes: number): string {
  const seconds = (tickMinutes * 60) / speed
  return `x${speed} time-lapse · ${tickMinutes} min per ${seconds < 1 ? seconds.toFixed(1) : seconds.toFixed(0)} s`
}

function hoursText(hours: number): string {
  const minutes = Math.round(hours * 60)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? `${h} h ${m} min` : `${m} min`
}

/** The honest comparison: a home pack at its real kW next to a 250 kW Supercharger. */
export function chargeSpeedCaption(kwh: number, kw: number): string {
  if (!(kwh > 0 && kw > 0)) return ""
  return `Empty to full at ${kw} kW takes ${hoursText(kwh / kw)} for a ${kwh} kWh pack. ` +
    `A 250 kW Supercharger would move the same ${kwh} kWh in ${hoursText(kwh / 250)}; ` +
    "a home battery cannot take that rate, so this page speeds up time instead."
}

export type WeatherStep = "none" | "alert" | "alert_grid_down"

export const WEATHER_STEP_LABEL: Record<WeatherStep, string> = {
  none: "No alert",
  alert: "Alert",
  alert_grid_down: "Alert + grid down",
}

/**
 * The alert the picker sends: the operator's pick when this scenario offers it, else the first
 * alert not yet sent. A pick left over from an earlier scenario is dropped, or the worker refuses it.
 */
export function chosenAlertId(offered: Array<{ id: string }>, sentIds: Set<string>, picked: string): string {
  if (offered.some((alert) => alert.id === picked)) return picked
  return offered.find((alert) => !sentIds.has(alert.id))?.id ?? ""
}

type StepState = Pick<SessionState, "alerts" | "grid_down_zones" | "scenario">

/** The step the session is on, read from the worker's state, never from a local guess. */
export function currentWeatherStep(state: StepState): WeatherStep {
  if (state.grid_down_zones.length) return "alert_grid_down"
  return state.alerts.length ? "alert" : "none"
}

/**
 * The existing alert and grid-down requests that move the session to `target`, or a reason it
 * cannot. A sent alert stays until its archived expiry, so "none" is out of reach once one is sent.
 * Grid down covers the zones of the sent alerts, or of `alertId` when none is sent yet.
 */
export function weatherStepRequests(target: WeatherStep, state: StepState, alertId: string):
  { requests: FlowRequest[] } | { blocked: string } {
  const down = state.grid_down_zones
  const restore: FlowRequest[] = down.map((zone) => ({ kind: "grid-down", body: { zone, down: false } }))
  if (target === "none") {
    if (state.alerts.length) return { blocked: "A sent alert stays until it expires. Reshuffle batteries to start over." }
    return { requests: restore }
  }
  const sendAlert: FlowRequest[] = []
  let zones = state.alerts.flatMap((alert) => alert.zones)
  if (!state.alerts.length) {
    const chosen = state.scenario?.alerts.find((alert) => alert.id === alertId)
    if (!chosen) return { blocked: "This scenario has no archived alert to send." }
    sendAlert.push({ kind: "alert", body: { alert_id: chosen.id } })
    zones = chosen.zones ?? []
  }
  if (target === "alert") return { requests: [...sendAlert, ...restore] }
  const newlyDown = [...new Set(zones)].filter((zone) => !down.includes(zone)).sort()
  if (!newlyDown.length && !down.length) return { blocked: "The alert names no load zone to put grid down." }
  return { requests: [...sendAlert, ...newlyDown.map((zone): FlowRequest => ({ kind: "grid-down", body: { zone, down: true } }))] }
}

export function zoneCapMw(homes: number, packKw: number): number {
  return (homes * packKw) / 1000
}

export type VerifyResult = { ok: boolean; lines: string[] }

/** Tape vs a fresh GET /v1/scenario/verify at the same clock: posting stamp and each zone price must agree. */
export function compareWithArchive(provenance: Provenance, reply: unknown): VerifyResult {
  const body = (reply ?? {}) as { posted_at?: unknown; interval_ending?: unknown; zone_prices?: unknown; brief?: unknown }
  if (typeof body.posted_at !== "string") {
    return { ok: false, lines: [typeof body.brief === "string" ? body.brief : "Supabase archive did not answer"] }
  }
  const lines: string[] = []
  let ok = true
  const tapePosted = provenance.posting?.posted_at ?? null
  if (tapePosted) {
    const same = tapePosted === body.posted_at
    ok &&= same
    lines.push(`Posting ${same ? "matches" : "differs"}: tape ${tapePosted}, Supabase ${body.posted_at}`)
  }
  const live = (body.zone_prices ?? {}) as Record<string, unknown>
  for (const [zone, tapePrice] of Object.entries(provenance.zone_prices.zones)) {
    const livePrice = Number(live[zone])
    const same = Number.isFinite(livePrice) && Math.abs(livePrice - tapePrice) < 0.005
    ok &&= same
    lines.push(`${zone} ${same ? "matches" : "differs"}: tape ${fmtUsd(tapePrice)}, Supabase ${fmtUsd(Number.isFinite(livePrice) ? livePrice : null)}`)
  }
  if (lines.length === 0) return { ok: false, lines: ["Nothing to compare on this tick"] }
  if (typeof body.interval_ending === "string") lines.push(`Price interval ending ${body.interval_ending} CT`)
  return { ok, lines }
}
