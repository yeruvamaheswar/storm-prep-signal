import type { Mode, RiskLevel, TickView } from "./contracts"
import { feedChip } from "./format"
import { EMPTY_WATCH, viewTick, type LiveWatch } from "./liveStamp"
import { liveQuality, qualityStatus, type OperatorQuality } from "./qualityStatus"
import { readingForMode, type RuntimeMode } from "./runtimeMode"
import { stressReading } from "./stressReading"
import { signedOutageMargin } from "./wallLines"

/** One header row. Demo fills it from the tape. Live fills it from the backend poll. */
export type SnapshotAsOf = {
  ageMin: number | null
  label: string | null
  pinned: boolean
}

export type WallSnapshot = {
  targetMw: number
  deliveredMw: number
  missedMw: number
  priceMwh: number | null
  floorPct: number
  risk: RiskLevel | null
  calm: number
  outageMw: number | null
  outageThresholdMw: number | null
  marginMw: number | null
  zone: string | null
  zoneMw: number | null
  asOf: SnapshotAsOf
  quality: OperatorQuality
  reasonCodes: string[]
  mode: Mode
}

function fromTick(
  tick: TickView,
  calm: number,
  asOf: SnapshotAsOf,
  quality: OperatorQuality,
  outage: {
    outageMw: number | null
    thresholdMw: number | null
    marginMw: number | null
    zone: string | null
    zoneMw: number | null
  },
): WallSnapshot {
  return {
    targetMw: tick.target_mw,
    deliveredMw: tick.delivered_mw,
    missedMw: tick.missed_mw,
    priceMwh: tick.price_usd_mwh,
    floorPct: tick.reserve_pct,
    risk: tick.risk_level,
    calm,
    outageMw: outage.outageMw,
    outageThresholdMw: outage.thresholdMw,
    marginMw: outage.marginMw,
    zone: outage.zone,
    zoneMw: outage.zoneMw,
    asOf,
    quality,
    reasonCodes: tick.reasons,
    mode: tick.mode,
  }
}

/** Demo: every tile is the tape, including a pinned fixture clock. */
export function demoSnapshot(tick: TickView, calm: number): WallSnapshot {
  const reading = stressReading(tick)
  const feed = feedChip(tick.target_label, tick.price_label)
  return fromTick(
    tick,
    calm,
    { ageMin: reading.ageMin, label: reading.asOfLabel, pinned: reading.clockPinned },
    qualityStatus(reading.quality, feed, reading.clockPinned, "demo").status,
    {
      outageMw: reading.outageMw,
      thresholdMw: reading.thresholdMw,
      marginMw: signedOutageMargin(reading),
      zone: reading.zone,
      zoneMw: reading.zoneMw,
    },
  )
}

/**
 * Live: engine tiles stay on the tape; price, outage, zone, as-of, and quality come from the poll.
 * AS OF is feed lag unless the operator pins the clock.
 */
export function liveSnapshot(tick: TickView, watch: LiveWatch, calm: number, operatorPinned = false): WallSnapshot {
  const viewed = viewTick(tick, watch)
  const reading = stressReading(viewed)
  const shown = readingForMode(reading, operatorPinned ? "demo" : "live")
  const tape = stressReading(tick)
  const code = watch.latest?.quality ?? reading.quality
  const asOf = operatorPinned
    ? { ageMin: tape.ageMin, label: tape.asOfLabel, pinned: true }
    : { ageMin: shown.ageMin, label: shown.asOfLabel, pinned: false }
  return fromTick(viewed, calm, asOf, liveQuality(code), {
    outageMw: shown.outageMw,
    thresholdMw: shown.thresholdMw,
    marginMw: signedOutageMargin(shown),
    zone: shown.zone,
    zoneMw: shown.zoneMw,
  })
}

export type SnapshotSource = {
  runtime: RuntimeMode
  tick: TickView
  calm: number
  watch?: LiveWatch
  operatorPinned?: boolean
}

/** Both modes fill the same type. */
export function wallSnapshot(source: SnapshotSource): WallSnapshot {
  switch (source.runtime) {
    case "live":
      return liveSnapshot(source.tick, source.watch ?? EMPTY_WATCH, source.calm, source.operatorPinned)
    case "demo":
      return demoSnapshot(source.tick, source.calm)
    default: {
      const neverRuntime: never = source.runtime
      return neverRuntime
    }
  }
}
