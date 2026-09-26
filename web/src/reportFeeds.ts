import type { FeedChip } from "./format"
import { qualityStatus, type OperatorQuality, type QualityStatus } from "./qualityStatus"
import type { RuntimeMode } from "./runtimeMode"
import type { StressReading } from "./stressReading"
import { UNTRUSTED_REPORT } from "./wallLines"

/**
 * Compact feed status for the Feeds panel.
 * Rows stay in Quality, the banner, and the hold reason. This view never lists EMIL columns.
 * The engine may later send the same `FeedRow` list; the wall reads it when present.
 */

export type HoldOnFail = "holding" | "clear"

export type FeedState = "live" | "stale" | "hold" | "auth"

export type FeedRow = {
  product: string
  lz: string
  asOf: string
  lastSuccess: string
  state: FeedState
}

export type ReportFeeds = {
  rows: FeedRow[]
  holdOnFail: HoldOnFail
  /** A bad pull is the operator's cue to read this panel. */
  badPull: boolean
  holdingSpare: boolean
  purpose: string | null
  quality: QualityStatus
}

export type FeedsContext = {
  /** Live ingest code when a credentialed pull has spoken. */
  ingestQuality?: string | null
  lastOkAsOf?: string | null
  /** Engine- or fixture-supplied rows. The wall uses these as written. */
  supplied?: FeedRow[] | null
}

const OUTAGE_PRODUCT = "NP3-233-CD outage"
const PRICE_PRODUCT = "NP6-905-CD price"
const PRICE_LZ = "LZ_NORTH"
const FEED_STATES: ReadonlySet<string> = new Set(["live", "stale", "hold", "auth"])

/** Two wall products. Demo fills them from the fixture posting. Live copies ingest health. */
const PRODUCTS: { product: string; lz: (reading: StressReading) => string }[] = [
  { product: OUTAGE_PRODUCT, lz: (reading) => reading.zone ?? "—" },
  { product: PRICE_PRODUCT, lz: () => PRICE_LZ },
]

export function reportFeeds(
  reading: StressReading,
  feed: FeedChip,
  banner: string | null,
  mode: RuntimeMode = "demo",
  context: FeedsContext = {},
): ReportFeeds {
  const supplied = context.supplied
  if (supplied !== undefined && supplied !== null && supplied.length > 0) {
    return fromSupplied(supplied, banner)
  }

  const ingest = context.ingestQuality ?? null
  const qualityCode = ingest ?? reading.quality
  const qualityFeed: FeedChip = ingest !== null ? "LIVE" : feed
  const qualityMode: RuntimeMode = ingest !== null ? "live" : mode
  const qualityClock = ingest !== null ? false : reading.clockPinned
  const quality = qualityStatus(qualityCode, qualityFeed, qualityClock, qualityMode)
  const holdOnFail = holdFor(banner, quality.status)
  const badPull = holdOnFail === "holding"
  const asOf = asOfLine(reading)
  const success = lastSuccess(reading, quality.status, context.lastOkAsOf ?? null)
  const state = rowState(quality.status, holdOnFail)
  const rows = PRODUCTS.map((product) => ({
    product: product.product,
    lz: product.lz(reading),
    asOf,
    lastSuccess: success,
    state,
  }))
  return {
    rows,
    holdOnFail,
    badPull,
    holdingSpare: badPull,
    purpose: badPull ? "Which ERCOT products are live" : null,
    quality,
  }
}

/** Read a backend feeds list. A bad shape is ignored so a tape tick stays valid. */
export function readSuppliedFeeds(value: unknown): FeedRow[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null
  }
  const rows: FeedRow[] = []
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      return null
    }
    const row = item as Record<string, unknown>
    if (typeof row.product !== "string" || typeof row.lz !== "string") {
      return null
    }
    if (typeof row.asOf !== "string" || typeof row.lastSuccess !== "string") {
      return null
    }
    if (typeof row.state !== "string" || !FEED_STATES.has(row.state)) {
      return null
    }
    rows.push({
      product: row.product,
      lz: row.lz,
      asOf: row.asOf,
      lastSuccess: row.lastSuccess,
      state: row.state as FeedState,
    })
  }
  return rows
}

/** Replace a raw signal code with the spare-energy hold when a feed is late, missing, or auth-failed. */
export function feedReasons(reasons: string[], holdingSpare: boolean): string[] {
  if (!holdingSpare) {
    return reasons
  }
  const rest = reasons.filter((code) => code !== "signal_unavailable" && code !== "holding_spare_energy")
  return ["holding_spare_energy", ...rest]
}

export function feedStateLabel(state: FeedState): string {
  switch (state) {
    case "live":
      return "Live"
    case "stale":
      return "Stale"
    case "hold":
      return "Hold"
    case "auth":
      return "Auth"
    default: {
      const neverState: never = state
      return neverState
    }
  }
}

export function feedStateTone(state: FeedState): "ok" | "reserved" | "stale" | "dead" {
  switch (state) {
    case "live":
      return "ok"
    case "stale":
      return "stale"
    case "hold":
      return "reserved"
    case "auth":
      return "dead"
    default: {
      const neverState: never = state
      return neverState
    }
  }
}

function fromSupplied(rows: FeedRow[], banner: string | null): ReportFeeds {
  const worst = worstState(rows)
  const quality = qualityFromState(worst)
  const holdOnFail = holdFor(banner, quality.status)
  const badPull = holdOnFail === "holding" || worst !== "live"
  return {
    rows,
    holdOnFail: badPull ? "holding" : "clear",
    badPull,
    holdingSpare: badPull,
    purpose: badPull ? "Which ERCOT products are live" : null,
    quality,
  }
}

function worstState(rows: FeedRow[]): FeedState {
  if (rows.some((row) => row.state === "auth")) {
    return "auth"
  }
  if (rows.some((row) => row.state === "hold")) {
    return "hold"
  }
  if (rows.some((row) => row.state === "stale")) {
    return "stale"
  }
  return "live"
}

function qualityFromState(state: FeedState): QualityStatus {
  switch (state) {
    case "live":
      return qualityStatus("ok", "LIVE", false, "live")
    case "stale":
      return qualityStatus("stale", "LIVE", false, "live")
    case "hold":
      return qualityStatus("timeout", "LIVE", false, "live")
    case "auth":
      return qualityStatus("auth", "LIVE", false, "live")
    default: {
      const neverState: never = state
      return neverState
    }
  }
}

function holdFor(banner: string | null, status: OperatorQuality): HoldOnFail {
  if (banner === UNTRUSTED_REPORT) {
    return "holding"
  }
  switch (status) {
    case "auth_error":
    case "stale":
    case "degraded":
      return "holding"
    case "live":
    case "demo":
    case "unchecked":
      return "clear"
    default: {
      const neverStatus: never = status
      return neverStatus
    }
  }
}

function rowState(status: OperatorQuality, holdOnFail: HoldOnFail): FeedState {
  switch (status) {
    case "auth_error":
      return "auth"
    case "stale":
      return "stale"
    case "degraded":
      return "hold"
    case "live":
    case "demo":
    case "unchecked":
      return holdOnFail === "holding" ? "hold" : "live"
    default: {
      const neverStatus: never = status
      return neverStatus
    }
  }
}

function asOfLine(reading: StressReading): string {
  if (reading.asOfLabel === null && reading.ageMin === null) {
    return "—"
  }
  const stamp = reading.asOfLabel ?? "time missing"
  if (reading.ageMin === null) {
    return stamp
  }
  return `${stamp} · ${String(reading.ageMin)} min`
}

/** A passed check, a stale posting, or a pinned demo still has a time. A failed read does not. */
function lastSuccess(reading: StressReading, status: OperatorQuality, lastOkAsOf: string | null): string {
  if (lastOkAsOf !== null) {
    return lastOkAsOf
  }
  switch (status) {
    case "live":
    case "demo":
    case "stale":
      return reading.asOfLabel ?? "none"
    case "auth_error":
    case "degraded":
    case "unchecked":
      return "none"
    default: {
      const neverStatus: never = status
      return neverStatus
    }
  }
}
