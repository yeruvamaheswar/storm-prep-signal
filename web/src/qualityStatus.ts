import type { FeedChip } from "./format"
import type { RuntimeMode } from "./runtimeMode"

/**
 * What the Quality cell says. The tick still stores the raw check code.
 * Live, Degraded, Stale, and Auth error use the wall tokens OK, Reserved, Stale, and Dead.
 */
export type OperatorQuality = "live" | "degraded" | "stale" | "auth_error" | "demo" | "unchecked"

export type QualityTone = "ok" | "reserved" | "stale" | "dead"

export type QualityStatus = {
  status: OperatorQuality
  label: string
  reason: string
  tone: QualityTone
  tooltip: string
}

/** Failures the live client can stamp onto the pinned layout tape. */
const FIXTURE_OVERLAY = new Set(["auth", "timeout", "stale", "malformed", "unavailable"])

function fixtureOverlay(quality: string, feed: FeedChip, clockPinned: boolean): boolean {
  if (feed !== "SYNTHETIC") return false
  if (quality === "unchecked") return true
  return clockPinned && FIXTURE_OVERLAY.has(quality)
}

/** Live QUALITY is only Live, Stale, Auth error, or Degraded. No fixture labels. */
export function liveQuality(quality: string): Exclude<OperatorQuality, "demo" | "unchecked"> {
  if (quality === "ok") return "live"
  if (quality === "auth") return "auth_error"
  if (quality === "stale") return "stale"
  return "degraded"
}

function classify(quality: string, feed: FeedChip, clockPinned: boolean, mode: RuntimeMode): OperatorQuality {
  if (mode === "live") return liveQuality(quality)
  if (quality === "ok") return "live"
  if (fixtureOverlay(quality, feed, clockPinned)) return "demo"
  if (quality === "auth") return "auth_error"
  if (quality === "stale") return "stale"
  if (quality === "unchecked") return "unchecked"
  return "degraded"
}

function degradedCopy(quality: string): { reason: string; tooltip: string } {
  switch (quality) {
    case "timeout":
      return {
        reason: "report timed out",
        tooltip: "The outage report timed out, so this row is not a live reading.",
      }
    case "malformed":
    case "bad_payload":
      return {
        reason: "report could not be read",
        tooltip: "The outage report could not be read, so this row is not a live reading.",
      }
    case "unavailable":
      return {
        reason: "report unavailable",
        tooltip: "The outage report was unavailable, so this row is not a live reading.",
      }
    case "signal_unavailable":
      return {
        reason: "signal could not be read",
        tooltip: "The storm signal could not be read, so this row is not a live reading.",
      }
    case "http":
      return {
        reason: "report request failed",
        tooltip: "The outage request failed, so this row is not a live reading.",
      }
    case "missing_field":
      return {
        reason: "a field was missing",
        tooltip: "The outage report was missing a field, so this row is not a live reading.",
      }
    case "impossible_value":
      return {
        reason: "a value was impossible",
        tooltip: "The outage report had an impossible value, so this row is not a live reading.",
      }
    default:
      return {
        reason: "check failed",
        tooltip: "The outage check failed, so this row is not a live reading.",
      }
  }
}

function present(status: OperatorQuality, quality: string): QualityStatus {
  switch (status) {
    case "live":
      return {
        status,
        label: "Live",
        reason: "check passed",
        tone: "ok",
        tooltip: "The latest ERCOT outage posting passed the check.",
      }
    case "demo":
      return {
        status,
        label: "Demo data",
        reason: "layout fixture",
        tone: "stale",
        tooltip: "Layout fixture. A live fetch failure is not shown on this synthetic tape.",
      }
    case "auth_error":
      return {
        status,
        label: "Auth error",
        reason: "ERCOT login failed",
        tone: "dead",
        tooltip: "ERCOT rejected the login, or this wall has no subscription key.",
      }
    case "stale":
      return {
        status,
        label: "Stale",
        reason: "reading is old",
        tone: "stale",
        tooltip: "The newest posting is older than the staleness limit.",
      }
    case "unchecked":
      return {
        status,
        label: "Unchecked",
        reason: "no check ran",
        tone: "stale",
        tooltip: "No live check has run on this posting.",
      }
    case "degraded":
      return { status, label: "Degraded", tone: "reserved", ...degradedCopy(quality) }
    default: {
      const neverStatus: never = status
      return neverStatus
    }
  }
}

/** Operator label for the Storm Prep Quality cell. Live never relabels a feed failure as Demo data. */
export function qualityStatus(
  quality: string,
  feed: FeedChip,
  clockPinned: boolean,
  mode: RuntimeMode = "demo",
): QualityStatus {
  return present(classify(quality, feed, clockPinned, mode), quality)
}

/** Present a snapshot quality without re-reading a fixture code. */
export function qualityView(status: OperatorQuality, quality = ""): QualityStatus {
  return present(status, quality)
}
