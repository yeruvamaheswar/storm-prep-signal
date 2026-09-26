import { useEffect, useState } from "react"
import { apiBaseUrl } from "./api/health"
import type { RiskLevel, TickView } from "./contracts"
import {
  rollingIntervals,
  toInterval,
  type IntervalDraft,
  type IntervalPoint,
} from "./intervalSeries"
import { LOAD_ZONES, type LoadZone } from "./zonePaint"

/**
 * Live stamp for the wall. The browser reads GET /v1/snapshot only.
 * ERCOT keys and the public-reports host stay on the API.
 * Do not add @supabase/supabase-js or an anon key here.
 */

const TIMEOUT_MS = 8_000
const FAIL_SAFE_FLOOR = 60
/** How often Live asks the API again. ERCOT itself posts on a slower clock. */
export const LIVE_POLL_MS = 20_000

export type LiveFailure = "auth" | "timeout" | "stale" | "malformed" | "unavailable"

export type LiveStamp =
  | {
      quality: "ok"
      priceUsdMwh: number | null
      outageMw: number
      zone: LoadZone
      zoneMw: number
      zoneColumns: Record<string, number>
      asOfLabel: string
      ageMin: number
      triggerMw?: number | null
      peakMw?: number | null
      marginMw?: number | null
      reservePct?: number
      risk?: RiskLevel | null
      policyReason?: string
    }
  | {
      quality: LiveFailure
      reservePct?: number
      risk?: RiskLevel | null
      policyReason?: string
    }

export type LiveWatch = {
  latest: LiveStamp | null
  /** Last pull that passed. A later failure does not clear this. */
  lastOk: Extract<LiveStamp, { quality: "ok" }> | null
  /** Last snapshot TickView. Live uses this instead of the selected tape index. */
  tick?: TickView | null
  intervals?: IntervalPoint[]
}

export const EMPTY_WATCH: LiveWatch = { latest: null, lastOk: null, tick: null, intervals: [] }

export function intervalDraftFromTick(tick: TickView): IntervalDraft {
  return {
    ts: tick.ts,
    targetMw: tick.target_mw,
    deliveredMw: tick.delivered_mw,
    reservedMw: 0,
    riskLevel: tick.risk_level,
    reservePct: tick.reserve_pct,
    policyReason: tick.policy_reason,
    deadHomes: tick.dead_homes,
    mode: tick.mode,
  }
}

/** Append or replace the newest interval. Same `ts` updates the last point. */
export function pushLiveInterval(
  intervals: readonly IntervalPoint[],
  lastDraft: IntervalDraft | null,
  tick: TickView,
): { intervals: IntervalPoint[]; lastDraft: IntervalDraft } {
  const draft = intervalDraftFromTick(tick)
  if (lastDraft !== null && lastDraft.ts === draft.ts) {
    const previous = intervals[intervals.length - 1]
    const point = toInterval(draft, null)
    const kept = previous === undefined ? point : { ...point, events: previous.events }
    return { intervals: rollingIntervals([...intervals.slice(0, -1), kept]), lastDraft: draft }
  }
  return {
    intervals: rollingIntervals([...intervals, toInterval(draft, lastDraft)]),
    lastDraft: draft,
  }
}

/** Keep the last good pull when a later read fails. */
export function rememberLive(previous: LiveWatch, next: LiveStamp): LiveWatch {
  if (next.quality === "ok") return { ...previous, latest: next, lastOk: next }
  return { ...previous, latest: next, lastOk: previous.lastOk }
}

export function rememberSnapshot(previous: LiveWatch, stamp: LiveStamp, tick: TickView | null): LiveWatch {
  const live = rememberLive(previous, stamp)
  if (tick === null) return { ...live, tick: previous.tick ?? null, intervals: previous.intervals ?? [] }
  const pushed = pushLiveInterval(previous.intervals ?? [], previousDraft(previous), tick)
  return { ...live, tick, intervals: pushed.intervals }
}

function previousDraft(watch: LiveWatch): IntervalDraft | null {
  const tick = watch.tick
  if (tick === undefined || tick === null) return null
  return intervalDraftFromTick(tick)
}

/** Drop tape 185 and the tape trigger. Keep target and delivered. */
export function liveSafeTick(tick: TickView): TickView {
  const ercot = tick.price_label === "ercot"
  const cleared: TickView & Record<string, unknown> = {
    ...tick,
    price_usd_mwh: ercot ? tick.price_usd_mwh : null,
    price_label: ercot ? "ercot" : "none",
    risk_level: null,
    reserve_pct: FAIL_SAFE_FLOOR,
    policy_reason: "signal_unavailable",
    outage_mw: null,
    trigger_mw: null,
    peak_mw: null,
    margin_mw: null,
    threshold_mw: null,
    clock_pinned: false,
  }
  return cleared
}

/**
 * Live numbers for one tick. A failure after a good pull keeps that pull's as-of
 * and names the new reason. An empty watch does not keep tape 185 or the tape trigger.
 */
export function viewTick(tick: TickView, watch: LiveWatch): TickView {
  const latest = watch.latest
  if (latest !== null && latest.quality !== "ok" && watch.lastOk !== null) {
    const kept = stampTick(tick, watch.lastOk)
    const named: TickView & Record<string, unknown> = { ...kept, stress_quality: latest.quality }
    return named
  }
  if (latest !== null && latest.quality === "ok") return stampTick(tick, latest)
  if (latest !== null) return stampTick(tick, latest)
  return liveSafeTick(tick)
}

/**
 * Lays the live stamp over a tick. A failed read clears tape 185 and the tape trigger.
 * Threshold stays empty unless trigger_mw arrived from the engine.
 */
export function stampTick(tick: TickView, stamp: LiveStamp | null): TickView {
  if (stamp === null) return liveSafeTick(tick)
  if (stamp.quality !== "ok") {
    const cleared = liveSafeTick(tick)
    const named: TickView & Record<string, unknown> = {
      ...cleared,
      reserve_pct: stamp.reservePct ?? FAIL_SAFE_FLOOR,
      risk_level: stamp.risk === undefined ? null : stamp.risk,
      policy_reason: stamp.policyReason ?? "signal_unavailable",
      stress_quality: stamp.quality,
    }
    return named
  }
  const live: TickView & Record<string, unknown> = {
    ...tick,
    ...stamp.zoneColumns,
    price_usd_mwh: stamp.priceUsdMwh,
    price_label: "ercot",
    outage_mw: stamp.outageMw,
    trigger_mw: stamp.triggerMw ?? null,
    peak_mw: stamp.peakMw ?? null,
    threshold_mw: stamp.triggerMw ?? null,
    margin_mw: stamp.marginMw ?? null,
    driving_zone: stamp.zone,
    zone_mw: stamp.zoneMw,
    stress_as_of: stamp.asOfLabel,
    stress_age_min: stamp.ageMin,
    clock_pinned: false,
    stress_quality: "ok",
  }
  if (stamp.reservePct !== undefined) live.reserve_pct = stamp.reservePct
  if (stamp.risk !== undefined) live.risk_level = stamp.risk
  if (stamp.policyReason !== undefined) live.policy_reason = stamp.policyReason
  return live
}

const LIVE_FAILURES: readonly LiveFailure[] = ["auth", "timeout", "stale", "malformed", "unavailable"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isLiveFailure(value: string): value is LiveFailure {
  return (LIVE_FAILURES as readonly string[]).includes(value)
}

function finiteField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export function isTickView(value: unknown): value is TickView {
  if (!isRecord(value)) return false
  return (
    typeof value.tick === "number" &&
    typeof value.ts === "string" &&
    typeof value.target_mw === "number" &&
    typeof value.delivered_mw === "number"
  )
}

function failStamp(body: Record<string, unknown>, quality: LiveFailure): LiveStamp {
  const risk =
    body.risk_level === "HIGH" || body.risk_level === "LOW" || body.risk_level === null ? body.risk_level : null
  return {
    quality,
    reservePct: finiteField(body.reserve_pct) ?? FAIL_SAFE_FLOOR,
    risk,
    policyReason: typeof body.policy_reason === "string" ? body.policy_reason : "signal_unavailable",
  }
}

/** Map a /v1/snapshot TickView onto the stamp the wall already overlays. */
export function stampFromSnapshot(body: unknown): LiveStamp {
  if (!isRecord(body)) return { quality: "malformed", reservePct: FAIL_SAFE_FLOOR, risk: null, policyReason: "signal_unavailable" }
  const named =
    typeof body.quality === "string"
      ? body.quality
      : typeof body.stress_quality === "string"
        ? body.stress_quality
        : "unavailable"
  if (named !== "ok") return failStamp(body, isLiveFailure(named) ? named : "unavailable")
  const priceUsdMwh = finiteField(body.price_usd_mwh)
  const outageMw = finiteField(body.outage_mw)
  const zoneMw = finiteField(body.zone_mw)
  const ageMin = finiteField(body.stress_age_min)
  const zone = typeof body.driving_zone === "string" ? body.driving_zone : null
  const asOfLabel =
    typeof body.as_of === "string" ? body.as_of : typeof body.stress_as_of === "string" ? body.stress_as_of : null
  if (outageMw === null || ageMin === null || zone === null || asOfLabel === null) {
    return failStamp(body, "malformed")
  }
  if (!(LOAD_ZONES as readonly string[]).includes(zone)) return failStamp(body, "malformed")
  const zoneColumns: Record<string, number> = {}
  for (const [key, value] of Object.entries(body)) {
    if (key.startsWith("total") && key.includes("MWZone") && typeof value === "number") {
      zoneColumns[key] = value
    }
  }
  const risk =
    body.risk_level === "HIGH" || body.risk_level === "LOW" || body.risk_level === null ? body.risk_level : undefined
  return {
    quality: "ok",
    priceUsdMwh,
    outageMw,
    zone: zone as LoadZone,
    zoneMw: zoneMw ?? outageMw,
    zoneColumns,
    asOfLabel,
    ageMin,
    triggerMw: finiteField(body.trigger_mw),
    peakMw: finiteField(body.peak_mw),
    marginMw: finiteField(body.margin_mw),
    reservePct: finiteField(body.reserve_pct) ?? undefined,
    risk,
    policyReason: typeof body.policy_reason === "string" ? body.policy_reason : undefined,
  }
}

export type SnapshotPull = { stamp: LiveStamp; tick: TickView | null }

/** Poll the FastAPI snapshot. The browser does not call ERCOT. */
export async function fetchSnapshot(
  fetchFn: typeof fetch,
  baseUrl: string,
  timeoutMs = TIMEOUT_MS,
  query: { event?: string | null; clock?: string | null } = {},
): Promise<SnapshotPull> {
  const params = new URLSearchParams()
  if (query.event) params.set("event", query.event)
  if (query.clock && query.clock.includes("T")) params.set("clock", query.clock)
  const encoded = params.toString()
  const suffix = encoded.length > 0 ? `?${encoded}` : ""
  try {
    const response = await fetchFn(`${baseUrl}/v1/snapshot${suffix}`, {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      return {
        stamp: {
          quality: response.status === 401 || response.status === 403 ? "auth" : "unavailable",
          reservePct: FAIL_SAFE_FLOOR,
          risk: null,
          policyReason: "signal_unavailable",
        },
        tick: null,
      }
    }
    const body: unknown = await response.json()
    return { stamp: stampFromSnapshot(body), tick: isTickView(body) ? body : null }
  } catch (err) {
    if (typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError") {
      return { stamp: { quality: "timeout", reservePct: FAIL_SAFE_FLOOR, risk: null, policyReason: "signal_unavailable" }, tick: null }
    }
    return { stamp: { quality: "unavailable", reservePct: FAIL_SAFE_FLOOR, risk: null, policyReason: "signal_unavailable" }, tick: null }
  }
}

/** Reads on mount and every 20 s. Demo does not poll. A later failure keeps the last good as-of. */
export function useLiveStamp(
  enabled = true,
  event: string | null = null,
  clock: string | null = null,
): LiveWatch {
  const [watch, setWatch] = useState<LiveWatch>(EMPTY_WATCH)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    function read() {
      void fetchSnapshot(window.fetch.bind(window), apiBaseUrl(), TIMEOUT_MS, { event, clock }).then((next) => {
        if (!cancelled) setWatch((previous) => rememberSnapshot(previous, next.stamp, next.tick))
      })
    }
    read()
    const timer = window.setInterval(read, LIVE_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [enabled, event, clock])
  return watch
}
