import type { TickView } from "./contracts"
import { formatGridMw } from "./format"
import type { StressReading } from "./stressReading"

export type OutageSide = "past" | "under" | "on" | "unread"

/**
 * Outage MW minus the reserve threshold.
 * When both numbers are present, the stored margin is ignored so the tile and the banner cannot disagree.
 */
export function signedOutageMargin(reading: StressReading): number | null {
  if (reading.outageMw !== null && reading.thresholdMw !== null) {
    return reading.outageMw - reading.thresholdMw
  }
  return reading.marginMw
}

export function outageSide(marginMw: number | null): OutageSide {
  if (marginMw === null) {
    return "unread"
  }
  if (marginMw > 0) {
    return "past"
  }
  if (marginMw < 0) {
    return "under"
  }
  return "on"
}

const SIDE_CAPTION: Record<OutageSide, string> = {
  past: "past the reserve threshold",
  under: "under the reserve threshold",
  on: "on the reserve threshold",
  unread: "no reserve threshold",
}

export function marginCaption(side: OutageSide): string {
  return SIDE_CAPTION[side]
}

export type OutageLine = {
  outageMw: number | null
  thresholdMw: number | null
  marginMw: number | null
  side: OutageSide
  marginCaption: string
  /** Exact trigger, present only when both MW figures exist. */
  trigger: string | null
}

/** The storm comparison: posted outage MW against the reserve threshold. */
export function outageLine(reading: StressReading): OutageLine {
  const marginMw = signedOutageMargin(reading)
  const side = outageSide(marginMw)
  const trigger =
    reading.outageMw === null || reading.thresholdMw === null
      ? null
      : `Outage ${formatGridMw(reading.outageMw)} MW vs ${formatGridMw(reading.thresholdMw)} MW threshold`
  return {
    outageMw: reading.outageMw,
    thresholdMw: reading.thresholdMw,
    marginMw,
    side,
    marginCaption: marginCaption(side),
    trigger,
  }
}

/** The fleet comparison: delivered MW is energy above each home's reserve floor. */
export function deliverableFloorCaption(reservePct: number): string {
  return `above the ${String(reservePct)}% floor`
}

/** Backup rule: a report that cannot be trusted holds the reserve floor. */
export const UNTRUSTED_REPORT = "Hold the reserve floor. The outage report cannot be trusted."

const LATE_OR_MISSING = new Set(["timeout", "stale", "auth", "unavailable", "malformed"])

/** Late, missing, or auth-fail on a feed. Operator Hold is a different line. */
export function untrustedReport(tick: TickView, quality: string): boolean {
  return tick.policy_reason === "signal_unavailable" || LATE_OR_MISSING.has(quality)
}

/**
 * Action plus the trigger. Bad data and a posting past the reserve threshold are different stops.
 * The sentence uses the outage line, so it cannot say the posting crossed when the margin is under.
 */
export function reserveBanner(tick: TickView, quality: string, line: OutageLine): string | null {
  if (untrustedReport(tick, quality)) {
    return UNTRUSTED_REPORT
  }
  if (tick.policy_reason === "storm_risk_high" && tick.risk_level === "HIGH" && tick.mode !== "HOLD") {
    if (line.trigger === null || line.side !== "past") {
      return null
    }
    return `Raise the reserve floor. ${line.trigger}.`
  }
  return null
}
