import { healthText, type ApiHealth } from "../../api/health"
import { riskCaption } from "../../calmStreak"
import type { TickView } from "../../contracts"
import { feedChip, formatGridMw, formatMw, formatPrice, formatSignedGridMw, formatTs, headerIdentity, headerReason, modeName, riskName } from "../../format"
import { qualityView } from "../../qualityStatus"
import type { ReportFeeds } from "../../reportFeeds"
import { runtimeLabel, type RuntimeMode } from "../../runtimeMode"
import { outageLine, deliverableFloorCaption } from "../../wallLines"
import { wallSnapshot, type SnapshotAsOf, type WallSnapshot } from "../../wallSnapshot"
import type { WallOrigin } from "../../wallOrigin"
import { Metric } from "../atoms/Metric"
import { CalmMeter } from "../molecules/CalmMeter"
import { StripItem } from "../molecules/StripItem"
import { FeedChips, FeedsList } from "./ReportsDrawer"

type TopStripProps = {
  tick: TickView
  runId: string
  decisionLine?: string | null
  tickCount: number
  calm: number
  sceneLabel?: string
  snapshot?: WallSnapshot
  runtime?: RuntimeMode
  intervalLabel?: string
  clockLabel?: string
  feeds?: ReportFeeds
  api: ApiHealth
  origin?: WallOrigin
}

function apiTone(api: ApiHealth): string {
  switch (api.state) {
    case "checking":
      return "api-status"
    case "ok":
      return "api-status tone-ok"
    case "down":
      return "api-status tone-dead"
    default: {
      const unreachable: never = api
      return unreachable
    }
  }
}

export function TopStrip({
  tick,
  runId,
  decisionLine = null,
  tickCount,
  calm,
  sceneLabel,
  snapshot,
  runtime = "demo",
  intervalLabel,
  clockLabel,
  feeds,
  api,
  origin,
}: TopStripProps) {
  const row = snapshot ?? wallSnapshot({ runtime, tick, calm })
  const line = outageLine({
    outageMw: row.outageMw,
    thresholdMw: row.outageThresholdMw,
    marginMw: row.marginMw,
    zone: row.zone,
    zoneMw: row.zoneMw,
    asOfLabel: row.asOf.label,
    ageMin: row.asOf.ageMin,
    clockPinned: row.asOf.pinned,
    quality: row.quality,
  })
  const missed = row.missedMw > 0
  const feed =
    origin?.kind === "archive" ? "ARCHIVE" : origin?.kind === "live" || runtime === "live" ? "LIVE" : feedChip(tick.target_label, tick.price_label)
  const identity = headerIdentity(runId, decisionLine)
  const when =
    origin?.clock === "archive" || origin?.kind === "archive"
      ? formatTs(isoClock(origin?.clockAt) ?? tick.ts)
      : runtime === "live" && origin?.kind !== "fixture"
        ? (clockLabel ?? formatTs(tick.ts))
        : formatTs(tick.ts)
  const place =
    origin !== undefined && origin.kind !== "fixture"
      ? origin.place
      : runtime === "live"
        ? `${runtimeLabel(runtime)} · ${intervalLabel ?? "—"}`
        : (sceneLabel ?? tickPlace(tick.tick, tickCount))
  const floor = headerReason(tick.policy_reason)
  const risk = headerReason(riskCaption(tick, row.calm))
  const floorTone = tick.policy_reason === "normal" ? "ink" : "reserved"
  const riskTone = row.risk === "HIGH" ? "reserved" : row.risk === "LOW" ? "ok" : "dead"

  return (
    <header className="top-strip">
      <div className="mast">
        <div className="mast-head">
          <h1>ReserveGate</h1>
        </div>
        <p>
          {place}
          <span className="mast-gap" />
          {when}
          <span className="mast-gap" />
          {modeName(tick.mode)}
          <span className="mast-gap" />
          <span className="source-chip">{feed}</span>
          {identity.runId !== null ? (
            <>
              <span className="mast-gap" />
              <span className="run-id">{identity.runId}</span>
            </>
          ) : null}
          {(origin?.kind ?? "fixture") === "fixture" && runtime === "demo" && identity.demoTitle !== null ? (
            <>
              <span className="mast-gap" />
              <span className="demo-badge" title={identity.demoTitle}>
                Demo
              </span>
            </>
          ) : null}
          <span className="mast-gap" />
          <span className={apiTone(api)} role="status">
            {healthText(api)}
          </span>
        </p>
      </div>
      <div key={tick.tick}>
        <div className="strip">
          <div className="strip-pair">
            <StripItem name="Target">
              <Metric value={formatMw(row.targetMw)} unit="MW" tone="ink" />
            </StripItem>
            <StripItem name="Delivered">
              <Metric
                value={formatMw(row.deliveredMw)}
                unit="MW"
                caption={deliverableFloorCaption(row.floorPct)}
                title="Delivered MW versus the home reserve floor"
              />
            </StripItem>
            <div className={missed ? "strip-miss" : "strip-miss is-quiet"}>
              <StripItem name="Missed">
                <Metric
                  value={formatMw(row.missedMw)}
                  unit="MW"
                  caption={missed ? "left unsold" : undefined}
                  tone={missed ? "reserved" : "ink"}
                />
              </StripItem>
            </div>
          </div>
          <StripItem name="Price">
            <Metric value={formatPrice(row.priceMwh)} unit="$/MWh" />
          </StripItem>
          <StripItem name="Floor">
            <Metric value={String(row.floorPct)} unit="%" caption={floor.label} title={floor.tooltip} tone={floorTone} />
          </StripItem>
          <StripItem name="Risk">
            <Metric value={riskName(row.risk)} unit="" caption={risk.label} title={risk.tooltip} tone={riskTone} />
          </StripItem>
          <StripItem name="Calm">
            <CalmMeter streak={row.calm} />
          </StripItem>
        </div>
        <StressStrip snapshot={row} line={line} runtime={runtime} feeds={feeds} />
      </div>
    </header>
  )
}

function StressStrip({
  snapshot,
  line,
  runtime,
  feeds,
}: {
  snapshot: WallSnapshot
  line: ReturnType<typeof outageLine>
  runtime: RuntimeMode
  feeds?: ReportFeeds
}) {
  const marginTone = line.side === "past" ? "reserved" : "ink"
  const quality = feeds?.quality ?? qualityView(snapshot.quality)
  return (
    <section className="stress-strip" aria-label="Storm Prep">
      <StripItem name="Outage">
        <StressFact
          value={snapshot.outageMw === null ? "—" : formatGridMw(snapshot.outageMw)}
          unit={snapshot.outageMw === null ? "" : "MW"}
          caption={thresholdCaption(snapshot.outageThresholdMw)}
        />
      </StripItem>
      <StripItem name="Margin">
        <StressFact
          value={line.marginMw === null ? "—" : formatSignedGridMw(line.marginMw)}
          unit={line.marginMw === null ? "" : "MW"}
          caption={line.marginCaption}
          title={line.trigger ?? undefined}
          tone={marginTone}
        />
      </StripItem>
      <StripItem name="Zone">
        <StressFact value={snapshot.zone ?? "—"} unit="" caption={zoneCaption(snapshot.zoneMw)} />
      </StripItem>
      <StripItem name="As of">
        <StressFact
          value={snapshot.asOf.ageMin === null ? "—" : String(snapshot.asOf.ageMin)}
          unit={snapshot.asOf.ageMin === null ? "" : "min"}
          caption={ageCaption(snapshot.asOf, runtime)}
        />
      </StripItem>
      <StripItem name="Quality">
        {feeds === undefined ? (
          <StressFact
            value={quality.label}
            unit=""
            caption={quality.reason}
            tone={quality.tone}
            title={quality.tooltip}
          />
        ) : (
          <details className="feeds-popover">
            <summary aria-label="Feeds freshness">
              <StressFact
                value={quality.label}
                unit=""
                caption={quality.reason}
                tone={quality.tone}
                title={quality.tooltip}
              />
            </summary>
            <div className="feeds-panel">
              {feeds.purpose !== null ? <p className="reports-purpose">{feeds.purpose}</p> : null}
              <FeedChips products={feeds.chips} />
              <FeedsList rows={feeds.rows} />
            </div>
          </details>
        )}
      </StripItem>
    </section>
  )
}

function StressFact({
  value,
  unit,
  caption,
  tone = "ink",
  title,
}: {
  value: string
  unit: string
  caption: string
  tone?: "ink" | "ok" | "reserved" | "dead" | "stale"
  title?: string
}) {
  return (
    <div className="stress-fact" title={title}>
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

function zoneCaption(zoneMw: number | null): string {
  if (zoneMw === null) {
    return "zone MW missing"
  }
  return `${formatGridMw(zoneMw)} MW`
}

function tickPlace(tick: number, tickCount: number): string {
  return `tick ${String(tick).padStart(2, "0")} / ${String(tickCount).padStart(2, "0")}`
}

function isoClock(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value.includes("T")) return null
  return value
}

function ageCaption(asOf: SnapshotAsOf, runtime: RuntimeMode): string {
  if (asOf.pinned) {
    return `${asOf.label ?? "time missing"} · clock pinned`
  }
  if (runtime === "live" && asOf.label === null) {
    return "waiting on pull"
  }
  return asOf.label ?? "time missing"
}

