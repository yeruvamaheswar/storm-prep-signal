import type { Mode, RiskLevel, TickView } from "./contracts"
import { feedChip, tickBrief } from "./format"
import { EMPTY_WATCH, viewTick, type LiveWatch } from "./liveStamp"
import { liveQuality, qualityStatus, type OperatorQuality } from "./qualityStatus"
import { readingForMode, type RuntimeMode } from "./runtimeMode"
import { stressReading } from "./stressReading"
import { signedOutageMargin } from "./wallLines"
import type { LoadZone } from "./zonePaint"

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
  brief: string
}

function finitePrice(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** Selected zone uses its LZ row. No selection keeps the tick's stamped price. */
function priceForSnapshot(tick: TickView, zone?: LoadZone | null): number | null {
  if (zone != null && tick.zone_prices !== undefined) {
    return finitePrice(tick.zone_prices[zone])
  }
  return tick.price_usd_mwh
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
  brief: string,
  zone?: LoadZone | null,
): WallSnapshot {
  return {
    targetMw: tick.target_mw,
    deliveredMw: tick.delivered_mw,
    missedMw: tick.missed_mw,
    priceMwh: priceForSnapshot(tick, zone),
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
    brief,
  }
}

/** Demo: every tile is the tape, including a pinned fixture clock. */
export function demoSnapshot(
  tick: TickView,
  calm: number,
  fallbackQuality?: string | null,
  zone?: LoadZone | null,
): WallSnapshot {
  const reading = stressReading(tick)
  const feed = feedChip(tick.target_label, tick.price_label)
  return fromTick(
    tick,
    calm,
    { ageMin: reading.ageMin, label: reading.asOfLabel, pinned: reading.clockPinned },
    fallbackQuality
      ? liveQuality(fallbackQuality)
      : qualityStatus(reading.quality, feed, reading.clockPinned, "demo").status,
    {
      outageMw: reading.outageMw,
      thresholdMw: reading.thresholdMw,
      marginMw: signedOutageMargin(reading),
      zone: reading.zone,
      zoneMw: reading.zoneMw,
    },
    tick.brief,
    zone,
  )
}

const FAIL_SAFE_FLOOR = 60

/**
 * Live: the snapshot tick plus ingest health. A bad current pull is fail-safe
 * (floor 60, risk unknown). Last-good price and as-of stay. AS OF is feed lag
 * unless the operator pins the clock.
 */
export function liveSnapshot(
  tick: TickView,
  watch: LiveWatch,
  calm: number,
  operatorPinned = false,
  zone: LoadZone | null = null,
): WallSnapshot {
  const viewed = viewTick(tick, watch)
  const latest = watch.latest
  const failed = latest !== null && latest.quality !== "ok"
  const rated = latest !== null && latest.quality === "ok" ? latest : null
  const headerTick: TickView = failed
    ? { ...viewed, risk_level: null, reserve_pct: FAIL_SAFE_FLOOR }
    : rated !== null && rated.reservePct !== undefined
      ? { ...viewed, reserve_pct: rated.reservePct, risk_level: rated.risk ?? viewed.risk_level }
      : viewed
  const reading = stressReading(headerTick)
  const shown = readingForMode(reading, operatorPinned ? "demo" : "live")
  const tape = stressReading(tick)
  const code = latest?.quality ?? reading.quality
  const asOf = operatorPinned
    ? { ageMin: tape.ageMin, label: tape.asOfLabel, pinned: true }
    : { ageMin: shown.ageMin, label: shown.asOfLabel, pinned: false }
  const bareFail = failed && watch.lastOk === null
  const trigger = typeof rated?.triggerMw === "number" ? rated.triggerMw : typeof headerTick.trigger_mw === "number" ? headerTick.trigger_mw : null
  const priceTick: TickView = {
    ...headerTick,
    price_usd_mwh: headerTick.price_label === "ercot" ? headerTick.price_usd_mwh : rated !== null ? rated.priceUsdMwh : null,
    price_label: headerTick.price_label === "ercot" || rated !== null ? "ercot" : "none",
  }
  return fromTick(priceTick, calm, asOf, liveQuality(code), {
    outageMw: bareFail ? null : shown.outageMw,
    thresholdMw: bareFail ? null : trigger,
    marginMw: bareFail ? null : trigger !== null && shown.outageMw !== null ? shown.outageMw - trigger : null,
    zone: shown.zone,
    zoneMw: shown.zoneMw,
  }, tickBrief(headerTick), zone)
}

export type SnapshotSource = {
  runtime: RuntimeMode
  tick: TickView
  calm: number
  watch?: LiveWatch
  operatorPinned?: boolean
  fallbackQuality?: string | null
  zone?: LoadZone | null
}

/** Both modes fill the same type. */
export function wallSnapshot(source: SnapshotSource): WallSnapshot {
  switch (source.runtime) {
    case "live":
      return liveSnapshot(source.tick, source.watch ?? EMPTY_WATCH, source.calm, source.operatorPinned, source.zone ?? null)
    case "demo":
      return demoSnapshot(source.tick, source.calm, source.fallbackQuality, source.zone)
    default: {
      const neverRuntime: never = source.runtime
      return neverRuntime
    }
  }
}
