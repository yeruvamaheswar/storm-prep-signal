import { useEffect, useState } from "react"
import type { TickView } from "./contracts"
import { stressReading } from "./stressReading"
import { LOAD_ZONES, type LoadZone } from "./zonePaint"

/**
 * Live ERCOT stamp for the wall: NP6-905-CD settlement price at LZ_NORTH and the
 * NP3-233-CD next-hour outage posting. The target stays on the tape: ERCOT does not
 * publish a SCED target for this fleet, so nothing here sets target_mw.
 */

const API = "https://api.ercot.com/api/public-reports"
const SETTLEMENT_POINT = "LZ_NORTH"
const TIMEOUT_MS = 8_000
/** How often the wall asks ERCOT again. The outage product itself posts about hourly. */
export const LIVE_POLL_MIN = 5
const POLL_MS = LIVE_POLL_MIN * 60_000
/** SPP settles every 15 minutes, so two missed intervals is stale. */
const PRICE_STALE_MIN = 30
/** NP3-233-CD posts hourly. */
const OUTAGE_STALE_MIN = 90
const HOUR_MS = 3_600_000
const CATEGORIES = ["Resource", "IRR", "NewEquipResource"] as const

export type LiveFailure = "auth" | "timeout" | "stale" | "malformed" | "unavailable"

export type LiveStamp =
  | {
      quality: "ok"
      priceUsdMwh: number
      outageMw: number
      zone: LoadZone
      zoneMw: number
      zoneColumns: Record<string, number>
      asOfLabel: string
      ageMin: number
    }
  | { quality: LiveFailure }

export type LiveOptions = {
  fetch: typeof fetch
  subscriptionKey: string | undefined
  idToken: string | undefined
  now: number
  timeoutMs?: number
}

class LiveError extends Error {
  constructor(readonly reason: LiveFailure) {
    super(reason)
  }
}

type Row = Record<string, unknown>

const CENTRAL = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

type Wall = { date: string; hour: number; minute: number }

function centralWall(ms: number): Wall {
  const parts = Object.fromEntries(CENTRAL.formatToParts(new Date(ms)).map((part) => [part.type, part.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) }
}

function utcWall(ms: number): Wall {
  const iso = new Date(ms).toISOString()
  return { date: iso.slice(0, 10), hour: Number(iso.slice(11, 13)), minute: Number(iso.slice(14, 16)) }
}

/** ERCOT writes Central Prevailing Time with no offset. Minutes may overflow past 60. */
function centralMs(date: string, hour: number, minute: number): number | null {
  const [year, month, day] = date.split("-").map(Number)
  if (!year || !month || !day) return null
  const naive = Date.UTC(year, month - 1, day, hour, minute)
  const wanted = utcWall(naive)
  for (const offsetHours of [5, 6]) {
    const candidate = naive + offsetHours * HOUR_MS
    const seen = centralWall(candidate)
    if (seen.date === wanted.date && seen.hour === wanted.hour && seen.minute === wanted.minute) {
      return candidate
    }
  }
  return null
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** ERCOT describes columns in `fields`, so rows are keyed by name, never by position. */
function rowsByName(body: unknown): Row[] {
  const raw = body as { fields?: unknown; data?: unknown }
  if (!Array.isArray(raw?.fields) || !Array.isArray(raw?.data)) throw new LiveError("malformed")
  const names = raw.fields.map((field: { name?: unknown }) => field?.name)
  return raw.data.map((values: unknown) => {
    if (!Array.isArray(values)) throw new LiveError("malformed")
    return Object.fromEntries(names.map((name, index) => [String(name), values[index]]))
  })
}

async function getRows(path: string, params: Record<string, string>, options: LiveOptions): Promise<Row[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS)
  try {
    const response = await options.fetch(`${API}${path}?${new URLSearchParams(params)}`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${options.idToken}`,
        "Ocp-Apim-Subscription-Key": options.subscriptionKey ?? "",
      },
    })
    if (response.status === 401 || response.status === 403) throw new LiveError("auth")
    if (!response.ok) throw new LiveError("unavailable")
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new LiveError("malformed")
    }
    return rowsByName(body)
  } catch (err) {
    if (err instanceof LiveError) throw err
    if (controller.signal.aborted) throw new LiveError("timeout")
    throw new LiveError("unavailable")
  } finally {
    clearTimeout(timer)
  }
}

type Price = { usdMwh: number; ageMin: number }

async function readPrice(options: LiveOptions): Promise<Price> {
  // Yesterday through today, so the newest interval is found just after midnight too.
  const rows = await getRows(
    "/np6-905-cd/spp_node_zone_hub",
    {
      settlementPoint: SETTLEMENT_POINT,
      deliveryDateFrom: centralWall(options.now - 24 * HOUR_MS).date,
      deliveryDateTo: centralWall(options.now).date,
      size: "500",
    },
    options,
  )
  let newest: { endMs: number; usdMwh: number } | null = null
  for (const row of rows) {
    const hour = finite(row.deliveryHour)
    const interval = finite(row.deliveryInterval)
    const usdMwh = finite(row.settlementPointPrice)
    if (typeof row.deliveryDate !== "string" || hour === null || interval === null || usdMwh === null) {
      throw new LiveError("malformed")
    }
    // Hour ending N, interval K ends at (N-1):00 plus K quarter hours.
    const endMs = centralMs(row.deliveryDate, hour - 1, interval * 15)
    if (endMs !== null && (newest === null || endMs > newest.endMs)) newest = { endMs, usdMwh }
  }
  if (newest === null) throw new LiveError("stale")
  const ageMin = (options.now - newest.endMs) / 60_000
  if (ageMin > PRICE_STALE_MIN) throw new LiveError("stale")
  return { usdMwh: newest.usdMwh, ageMin }
}

type Outage = {
  totalMw: number
  zone: LoadZone
  zoneMw: number
  columns: Record<string, number>
  asOfLabel: string
  ageMin: number
}

async function readOutage(options: LiveOptions): Promise<Outage> {
  const from = centralWall(options.now - 3 * HOUR_MS)
  const rows = await getRows(
    "/np3-233-cd/hourly_res_outage_cap",
    { postedDatetimeFrom: `${from.date}T${pad(from.hour)}:${pad(from.minute)}:00`, size: "1000" },
    options,
  )
  const posted = rows.map((row) => row.postedDatetime).filter((value): value is string => typeof value === "string")
  if (posted.length === 0) throw new LiveError("stale")
  // One timestamp format, so the largest string is the newest posting.
  const newest = posted.reduce((best, value) => (value > best ? value : best))
  const postedMs = centralMs(newest.slice(0, 10), Number(newest.slice(11, 13)), Number(newest.slice(14, 16)))
  if (postedMs === null) throw new LiveError("malformed")
  const ageMin = Math.max(0, Math.round((options.now - postedMs) / 60_000))
  if (ageMin > OUTAGE_STALE_MIN) throw new LiveError("stale")

  // The hour that contains now + 1h is the next hour; its hour ending is that hour + 1.
  const next = centralWall(options.now + HOUR_MS)
  const row = rows.find(
    (item) => item.postedDatetime === newest && item.operatingDate === next.date && item.hourEnding === next.hour + 1,
  )
  if (row === undefined) throw new LiveError("stale")

  const columns: Record<string, number> = {}
  const zoneMw = {} as Record<LoadZone, number>
  for (const zone of LOAD_ZONES) {
    zoneMw[zone] = 0
    for (const category of CATEGORIES) {
      const field = `total${category}MWZone${zone}`
      const value = finite(row[field])
      if (value === null) throw new LiveError("malformed")
      columns[field] = value
      zoneMw[zone] += value
    }
  }
  const zone = LOAD_ZONES.reduce((best, item) => (zoneMw[item] > zoneMw[best] ? item : best))
  return {
    totalMw: LOAD_ZONES.reduce((sum, item) => sum + zoneMw[item], 0),
    zone,
    zoneMw: zoneMw[zone],
    columns,
    asOfLabel: `${newest.slice(11, 16)} CT`,
    ageMin,
  }
}

export async function fetchLiveStamp(options: LiveOptions): Promise<LiveStamp> {
  if (!options.subscriptionKey || !options.idToken) return { quality: "auth" }
  try {
    const [price, outage] = await Promise.all([readPrice(options), readOutage(options)])
    return {
      quality: "ok",
      priceUsdMwh: price.usdMwh,
      outageMw: outage.totalMw,
      zone: outage.zone,
      zoneMw: outage.zoneMw,
      zoneColumns: outage.columns,
      asOfLabel: outage.asOfLabel,
      ageMin: outage.ageMin,
    }
  } catch (err) {
    return { quality: err instanceof LiveError ? err.reason : "malformed" }
  }
}

export type LiveWatch = {
  latest: LiveStamp | null
  /** Last pull that passed. A later failure does not clear this. */
  lastOk: Extract<LiveStamp, { quality: "ok" }> | null
}

export const EMPTY_WATCH: LiveWatch = { latest: null, lastOk: null }

/** Keep the last good pull when a later read fails. */
export function rememberLive(previous: LiveWatch, next: LiveStamp): LiveWatch {
  if (next.quality === "ok") return { latest: next, lastOk: next }
  return { latest: next, lastOk: previous.lastOk }
}

/**
 * Live numbers for one tick. A failure after a good pull keeps that pull's as-of
 * and names the new reason. Threshold stays empty: the tape trigger is not this posting.
 */
export function viewTick(tick: TickView, watch: LiveWatch): TickView {
  const latest = watch.latest
  if (latest !== null && latest.quality !== "ok" && watch.lastOk !== null) {
    const kept = stampTick(tick, watch.lastOk)
    const named: TickView & Record<string, unknown> = { ...kept, stress_quality: latest.quality }
    return named
  }
  if (latest !== null && latest.quality === "ok") return stampTick(tick, latest)
  return tick
}

/**
 * Lays the live stamp over a tape tick. A failed read keeps every tape number and only
 * names the reason. Threshold and margin stay empty on a live read: the trigger belongs to
 * the engine's rule, and the tape's trigger does not describe a live posting.
 */
export function stampTick(tick: TickView, stamp: LiveStamp | null): TickView {
  if (stamp === null) return tick
  if (stamp.quality !== "ok") {
    const tape = stressReading(tick)
    if (tape.outageMw === null) return tick
    const kept: TickView & Record<string, unknown> = {
      ...tick,
      outage_mw: tape.outageMw,
      threshold_mw: tape.thresholdMw,
      margin_mw: tape.marginMw,
      driving_zone: tape.zone,
      zone_mw: tape.zoneMw,
      stress_as_of: tape.asOfLabel,
      stress_age_min: tape.ageMin,
      clock_pinned: tape.clockPinned,
      stress_quality: stamp.quality,
    }
    return kept
  }
  const live: TickView & Record<string, unknown> = {
    ...tick,
    ...stamp.zoneColumns,
    price_usd_mwh: stamp.priceUsdMwh,
    price_label: "ercot",
    outage_mw: stamp.outageMw,
    threshold_mw: null,
    margin_mw: null,
    driving_zone: stamp.zone,
    zone_mw: stamp.zoneMw,
    stress_as_of: stamp.asOfLabel,
    stress_age_min: stamp.ageMin,
    clock_pinned: false,
    stress_quality: "ok",
  }
  return live
}

/** Reads on mount and every five minutes. A later failure keeps the last good as-of. */
export function useLiveStamp(): LiveWatch {
  const [watch, setWatch] = useState<LiveWatch>(EMPTY_WATCH)
  useEffect(() => {
    let cancelled = false
    function read() {
      void fetchLiveStamp({
        fetch: window.fetch.bind(window),
        subscriptionKey: import.meta.env.VITE_ERCOT_SUBSCRIPTION_KEY,
        idToken: import.meta.env.VITE_ERCOT_ID_TOKEN,
        now: Date.now(),
      }).then((next) => {
        if (!cancelled) setWatch((previous) => rememberLive(previous, next))
      })
    }
    read()
    const timer = window.setInterval(read, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])
  return watch
}
