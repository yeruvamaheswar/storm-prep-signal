import type { BatteryState, FlowHome, FlowTick, FlowZoneRow, OrderTimelineEntry } from "../flow/types"
import { errorText, fleetLabel, liveFleetNote, readHomesSource } from "../fleetgrid/fleetModel"
import { NOT_REPORTED } from "../replay/format"
import { HOLD_T, fmtClock, playheadSeconds } from "../replay/tickClock"

/** Pure mapping for the Live page (Task 9 part 2): GET /v1/snapshot, /v1/live/orders, /v1/homes, /v1/fleet/rollups
 * and the run's settings into the shapes the Replay components take. Nothing is invented: a missing field stays
 * missing and shows "Not reported". */

export { NOT_REPORTED }

type Json = Record<string, unknown>

export type SnapshotState = { kind: "loading" } | { kind: "error"; brief: string } | { kind: "ready"; value: Json }

export type OrdersState =
  | { kind: "loading" }
  | { kind: "none"; brief: string }
  | { kind: "error"; brief: string }
  | { kind: "ready"; tick: number | null; ts: string | null; orders: Record<string, OrderTimelineEntry[]> }

/** From the run file's `settings` (GET /v1/runs/latest). Undefined when the run does not say. */
export type RunSettings = { tickMinutes?: number; baseFloorPct?: number }

export type LiveHomes = { homes: FlowHome[]; note: string; fleetSize: number | null }

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

// --- replies ---

export function snapshotFromReply(status: number, body: unknown): SnapshotState {
  if (status < 200 || status >= 300) return { kind: "error", brief: errorText(status, body) }
  if (!isRecord(body)) return { kind: "error", brief: "the snapshot reply was not an object" }
  return { kind: "ready", value: body }
}

const NO_ORDERS_BRIEF = "No tick has written its orders yet."

function timeline(value: unknown): OrderTimelineEntry[] | null {
  if (!Array.isArray(value)) return null
  const out = value.filter((entry): entry is OrderTimelineEntry =>
    Array.isArray(entry) && num(entry[0]) !== undefined && typeof entry[1] === "string")
  return out.length ? out : null
}

/** GET /v1/live/orders. A 404 (no tick wrote the file yet, or the read met a write) is "no orders yet". */
export function ordersFromReply(status: number, body: unknown): OrdersState {
  if (status === 404) return { kind: "none", brief: (isRecord(body) && text(body.brief)) || NO_ORDERS_BRIEF }
  if (status < 200 || status >= 300) return { kind: "error", brief: errorText(status, body) }
  if (!isRecord(body) || !isRecord(body.orders)) return { kind: "error", brief: "the orders reply had no orders" }
  const orders: Record<string, OrderTimelineEntry[]> = {}
  for (const [id, raw] of Object.entries(body.orders)) {
    const kept = timeline(raw)
    if (kept) orders[id] = kept
  }
  return { kind: "ready", tick: num(body.tick) ?? null, ts: text(body.ts) ?? null, orders }
}

export function settingsFromRun(body: unknown): RunSettings {
  const settings = isRecord(body) && isRecord(body.settings) ? body.settings : {}
  return { tickMinutes: num(settings.tick_minutes), baseFloorPct: num(settings.base_reserve_pct) }
}

// --- homes ---

/** scenario.py home_state's band: within half a point of the floor is "at its floor". */
const FLOOR_BAND_PCT = 0.5
const KW_EPS = 1e-6

function pctOf(kwh: number | undefined, capacity: number | undefined): number {
  return kwh !== undefined && capacity !== undefined && capacity > 0 ? (kwh / capacity) * 100 : Number.NaN
}

/** The engine's words (scenario.py home_state) from what the row reports: status, then confirmed kW, then the
 * charge against the floor. A row that reports no charge or floor is just "holding" (it says nothing more). */
function stateOf(status: string, kw: number, soc: number, floor: number): BatteryState {
  if (status === "dead" || status === "offline") return "dead"
  if (status === "stale") return "stale"
  if (status === "unconfirmed") return "unconfirmed"
  if (kw > KW_EPS) return "selling"
  if (kw < -KW_EPS) return "charging"
  if (!Number.isFinite(soc) || !Number.isFinite(floor)) return "holding"
  if (soc < floor - FLOOR_BAND_PCT) return "below_floor"
  if (soc <= floor + FLOOR_BAND_PCT) return "at_floor"
  return "holding"
}

/** One GET /v1/homes row as a Replay home. Missing numbers stay NaN, which every Replay view shows as "Not reported". */
export function flowHomeFromRow(row: unknown): FlowHome | null {
  if (!isRecord(row) || !text(row.home_id) || !text(row.zone)) return null
  const capacity = num(row.capacity_kwh)
  const soc = pctOf(num(row.soc_kwh), capacity)
  const floor = pctOf(num(row.floor_kwh), capacity)
  const kw = num(row.power_kw) ?? Number.NaN
  const status = text(row.status) ?? ""
  const home: FlowHome = {
    id: row.home_id as string,
    zone: row.zone as string,
    soc_pct: soc,
    floor_pct: floor,
    kw,
    state: stateOf(status, Number.isFinite(kw) ? kw : 0, soc, floor),
    status,
  }
  const county = text(row.county)
  const countyName = text(row.county_name)
  if (county) home.county = county
  if (countyName) home.county_name = countyName
  return home
}

export function homesFromReply(body: unknown, headers: { get(name: string): string | null }): LiveHomes {
  const rows = Array.isArray(body) ? body : []
  const homes = rows.map(flowHomeFromRow).filter((home): home is FlowHome => home !== null)
  const src = readHomesSource(headers)
  return { homes, note: liveFleetNote(src, rows.length), fleetSize: src.fleetSize }
}

/** The demo fleet's size: X-Fleet-Size first, then GET /v1/fleet/rollups `n`. Null when neither says. */
export function fleetSizeFrom(headerSize: number | null, rollups: unknown): number | null {
  if (headerSize !== null) return headerSize
  const n = isRecord(rollups) ? num(rollups.n) : undefined
  return n !== undefined && n > 0 ? n : null
}

// --- snapshot into Replay props ---

const TICK_NUMBERS = ["tick", "target_mw", "delivered_mw", "missed_mw", "reserve_pct", "breaches"] as const
const TICK_TEXT = ["ts", "mode", "target_label", "price_label", "policy_reason", "intent", "intent_reason", "brief"] as const

/** The tick fields the promise panel, feed and map read, copied only when the snapshot has them. */
export function liveTick(snapshot: Json | null): Partial<FlowTick> {
  const out: Json = {}
  if (!snapshot) return {}
  for (const key of TICK_NUMBERS) if (num(snapshot[key]) !== undefined) out[key] = snapshot[key]
  for (const key of TICK_TEXT) if (typeof snapshot[key] === "string") out[key] = snapshot[key]
  if (num(snapshot.price_usd_mwh) !== undefined) out.price_usd_mwh = snapshot.price_usd_mwh
  if (typeof snapshot.risk_level === "string") out.risk_level = snapshot.risk_level
  if (Array.isArray(snapshot.reasons)) out.reasons = snapshot.reasons.filter((r) => typeof r === "string")
  if (isRecord(snapshot.zone_reserve_pct)) out.zone_reserve_pct = snapshot.zone_reserve_pct
  if (isRecord(snapshot.zone_reasons)) out.zone_reasons = snapshot.zone_reasons
  return out as Partial<FlowTick>
}

/** Per-zone floor, reason and grid state, from the snapshot's own zone fields. Only what the map reads. */
export function liveZones(snapshot: Json | null): Partial<Record<string, Partial<FlowZoneRow>>> {
  const out: Partial<Record<string, Partial<FlowZoneRow>>> = {}
  if (!snapshot) return out
  const floors = isRecord(snapshot.zone_reserve_pct) ? snapshot.zone_reserve_pct : {}
  const reasons = isRecord(snapshot.zone_reasons) ? snapshot.zone_reasons : {}
  const telemetry = isRecord(snapshot.zone_telemetry) ? snapshot.zone_telemetry : {}
  for (const zone of new Set([...Object.keys(floors), ...Object.keys(reasons), ...Object.keys(telemetry)])) {
    const row: Partial<FlowZoneRow> = {}
    const floor = num(floors[zone])
    const reason = text(reasons[zone])
    const tel = telemetry[zone]
    if (floor !== undefined) row.reserve_pct = floor
    if (reason) row.reason = reason
    if (isRecord(tel) && typeof tel.grid_down === "boolean") row.grid_down = tel.grid_down
    out[zone] = row
  }
  return out
}

// --- the left panel ---

export type InputRow = { key: string; label: string; value: string; unit?: string; tone?: "ok" | "bad" | "warn" }

function mwText(value: number): string {
  return `${Math.round(value).toLocaleString("en-US")} MW`
}

function usdText(value: number): string {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
}

/** "What ERCOT is telling us": only snapshot fields, "Not reported" for any missing one. */
export function inputRows(snapshot: Json): InputRow[] {
  const price = num(snapshot.price_usd_mwh)
  const outage = num(snapshot.outage_mw)
  const line = num(snapshot.threshold_mw)
  const margin = num(snapshot.margin_mw)
  const quality = text(snapshot.quality)
  const marginRow: InputRow = margin === undefined
    ? { key: "margin", label: "Margin to the line", value: NOT_REPORTED }
    : margin > 0
      ? { key: "margin", label: "Over the line by", value: mwText(margin), tone: "warn" }
      : margin < 0
        ? { key: "margin", label: "Under the line by", value: mwText(-margin) }
        : { key: "margin", label: "On the line", value: mwText(0) }
  return [
    price === undefined
      ? { key: "price", label: "Wholesale price", value: NOT_REPORTED }
      : { key: "price", label: "Wholesale price", value: usdText(price), unit: "/MWh" },
    { key: "outage", label: "Power plants offline", value: outage === undefined ? NOT_REPORTED : mwText(outage) },
    { key: "line", label: "Stress line", value: line === undefined ? NOT_REPORTED : mwText(line) },
    marginRow,
    quality === undefined
      ? { key: "check", label: "Data check", value: NOT_REPORTED }
      : quality === "ok"
        ? { key: "check", label: "Data check", value: "Passed", tone: "ok" }
        : { key: "check", label: "Data check", value: `Failed: ${quality.replace(/_/g, " ")}`, tone: "bad" },
  ]
}

function sourceLine(snapshot: Json): string {
  const source = text(snapshot.source)
  const event = text(snapshot.event)
  if (source === "live") return "These are live ERCOT inputs."
  if (source === "archive") return `These ERCOT inputs come from ${event ? `the ${event} archive` : "an archive"}, not live.`
  if (source === "scenario") return "These inputs come from a scenario run, not live ERCOT."
  if (source === "fixture") return "These inputs are sample data, not live ERCOT."
  return "Where these inputs come from is not reported."
}

function labelWords(label: string | undefined, what: "target" | "price"): string | null {
  if (!label || label === "ercot" || label === "none") return null
  if (label === "synthetic") return `The ${what} is a practice number (synthetic).`
  return `The ${what} is labeled ${label}.`
}

/** Real versus simulated, in the words the data carries: the source, the demo fleet and the target and price labels. */
export function provenanceLines(snapshot: Json, fleetSize: number | null): string[] {
  const fleet = fleetSize === null ? "The demo fleet" : `The ${fleetLabel(fleetSize)}`
  const labels = [labelWords(text(snapshot.target_label), "target"), labelWords(text(snapshot.price_label), "price")]
  return [sourceLine(snapshot), [`${fleet} and its orders are simulated.`, ...labels.filter(Boolean)].join(" ")]
}

// --- clocks ---

const CT_TIME = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/Chicago" })
const CT_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "America/Chicago" })

function parseMs(ts: unknown): number | null {
  if (typeof ts !== "string") return null
  const ms = Date.parse(ts)
  return Number.isNaN(ms) ? null : ms
}

/** "12:20 CT", or "Sep 25, 12:00 CT" when `withDay` (another day, or an archive clock). */
export function ctClock(ms: number, withDay = false): string {
  const time = `${CT_TIME.format(ms)} CT`
  return withDay ? `${CT_DAY.format(ms)}, ${time}` : time
}

function sameCtDay(a: number, b: number): boolean {
  return CT_DAY.format(a) === CT_DAY.format(b)
}

export type SourcePill = { text: string; live: boolean }

/** The top-right pill. "Live from ERCOT" only for a live run; every other source says it is not live. */
export function sourcePill(state: SnapshotState, nowMs: number): SourcePill {
  if (state.kind === "loading") return { text: "Reading the ERCOT snapshot", live: false }
  if (state.kind === "error") return { text: "ERCOT snapshot unavailable", live: false }
  const snapshot = state.value
  const source = text(snapshot.source)
  if (source === "live") {
    const at = parseMs(snapshot.ts)
    if (at === null) return { text: "Live from ERCOT, update time not reported", live: true }
    const minutes = Math.floor(Math.max(0, nowMs - at) / 60_000)
    return { text: `Live from ERCOT, updated ${minutes < 1 ? "under a minute" : `${minutes} min`} ago`, live: true }
  }
  if (source === "archive") {
    const event = text(snapshot.event)
    return { text: `ERCOT archive${event ? ` (${event})` : ""}, not live`, live: false }
  }
  if (source === "scenario") return { text: "Scenario run, not live ERCOT", live: false }
  if (source === "fixture") return { text: "Sample data, not live ERCOT", live: false }
  return { text: "Source not reported", live: false }
}

/** The playback bar's first line. The countdown uses the run's own tick_minutes; without it, "Not reported". */
export function tickTiming(snapshot: Json | null, settings: RunSettings, nowMs: number): string {
  const at = parseMs(snapshot?.ts)
  if (!snapshot || at === null) return "Last tick time: Not reported."
  if (text(snapshot.source) !== "live") {
    return `Newest tick is stamped ${ctClock(at, true)} (archive clock). Next tick: Not reported, this is not a live run.`
  }
  const last = `Last tick ran at ${ctClock(at, !sameCtDay(at, nowMs))}.`
  const minutes = settings.tickMinutes
  if (minutes === undefined || !(minutes > 0)) return `${last} Next tick: Not reported.`
  const due = at + minutes * 60_000
  if (due <= nowMs) return `${last} Next tick was due at ${ctClock(due, !sameCtDay(due, nowMs))} and has not arrived.`
  return `${last} Next tick expected in ${fmtClock((due - nowMs) / 1000)}.`
}

// --- orders against the tick on screen ---

export type TickOrders = { orders?: Record<string, OrderTimelineEntry[]>; canReplay: boolean; note: string }

export const LIVE_HINT = "Live shows the newest tick. Replay it to watch its orders move."

/** The orders to draw for the snapshot's tick. Orders written for another tick are never shown as this one's. */
export function ordersForTick(state: OrdersState, snapshot: Json | null): TickOrders {
  if (state.kind === "loading") return { canReplay: false, note: "Reading this tick's orders." }
  if (state.kind === "none") return { canReplay: false, note: `No orders to replay yet. ${state.brief}` }
  if (state.kind === "error") return { canReplay: false, note: `Could not read this tick's orders: ${state.brief}.` }
  const ordersAt = parseMs(state.ts)
  if (ordersAt === null) return { canReplay: false, note: "The orders on file do not say which tick they are from, so they are not shown." }
  const tickAt = parseMs(snapshot?.ts)
  if (tickAt !== ordersAt) {
    return { canReplay: false, note: `The orders on file are from the tick at ${ctClock(ordersAt, true)}, not the tick shown here.` }
  }
  return { orders: state.orders, canReplay: true, note: LIVE_HINT }
}

// --- Replay this tick ---

/** Real seconds the 0:00 to 2:05 order window takes when replayed (controller ruling: about 25 s). */
export const REPLAY_WINDOW_SECONDS = 25
/** The tick's final state, shown while not replaying: the end of the order window. */
export const FINAL_T = 125

/** Seconds inside the tick. Null start: the final state. A replay runs the window once, then holds at 2:00. */
export function replayT(startMs: number | null, nowMs: number): number {
  if (startMs === null) return FINAL_T
  return playheadSeconds({ tickIndex: null, atMs: startMs, fromT: 0, stepSeconds: REPLAY_WINDOW_SECONDS, mode: "step" }, nowMs)
}

export function replayDone(startMs: number, nowMs: number): boolean {
  return replayT(startMs, nowMs) >= HOLD_T
}
