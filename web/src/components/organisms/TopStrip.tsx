import { riskCaption } from "../../calmStreak"
import type { TickView } from "../../contracts"
import { feedChip, formatGridMw, formatMw, formatPrice, formatSignedGridMw, formatTs, modeName, riskName } from "../../format"
import { stressReading, type StressReading } from "../../stressReading"
import { Metric } from "../atoms/Metric"
import { CalmMeter } from "../molecules/CalmMeter"
import { StripItem } from "../molecules/StripItem"

type TopStripProps = {
  tick: TickView
  runId: string
  tickCount: number
  calm: number
  sceneLabel?: string
}

export function TopStrip({ tick, runId, tickCount, calm, sceneLabel }: TopStripProps) {
  const missed = tick.missed_mw > 0
  const floorTone = tick.policy_reason === "normal" ? "ink" : "reserved"
  const riskTone = tick.risk_level === "HIGH" ? "reserved" : tick.risk_level === "LOW" ? "ok" : "dead"

  return (
    <header className="top-strip">
      <div className="mast">
        <div className="mast-head">
          <h1>ReserveGate</h1>
          <span className="source-chip">{feedChip(tick.target_label, tick.price_label)}</span>
        </div>
        <p>
          {sceneLabel ?? `tick ${String(tick.tick).padStart(2, "0")} / ${String(tickCount).padStart(2, "0")}`}
          <span className="mast-gap" />
          {formatTs(tick.ts)}
          <span className="mast-gap" />
          {modeName(tick.mode)}
          <span className="mast-gap" />
          <span className="run-id">{runId}</span>
        </p>
      </div>
      <div key={tick.tick}>
        <div className="strip">
          <div className="strip-pair">
            <StripItem name="Target">
              <Metric value={formatMw(tick.target_mw)} unit="MW" tone="ink" />
            </StripItem>
            <StripItem name="Delivered">
              <Metric value={formatMw(tick.delivered_mw)} unit="MW" />
            </StripItem>
            <div className={missed ? "strip-miss" : "strip-miss is-quiet"}>
              <StripItem name="Missed">
                <Metric
                  value={formatMw(tick.missed_mw)}
                  unit="MW"
                  caption={missed ? "left unsold" : undefined}
                  tone={missed ? "reserved" : "ink"}
                />
              </StripItem>
            </div>
          </div>
          <StripItem name="Price">
            <Metric value={formatPrice(tick.price_usd_mwh)} unit="$/MWh" />
          </StripItem>
          <StripItem name="Floor">
            <Metric value={String(tick.reserve_pct)} unit="%" caption={tick.policy_reason} tone={floorTone} />
          </StripItem>
          <StripItem name="Risk">
            <Metric value={riskName(tick.risk_level)} unit="" caption={riskCaption(tick, calm)} tone={riskTone} />
          </StripItem>
          <StripItem name="Calm">
            <CalmMeter streak={calm} />
          </StripItem>
        </div>
        <StressStrip reading={stressReading(tick)} />
      </div>
    </header>
  )
}

function StressStrip({ reading }: { reading: StressReading }) {
  const marginTone = reading.marginMw !== null && reading.marginMw > 0 ? "reserved" : "ink"
  return (
    <section className="stress-strip" aria-label="Storm Prep">
      <StripItem name="Outage">
        <StressFact
          value={reading.outageMw === null ? "—" : formatGridMw(reading.outageMw)}
          unit={reading.outageMw === null ? "" : "MW"}
          caption={thresholdCaption(reading.thresholdMw)}
        />
      </StripItem>
      <StripItem name="Margin">
        <StressFact
          value={reading.marginMw === null ? "—" : formatSignedGridMw(reading.marginMw)}
          unit={reading.marginMw === null ? "" : "MW"}
          caption={marginCaption(reading.marginMw)}
          tone={marginTone}
        />
      </StripItem>
      <StripItem name="Zone">
        <StressFact value={reading.zone ?? "—"} unit="" caption={zoneCaption(reading.zoneMw)} />
      </StripItem>
      <StripItem name="As of">
        <StressFact
          value={reading.ageMin === null ? "—" : String(reading.ageMin)}
          unit={reading.ageMin === null ? "" : "min"}
          caption={ageCaption(reading)}
        />
      </StripItem>
      <StripItem name="Quality">
        <StressFact value={reading.quality} unit="" caption={qualityCaption(reading.quality)} tone={qualityTone(reading.quality)} />
      </StripItem>
    </section>
  )
}

function StressFact({
  value,
  unit,
  caption,
  tone = "ink",
}: {
  value: string
  unit: string
  caption: string
  tone?: "ink" | "ok" | "reserved" | "dead" | "stale"
}) {
  return (
    <div className="stress-fact">
      <div className={`stress-value tone-${tone}`}>
        {value}
        {unit ? <span className="metric-unit">{unit}</span> : null}
      </div>
      <div className="metric-caption">{caption}</div>
    </div>
  )
}

function thresholdCaption(thresholdMw: number | null): string {
  if (thresholdMw === null) {
    return "no threshold"
  }
  return `vs ${formatGridMw(thresholdMw)} MW threshold`
}

function marginCaption(marginMw: number | null): string {
  if (marginMw === null) {
    return "no margin"
  }
  if (marginMw > 0) {
    return "above the line"
  }
  if (marginMw < 0) {
    return "under the line"
  }
  return "on the line"
}

function zoneCaption(zoneMw: number | null): string {
  if (zoneMw === null) {
    return "zone MW missing"
  }
  return `${formatGridMw(zoneMw)} MW`
}

function ageCaption(reading: StressReading): string {
  const stamp = reading.asOfLabel ?? "time missing"
  if (reading.clockPinned) {
    return `${stamp} · clock pinned`
  }
  return stamp
}

function qualityCaption(quality: string): string {
  if (quality === "ok") {
    return "check passed"
  }
  if (quality === "unchecked") {
    return "no check ran"
  }
  return "named fail"
}

function qualityTone(quality: string): "ok" | "stale" | "dead" {
  if (quality === "ok") {
    return "ok"
  }
  if (quality === "unchecked") {
    return "stale"
  }
  return "dead"
}
