import type { ReactNode } from "react"
import { chartPoint, valuesPolyline } from "../../chartPlot"
import {
  eventNote,
  intervalPeak,
  intervalSummary,
  rollingIntervals,
  type IntervalEvent,
  type IntervalPoint,
} from "../../intervalSeries"

type IntervalStripProps = {
  intervals: readonly IntervalPoint[]
}

export function IntervalStrip({ intervals }: IntervalStripProps) {
  const points = rollingIntervals(intervals)
  if (points.length === 0) {
    return (
      <div className="tape">
        <p className="tape-caption">Waiting for intervals</p>
        <div className="interval-skeleton" aria-hidden="true" />
      </div>
    )
  }

  const max = intervalPeak(points)
  const targetLine = valuesPolyline(
    points.map((point) => point.targetMw),
    max,
  )
  const deliveredLine = valuesPolyline(
    points.map((point) => point.deliveredMw),
    max,
  )
  const reservedLine = valuesPolyline(
    points.map((point) => point.reservedMw),
    max,
  )

  return (
    <div className="tape">
      <IntervalCaption points={points} />
      <svg
        className="tape-spark"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        role="img"
        aria-label={intervalSummary(points)}
      >
        {points.map((point, index) =>
          point.events.includes("homes-offline") ? (
            <EventMark key={`${point.ts}-homes-offline`} point={point} index={index} count={points.length} max={max} event="homes-offline" />
          ) : null,
        )}
        <polyline className="tape-line tape-line-target" points={targetLine} />
        <polyline className="tape-line tape-line-delivered" points={deliveredLine} />
        <polyline className="tape-line tape-line-reserved" points={reservedLine} />
        {points.map((point, index) =>
          point.events
            .filter((event) => event !== "homes-offline")
            .map((event) => (
              <EventMark
                key={`${point.ts}-${event}`}
                point={point}
                index={index}
                count={points.length}
                max={max}
                event={event}
              />
            )),
        )}
      </svg>
    </div>
  )
}

function EventMark({
  point,
  index,
  count,
  max,
  event,
}: {
  point: IntervalPoint
  index: number
  count: number
  max: number
  event: IntervalEvent
}) {
  const x = chartPoint(index, count, point.targetMw, max).x
  switch (event) {
    case "risk-high":
      return <line className="tape-ruler tape-ruler-risk" x1={x} x2={x} y1={0} y2={10} />
    case "floor-raised":
      return <line className="tape-ruler tape-ruler-floor" x1={x} x2={x} y1={90} y2={100} />
    case "homes-offline":
      return <line className="tape-ruler tape-ruler-died" x1={x} x2={x} y1={0} y2={100} />
    case "hold":
      return <line className="tape-ruler tape-ruler-hold" x1={x} x2={x} y1={45} y2={55} />
    default: {
      const neverEvent: never = event
      return neverEvent
    }
  }
}

function IntervalCaption({ points }: { points: readonly IntervalPoint[] }) {
  const notes: ReactNode[] = []
  for (const point of points) {
    for (const event of point.events) {
      const kind = event === "homes-offline" ? "tape-died" : "tape-purpose"
      notes.push(
        <span key={`${point.ts}-${event}`} className={kind}>
          {point.label} {eventNote(event)}
        </span>,
      )
    }
  }
  return (
    <p className="tape-caption">
      <span className="tape-swatch">Target</span>
      <span className="tape-swatch tape-swatch-delivered">Delivered</span>
      <span className="tape-swatch tape-swatch-reserved">Reserved</span>
      {notes}
    </p>
  )
}
