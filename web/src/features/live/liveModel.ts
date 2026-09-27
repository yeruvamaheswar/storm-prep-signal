import type { FlowHome, FlowTick, FlowZoneRow, OrderTimelineEntry } from "../flow/types"
import { errorText, fleetLabel, liveFleetNote, readHomesSource } from "../fleetgrid/fleetModel"
import { NOT_REPORTED } from "../replay/format"
import { HOLD_T, fmtClock, playheadSeconds } from "../replay/tickClock"

/** Pure mapping for the Live page (Task 9 part 2): GET /v1/snapshot, /v1/runs/latest, /v1/live/orders, /v1/homes and
 * /v1/fleet/rollups into the shapes the Replay components take. Nothing is invented: a missing field stays missing and
 * shows "Not reported", and the page is live only when every check it needs is reported and passes. */

export { NOT_REPORTED }

type Json = Record<string, unknown>

export type SnapshotState = { kind: "loading" } | { kind: "error"; brief: string } | { kind: "ready"; value: Json }

export type OrdersState =
  | { kind: "loading" }
  | { kind: "none"; brief: string }
  | { kind: "error"; brief: string }
  | { kind: "ready"; tick: number | null; ts: string | null; orders: Record<string, OrderTimelineEntry[]> }

/** From the run's `settings` (GET /v1/runs/latest). Undefined when the run does not say. */
export type RunSettings = { tickMinutes?: number; baseFloorPct?: number; fleetSize?: number }

/** GET /v1/runs/latest: its settings, and its newest tick's time so the snapshot can be matched to the same run. */
export type RunState =
  | { kind: "loading" }
  | { kind: "error"; brief: string }
  | { kind: "ready"; settings: RunSettings; runId: string | null; lastTs: string | null }

/** Live only when the newest run is a fresh live-worker tick of the demo fleet, and every check says so. */
export type LiveStatus =
  | { kind: "loading" }
  | { kind: "error"; brief: string }
  | { kind: "not_live"; pill: string; reason: string }
  | { kind: "live" }

/** GET /v1/homes: the rows as Replay homes, what the headers say, and how many rows came back. */
export type LiveHomes = {
  homes: FlowHome[]
  note: string
  fleetSize: number | null
  source: "supabase" | "fixture" | null
  total: number | null
  rows: number
}

export type HomesState = { kind: "loading" } | { kind: "error"; brief: string } | ({ kind: "ready" } & LiveHomes)

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

/** loop.run writes `settings` (SETTINGS_KEYS) and the scoreboard `totals`; tick_minutes is in both, never in the
 * snapshot. A table row carries `settings` since persist_run stores them (Task 9c). Missing stays undefined. */
export function settingsFromRun(body: unknown): RunSettings {
  const settings = isRecord(body) && isRecord(body.settings) ? body.settings : {}
  const totals = isRecord(body) && isRecord(body.totals) ? body.totals : {}
  return {
    tickMinutes: num(settings.tick_minutes) ?? num(totals.tick_minutes),
    baseFloorPct: num(settings.base_reserve_pct),
    fleetSize: num(settings.fleet_size),
  }
}

export function runFromReply(status: number, body: unknown): RunState {
  if (status < 200 || status >= 300) return { kind: "error", brief: errorText(status, body) }
  if (!isRecord(body)) return { kind: "error", brief: "the run reply was not an object" }
  const ticks = Array.isArray(body.ticks) ? body.ticks : []
  const last = ticks.at(-1)
  return {
    kind: "ready",
    settings: settingsFromRun(body),
    runId: text(body.run_id) ?? null,
    lastTs: isRecord(last) ? text(last.ts) ?? null : null,
  }
}

/** A failed poll keeps the last good run (so one dropped request does not flip the page), never an empty one. */
export function nextRun(previous: RunState, reply: RunState): RunState {
  return reply.kind === "error" && previous.kind === "ready" ? previous : reply
}

// --- homes ---

const KW_EPS = 1e-6

/** One GET /v1/homes row: who and where only. The table's charge, power and status are not this tick's engine state
 * (the live worker does not write them), so they are never read: charge shows "Not reported". */
export function flowHomeFromRow(row: unknown): FlowHome | null {
  if (!isRecord(row) || !text(row.home_id) || !text(row.zone)) return null
  const home: FlowHome = {
    id: row.home_id as string,
    zone: row.zone as string,
    soc_pct: Number.NaN,
    floor_pct: Number.NaN,
    kw: Number.NaN,
    state: "holding",
    status: "",
  }
  const name = text(row.name)
  const county = text(row.county)
  const countyName = text(row.county_name)
  if (name) home.name = name
  if (county) home.county = county
  if (countyName) home.county_name = countyName
  return home
}

export function homesFromReply(body: unknown, headers: { get(name: string): string | null }): LiveHomes {
  const rows = Array.isArray(body) ? body : []
  const homes = rows.map(flowHomeFromRow).filter((home): home is FlowHome => home !== null)
  const src = readHomesSource(headers)
  return { homes, note: liveFleetNote(src, rows.length), fleetSize: src.fleetSize, source: src.source, total: src.total, rows: rows.length }
}

/** GET /v1/homes?limit=200 (the API caps it at the demo fleet). A failure keeps the server's brief. */
export function homesStateFromReply(status: number, body: unknown, headers: { get(name: string): string | null }): HomesState {
  if (status < 200 || status >= 300) return { kind: "error", brief: errorText(status, body) }
  return { kind: "ready", ...homesFromReply(body, headers) }
}

/** The homes line for the left panel, only when something is wrong: a failed read, sample rows, or fewer rows than
 * the fleet. A full, live table says nothing. */
export function homesWarning(homes: HomesState): string | null {
  if (homes.kind === "loading") return null
  if (homes.kind === "error") return `Could not read the homes: ${homes.brief.replace(/\.$/, "")}.`
  if (homes.source !== "supabase") return homes.note
  const expected = homes.fleetSize
  if (expected === null) return homes.note
  const partial = homes.rows < expected || (homes.total !== null && homes.total < expected)
  return partial ? homes.note : null
}

/** The engine's words for a home from this tick's own orders: the last confirmed kW says selling or charging.
 * Nothing confirmed: holding (Replay then shows "Not asked" or the order's own lifecycle). */
function stateFromOrders(entries: OrderTimelineEntry[] | undefined): FlowHome["state"] {
  const conf = (entries ?? []).filter(([, kind]) => kind === "conf").at(-1)
  const kw = conf ? num(conf[2]) : undefined
  if (kw === undefined) return "holding"
  if (kw > KW_EPS) return "selling"
  if (kw < -KW_EPS) return "charging"
  return "holding"
}

/** Each home at this tick: its floor is the snapshot's own (county, then zone, then fleet floor) and its state comes
 * from this tick's orders. Its zone is the one /v1/homes reports (the engine's, after Task 17). */
export function tickHomes(homes: FlowHome[], snapshot: Json | null, orders: Record<string, OrderTimelineEntry[]> | undefined): FlowHome[] {
  const counties = snapshot && isRecord(snapshot.county_reserve_pct) ? snapshot.county_reserve_pct : {}
  const zones = snapshot && isRecord(snapshot.zone_reserve_pct) ? snapshot.zone_reserve_pct : {}
  const fleet = snapshot ? num(snapshot.reserve_pct) : undefined
  return homes.map((home) => {
    const floor = (home.county ? num(counties[home.county]) : undefined) ?? num(zones[home.zone]) ?? fleet ?? Number.NaN
    return { ...home, floor_pct: floor, state: stateFromOrders(orders?.[home.id]) }
  })
}

/** The demo fleet's size: X-Fleet-Size first, then GET /v1/fleet/rollups `n`. Null when neither says. */
export function fleetSizeFrom(headerSize: number | null, rollups: unknown): number | null {
  if (headerSize !== null) return headerSize
  const n = isRecord(rollups) ? num(rollups.n) : undefined
  return n !== undefined && n > 0 ? n : null
}

// --- snapshot into Replay props ---

const TICK_NUMBERS = ["tick", "target_mw", "delivered_mw", "missed_mw", "reserve_pct", "breaches", "charging_mw"] as const
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
  if (Array.isArray(snapshot.grid_down_zones)) out.grid_down_zones = snapshot.grid_down_zones.filter((z) => typeof z === "string")
  for (const key of ["zone_reserve_pct", "zone_reasons", "county_reserve_pct", "county_reasons"] as const) {
    if (isRecord(snapshot[key])) out[key] = snapshot[key]
  }
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

function pctText(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`
}

/** The mockup's one meaning sentence ("Offline plants are over the stress line, so every home keeps 60% for backup."),
 * only when the snapshot's own fields support every word: the margin's side of the line, the policy reason that
 * follows from it, and one floor that every zone reports. Otherwise null, never a guess. */
export function meaningLine(snapshot: Json): string | null {
  const margin = num(snapshot.margin_mw)
  const floor = num(snapshot.reserve_pct)
  const reason = text(snapshot.policy_reason)
  const zones = isRecord(snapshot.zone_reserve_pct) ? Object.values(snapshot.zone_reserve_pct) : []
  if (margin === undefined || floor === undefined || margin === 0) return null
  if (!zones.length || !zones.every((pct) => num(pct) === floor)) return null
  if (isRecord(snapshot.county_reserve_pct) && Object.values(snapshot.county_reserve_pct).some((pct) => num(pct) !== floor)) return null
  if (margin > 0 && reason === "storm_risk_high") {
    return `Offline plants are over the stress line, so every home keeps ${pctText(floor)} for backup.`
  }
  if (margin < 0 && reason === "normal") {
    return `Offline plants are under the stress line, so every home keeps the usual ${pctText(floor)} for backup.`
  }
  return null
}

function labelWords(label: string | undefined, what: "target" | "price"): string | null {
  if (!label || label === "ercot" || label === "none") return null
  if (label === "synthetic") return `The ${what} is a practice number (synthetic).`
  return `The ${what} is labeled ${label}.`
}

/** What is simulated, in the words the data carries: the demo fleet and its orders, and the target and price labels.
 * (The inputs are live ERCOT whenever this panel shows them, so that needs no line.) */
export function simulatedLine(snapshot: Json, fleetSize: number | null): string {
  const fleet = fleetSize === null ? "The demo fleet" : `The ${fleetLabel(fleetSize)}`
  const labels = [labelWords(text(snapshot.target_label), "target"), labelWords(text(snapshot.price_label), "price")]
  return [`${fleet} and its orders are simulated.`, ...labels.filter(Boolean)].join(" ")
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

function minutesAgo(at: number, nowMs: number): number {
  return Math.floor(Math.max(0, nowMs - at) / 60_000)
}

/** A live tick older than this many tick lengths means the live worker (on Render since PR #60) is stopped or asleep.
 * `live_cycle --loop` sleeps a whole tick length after each cycle, so one extra tick length is its normal lag. */
const STALE_TICKS = 2

function notLive(pill: string, reason: string): LiveStatus {
  return { kind: "not_live", pill, reason }
}

function notLiveSource(snapshot: Json): LiveStatus | null {
  const source = text(snapshot.source)
  if (source === "live") return null
  if (source === "archive") {
    const event = text(snapshot.event)
    return notLive(
      `ERCOT archive${event ? ` (${event})` : ""}, not live`,
      `The newest run replays ${event ? `the ${event} archive` : "an archive"}, not live ERCOT.`,
    )
  }
  if (source === "scenario") return notLive("Scenario run, not live ERCOT", "The newest run is a scenario run, not live ERCOT.")
  if (source === "fixture") return notLive("Sample data, not live ERCOT", "The API has only sample data, not live ERCOT.")
  return notLive("Source not reported, not live", "The snapshot does not say where its data comes from, so it is not shown as live.")
}

const UNCHECKED = "Not live, run not checked"

/** Live or not, and why. Every guard must be reported and pass: an unknown fleet, demo fleet or tick length is not
 * live. The fleet checks come first, so an old 10,000-home tick never reaches the screen and its count is never named.
 * The snapshot must be the run's own newest tick. */
export function liveStatus(state: SnapshotState, run: RunState, demoFleet: number | null, nowMs: number): LiveStatus {
  if (state.kind !== "ready") return state
  if (run.kind === "loading") return { kind: "loading" }
  if (run.kind === "error") return notLive(UNCHECKED, `The run file could not be read (${run.brief.replace(/\.$/, "")}), so this tick cannot be checked.`)
  const snapshot = state.value
  const { settings } = run
  if (demoFleet === null) return notLive(UNCHECKED, "The demo fleet size is not reported, so the run cannot be checked against it.")
  const demo = fleetLabel(demoFleet)
  if (settings.fleetSize === undefined) return notLive(UNCHECKED, `The run does not report its fleet size, so it cannot be checked against the ${demo}.`)
  if (settings.fleetSize !== demoFleet) {
    return notLive(
      "Not live, older run",
      settings.fleetSize > demoFleet
        ? `The newest run is from before the ${demo}, so it is not shown.`
        : `The newest run did not use the ${demo}, so it is not shown.`,
    )
  }
  const source = notLiveSource(snapshot)
  if (source) return source
  const at = parseMs(snapshot.ts)
  const runAt = parseMs(run.lastTs)
  if (at === null || runAt === null || at !== runAt) {
    return notLive(UNCHECKED, "The snapshot and the run file do not name the same newest tick, so it is not shown as live.")
  }
  const minutes = settings.tickMinutes
  if (minutes === undefined || !(minutes > 0)) {
    return notLive(UNCHECKED, "The run does not report its tick length, so freshness cannot be checked.")
  }
  if (nowMs - at > STALE_TICKS * minutes * 60_000) {
    return notLive(
      `Not live, last tick ${minutesAgo(at, nowMs)} min ago`,
      `No new tick since ${ctClock(at, !sameCtDay(at, nowMs))}, so the live worker looks stopped or asleep.`,
    )
  }
  // A fresh tick from a failed (or unreported) ERCOT data check is never shown as live: its inputs are not trusted.
  const quality = text(snapshot.quality)
  if (quality === undefined) {
    return notLive(UNCHECKED, "The newest tick does not report its ERCOT data check, so it is not shown as live.")
  }
  if (quality !== "ok") {
    return notLive(
      "Live tick, ERCOT data check failed",
      `The newest tick's ERCOT data check failed (${quality.replace(/_/g, " ")}), so it is not shown as live.`,
    )
  }
  return { kind: "live" }
}

export type SourcePill = { text: string; live: boolean }

/** The top-right pill. "Live from ERCOT, updated N min ago" only when live; everything else says it is not. */
export function livePill(status: LiveStatus, snapshot: Json | null, nowMs: number): SourcePill {
  if (status.kind === "loading") return { text: "Reading the ERCOT snapshot", live: false }
  if (status.kind === "error") return { text: "ERCOT snapshot unavailable", live: false }
  if (status.kind === "not_live") return { text: status.pill, live: false }
  const at = parseMs(snapshot?.ts)
  if (at === null) return { text: "Live from ERCOT, update time not reported", live: true }
  const minutes = minutesAgo(at, nowMs)
  return { text: `Live from ERCOT, updated ${minutes < 1 ? "under a minute" : `${minutes} min`} ago`, live: true }
}

/** The playback bar's first line. The countdown uses the run's own tick_minutes; without it, "Not reported". For one
 * tick length past due the next tick is "due now" (the worker's normal lag); after that it "has not arrived". */
export function tickTiming(snapshot: Json | null, settings: RunSettings, nowMs: number): string {
  const at = parseMs(snapshot?.ts)
  if (!snapshot || at === null) return "Last tick time: Not reported."
  const source = text(snapshot.source)
  if (source !== "live") {
    const clock = source === "archive" ? " (archive clock)" : ""
    return `Newest tick is stamped ${ctClock(at, true)}${clock}. Next tick: Not reported, this is not a live run.`
  }
  const last = `Last tick ran at ${ctClock(at, !sameCtDay(at, nowMs))}.`
  const minutes = settings.tickMinutes
  if (minutes === undefined || !(minutes > 0)) return `${last} Next tick: Not reported.`
  const due = at + minutes * 60_000
  if (due > nowMs) return `${last} Next tick in ${fmtClock((due - nowMs) / 1000)}.`
  if (nowMs < due + minutes * 60_000) return `${last} Next tick due now.`
  return `${last} Next tick was due at ${ctClock(due, !sameCtDay(due, nowMs))} and has not arrived.`
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
