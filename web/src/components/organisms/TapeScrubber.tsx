import { useEffect, useRef, type ReactNode } from "react"
import type { TickView } from "../../contracts"
import { zoneCallout, zoneFacts, zoneOutageSeries } from "../../zoneLens"
import type { LoadZone } from "../../zonePaint"
import { Button } from "../atoms/Button"
import {
  chartPoint,
  padTick,
  polyline,
  seriesMax,
  tapeColumns,
  tapeSummary,
  tickButtonLabel,
  valuesPolyline,
  type TapeColumn,
  type TapeEvent,
} from "./tapeSpark"

type WallScene = "failsafe" | "devices" | "high"

/** The storm tick has zero dead homes, so High moves on to the tick where they die. */
const HIGH_ADVANCE_MS = 2000

type TapeScrubberProps = {
  ticks: TickView[]
  selected: number
  scene: WallScene | null
  onSelect: (index: number) => void
  zone?: LoadZone | null
  zoneTick?: TickView
}

export function TapeScrubber({
  ticks,
  selected,
  scene,
  onSelect,
  zone = null,
  zoneTick,
}: TapeScrubberProps) {
  const columns = tapeColumns(ticks)
  const max = seriesMax(columns)
  const targetLine = polyline(columns, "target", max)
  const deliveredLine = polyline(columns, "delivered", max)
  const lens = zone === null || zoneTick === undefined ? null : zoneFacts(zoneTick, zone)
  const outageValues = zone === null ? null : zoneOutageSeries(ticks, zone)
  const outageMax = outageValues === null ? 0 : outageValues.reduce((peak, value) => Math.max(peak, value), 0)
  const outageLine = outageValues === null ? "" : valuesPolyline(outageValues, outageMax)
  const advanceTo = scene === "high" ? nextDeathIndex(columns, selected) : null
  const selectRef = useRef(onSelect)

  useEffect(() => {
    selectRef.current = onSelect
  })

  useEffect(() => {
    if (advanceTo === null) {
      return
    }
    const timer = window.setTimeout(() => {
      selectRef.current(advanceTo)
    }, HIGH_ADVANCE_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [advanceTo])

  return (
    <div className="tape">
      <TapeCaption columns={columns} zoneFacts={lens === null ? null : zoneCallout(lens)} />
      <svg
        className="tape-spark"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        role="img"
        aria-label={lens === null ? tapeSummary(columns) : `${lens.zone} outage MW across ${String(columns.length)} ticks. ${zoneCallout(lens)}`}
      >
        {columns.map((column) =>
          column.events.includes("home-died") ? (
            <EventMark
              key={`${column.tick}-died`}
              column={column}
              columns={columns}
              count={columns.length}
              max={max}
              event="home-died"
            />
          ) : null,
        )}
        {lens === null ? <polyline className="tape-line tape-line-target" points={targetLine} /> : null}
        {lens === null ? (
          <polyline className="tape-line tape-line-delivered" points={deliveredLine} />
        ) : (
          <polyline className="tape-line tape-line-target" points={outageLine} />
        )}
        {columns.map((column) =>
          column.events
            .filter((event) => event !== "home-died" && (lens === null || event !== "missed-on-purpose"))
            .map((event) => (
              <EventMark
                key={`${column.tick}-${event}`}
                column={column}
                columns={columns}
                count={columns.length}
                max={max}
                event={event}
              />
            )),
        )}
      </svg>
      <div
        className="tick-keys"
        role="tablist"
        aria-label="Ticks"
        style={{ gridTemplateColumns: `repeat(${String(Math.max(columns.length, 1))}, minmax(0, 1fr))` }}
      >
        {columns.map((column) => (
          <div key={column.tick} className={chipClass(column)} data-events={column.events.join(" ")}>
            <Button
              pressed={column.index === selected}
              label={tickButtonLabel(column)}
              onClick={() => {
                onSelect(column.index)
              }}
            >
              {padTick(column.tick)}
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}

function EventMark({
  column,
  columns,
  count,
  max,
  event,
}: {
  column: TapeColumn
  columns: TapeColumn[]
  count: number
  max: number
  event: TapeEvent
}) {
  const x = chartPoint(column.index, count, column.target, max).x
  switch (event) {
    case "risk-high":
      return <line className="tape-ruler tape-ruler-risk" x1={x} x2={x} y1={0} y2={10} />
    case "home-died":
      return <line className="tape-ruler tape-ruler-died" x1={x} x2={x} y1={0} y2={100} />
    case "missed-on-purpose": {
      const target = chartPoint(column.index, count, column.target, max)
      const delivered = chartPoint(column.index, count, column.delivered, max)
      const prior = column.index > 0 ? columns[column.index - 1] : undefined
      const priorDelivered = prior === undefined ? null : chartPoint(prior.index, count, prior.delivered, max)
      return (
        <g>
          {priorDelivered === null ? null : (
            <line
              className="tape-gap"
              x1={priorDelivered.x}
              x2={delivered.x}
              y1={priorDelivered.y}
              y2={delivered.y}
            />
          )}
          <line className="tape-gap" x1={target.x} x2={delivered.x} y1={target.y} y2={delivered.y} />
        </g>
      )
    }
    default: {
      const neverEvent: never = event
      return neverEvent
    }
  }
}

function TapeCaption({ columns, zoneFacts: zoneFactsLine }: { columns: TapeColumn[]; zoneFacts: string | null }) {
  if (zoneFactsLine !== null) {
    return (
      <p className="tape-caption">
        <span className="tape-swatch">{zoneFactsLine}</span>
      </p>
    )
  }
  const notes: ReactNode[] = []
  for (const column of columns) {
    const label = padTick(column.tick)
    if (column.events.includes("missed-on-purpose")) {
      const risk = column.events.includes("risk-high") ? " · risk HIGH" : ""
      notes.push(
        <span key={`${column.tick}-purpose`} className="tape-purpose">
          {label} missed on purpose{risk}
        </span>,
      )
    } else if (column.events.includes("risk-high")) {
      notes.push(
        <span key={`${column.tick}-risk`} className="tape-purpose">
          {label} risk flipped HIGH
        </span>,
      )
    }
    if (column.events.includes("home-died")) {
      notes.push(
        <span key={`${column.tick}-died`} className="tape-died">
          {label} homes died
        </span>,
      )
    }
  }

  return (
    <p className="tape-caption">
      <span className="tape-swatch">Target</span>
      <span className="tape-swatch tape-swatch-delivered">Delivered</span>
      {notes}
    </p>
  )
}

function nextDeathIndex(columns: TapeColumn[], after: number): number | null {
  const next = columns.find((column) => column.index > after && column.events.includes("home-died"))
  return next === undefined ? null : next.index
}

function chipClass(column: TapeColumn): string {
  if (column.events.includes("missed-on-purpose")) {
    return "tick-key tick-key-purpose"
  }
  if (column.events.includes("home-died")) {
    return "tick-key tick-key-died"
  }
  if (column.events.includes("risk-high")) {
    return "tick-key tick-key-risk"
  }
  return "tick-key"
}
