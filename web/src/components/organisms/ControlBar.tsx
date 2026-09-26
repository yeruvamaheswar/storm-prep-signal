import { useEffect, useRef, type ReactNode } from "react"
import type { Mode, TickView } from "../../contracts"
import type { SceneId } from "../../fixtures/scenes"
import { Button } from "../atoms/Button"
import { Control } from "../molecules/Control"
import {
  chartPoint,
  padTick,
  polyline,
  seriesMax,
  tapeColumns,
  tapeSummary,
  tickButtonLabel,
  type TapeColumn,
  type TapeEvent,
} from "./tapeSpark"

type WallScene = SceneId | "high"

/** The storm tick has zero dead homes, so High moves on to the tick where they die. */
const HIGH_ADVANCE_MS = 2000

type ControlBarProps = {
  mode: Mode
  ticks: TickView[]
  selected: number
  scene: WallScene | null
  radar: boolean
  onSelect: (index: number) => void
  onScene: (scene: WallScene) => void
  onRadar: () => void
}

export function ControlBar({ mode, ticks, selected, scene, radar, onSelect, onScene, onRadar }: ControlBarProps) {
  const columns = tapeColumns(ticks)
  const max = seriesMax(columns)
  const targetLine = polyline(columns, "target", max)
  const deliveredLine = polyline(columns, "delivered", max)
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
    <footer className="control-bar">
      <div className="controls">
        <Control
          name="HOLD"
          pressed={mode === "HOLD"}
          armed={mode === "HOLD"}
          onClick={() => {
            console.log("HOLD")
          }}
        />
        <Control
          name="AUTO"
          pressed={mode === "AUTO"}
          onClick={() => {
            console.log("AUTO")
          }}
        />
        <p className={mode === "HOLD" ? "control-status is-hold" : "control-status"} role="status">
          {statusSentence(mode)}
        </p>
        <div className="scene-keys" role="tablist" aria-label="Failure scenes">
          <Button pressed={scene === "devices"} label="15 percent dead and a few stale" onClick={() => onScene("devices")}>
            15% dead
          </Button>
          <Button pressed={scene === "failsafe"} label="Fail-safe, risk unknown" onClick={() => onScene("failsafe")}>
            Fail-safe
          </Button>
          <Button
            pressed={scene === "high"}
            label="High outage tick, then the tick where homes die after two seconds"
            onClick={() => onScene("high")}
          >
            High
          </Button>
        </div>
        <Control name="Radar" pressed={radar} onClick={onRadar} />
      </div>
      <div className="tape">
        <TapeCaption columns={columns} />
        <svg
          className="tape-spark"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          role="img"
          aria-label={tapeSummary(columns)}
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
          <polyline className="tape-line tape-line-target" points={targetLine} />
          <polyline className="tape-line tape-line-delivered" points={deliveredLine} />
          {columns.map((column) =>
            column.events
              .filter((event) => event !== "home-died")
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
    </footer>
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
      const priorDelivered =
        prior === undefined ? null : chartPoint(prior.index, count, prior.delivered, max)
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

function TapeCaption({ columns }: { columns: TapeColumn[] }) {
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

function statusSentence(mode: Mode): string {
  switch (mode) {
    case "AUTO":
      return "AUTO · default"
    case "HOLD":
      return "HOLD · discharge frozen"
    default: {
      const neverMode: never = mode
      return neverMode
    }
  }
}
