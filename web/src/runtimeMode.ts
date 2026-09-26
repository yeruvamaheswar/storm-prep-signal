import type { TickView } from "./contracts"
import { formatMw } from "./format"
import type { StressReading } from "./stressReading"

/** Live follows the ERCOT clock. Demo is the 12-tick tape. */
export type RuntimeMode = "live" | "demo"

/** Unknown means the first pull has not finished. */
export type IngestHealth = "unknown" | "up" | "down"

const QUARTER_MIN = 15

const CENTRAL = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

export function hasErcotCredentials(subscriptionKey: string | undefined, idToken: string | undefined): boolean {
  return Boolean(subscriptionKey?.trim()) && Boolean(idToken?.trim())
}

/** A missing pull is unknown. Only a passed check is up. */
export function ingestHealth(quality: string | null): IngestHealth {
  if (quality === null) return "unknown"
  if (quality === "ok") return "up"
  return "down"
}

/**
 * Live when credentials are present and the first pull has not failed.
 * A later failure stays Live so the as-of time can remain the last success.
 * Demo is the fallback when there are no credentials, or that first pull fails.
 * An explicit Demo choice stays on the tape even when the pull is healthy.
 */
export function resolveRuntimeMode(
  hasCredentials: boolean,
  ingest: IngestHealth,
  sawSuccess: boolean,
  choice: RuntimeMode | null,
): RuntimeMode {
  if (choice === "demo" || !hasCredentials) return "demo"
  if (ingest === "down" && !sawSuccess) return "demo"
  return "live"
}

/** Live can be selected once a pull can be attempted, or after one success. */
export function liveSelectable(hasCredentials: boolean, ingest: IngestHealth, sawSuccess: boolean): boolean {
  if (!hasCredentials) return false
  if (ingest === "down" && !sawSuccess) return false
  return true
}

export function runtimeLabel(mode: RuntimeMode): string {
  switch (mode) {
    case "live":
      return "Live"
    case "demo":
      return "Demo"
    default: {
      const neverMode: never = mode
      return neverMode
    }
  }
}

function centralHourMinute(nowMs: number): { hour: number; minute: number } {
  const parts = Object.fromEntries(CENTRAL.formatToParts(new Date(nowMs)).map((part) => [part.type, part.value]))
  return { hour: Number(parts.hour), minute: Number(parts.minute) }
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}

/** The settlement window that contains now. SPP is fifteen minutes, Central time. */
export function ercotIntervalLabel(nowMs: number): string {
  const { hour, minute } = centralHourMinute(nowMs)
  const start = minute - (minute % QUARTER_MIN)
  const endMinute = start + QUARTER_MIN
  const endHour = endMinute === 60 ? (hour + 1) % 24 : hour
  const end = endMinute === 60 ? 0 : endMinute
  return `${pad(hour)}:${pad(start)}–${pad(endHour)}:${pad(end)} CT`
}

/**
 * A pinned fixture clock is not a live as-of. Blank it until a pull replaces it.
 * A reading that is already unpinned, including a last successful pull, stays.
 */
export function readingForMode(reading: StressReading, mode: RuntimeMode): StressReading {
  if (mode === "demo" || !reading.clockPinned) return reading
  return { ...reading, asOfLabel: null, ageMin: null, clockPinned: false }
}

/** The rail brief in Live. The fixture sentence stays on the Demo tape. */
export function liveBrief(tick: TickView, asOf: string | null): string {
  const delivered = `Delivered ${formatMw(tick.delivered_mw)} of ${formatMw(tick.target_mw)} MW`
  const floor = `Floor ${String(tick.reserve_pct)}%`
  if (asOf === null) return `${delivered}. ${floor}.`
  return `${delivered}. ${floor}. As of ${asOf}.`
}

/** Rail footer in Live. It names feed health and the last as-of, never a tape index. */
export function liveRailStamp(qualityLabel: string, asOf: string | null): string {
  const when = asOf === null ? "as of —" : `as of ${asOf}`
  return `quality: ${qualityLabel} · ${when}`
}
