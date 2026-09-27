import type { CSSProperties } from "react"
import {
  GRID_NODE,
  VIEW_H,
  VIEW_W,
  flowDirection,
  flowPath,
  flowStroke,
  fmtMw,
  fmtUsd,
  zoneCapMw,
  type ZoneShape,
} from "./flowMath"
import type { FlowTick, FlowZoneRow } from "./types"

// Nudges so a label clears the flow line and the coast. SVG units.
const LABEL_NUDGE: Record<string, [number, number]> = {
  West: [-10, 30],
  North: [0, 40],
  South: [-20, 30],
  Houston: [34, 40],
}

type Props = {
  shapes: ZoneShape[]
  zones: Partial<Record<string, FlowZoneRow>>
  tick: FlowTick | null
  chargingMw: number
  packKw: number
  selectedZone: string | null
  onSelect: (zone: string | null) => void
}

export function GridFlow({ shapes, zones, tick, chargingMw, packKw, selectedZone, onSelect }: Props) {
  return (
    <svg className="flow-map" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img"
      aria-label="Power flow between the ERCOT grid and the four load zones">
      {shapes.map((shape) => {
        const row = zones[shape.zone]
        const classes = ["flow-zone"]
        if (shape.zone === selectedZone) classes.push("is-selected")
        if (row?.grid_down) classes.push("is-down")
        return (
          <path key={`zone-${shape.zone}`} d={shape.path} className={classes.join(" ")}
            role="button" tabIndex={0} aria-label={`Open ${shape.zone} batteries`}
            onClick={() => onSelect(shape.zone === selectedZone ? null : shape.zone)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") onSelect(shape.zone === selectedZone ? null : shape.zone)
            }} />
        )
      })}

      {shapes.map((shape) => {
        const row = zones[shape.zone]
        const direction = flowDirection(row)
        const d = flowPath(shape.centroid)
        const net = row ? row.selling_mw - row.charging_mw : 0
        const stroke = flowStroke(net, zoneCapMw(row?.homes ?? 25, packKw))
        const style = { strokeWidth: stroke.width, animationDuration: `${stroke.seconds.toFixed(2)}s` } as CSSProperties
        return (
          <g key={`line-${shape.zone}`}>
            <path d={d} className="flow-rail" />
            {direction === "export" || direction === "import" ? (
              <path d={d} className={`flow-line flow-${direction}`} style={style} />
            ) : null}
            {direction === "down" ? <path d={d} className="flow-line flow-down" /> : null}
          </g>
        )
      })}

      {shapes.map((shape) => {
        const row = zones[shape.zone]
        const [dx, dy] = LABEL_NUDGE[shape.zone] ?? [0, 24]
        const x = shape.centroid[0] + dx
        const y = shape.centroid[1] + dy
        return (
          <g key={`label-${shape.zone}`} className="flow-label" transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}>
            <text className="flow-label-name" y={0}>{shape.zone}</text>
            {row ? (
              <>
                <text className="flow-label-line" y={15}>
                  {row.grid_down ? "grid down · overlay" : `sell ${fmtMw(row.selling_mw)}`}
                </text>
                {row.charging_mw > 0 ? <text className="flow-label-line" y={29}>charge {fmtMw(row.charging_mw)}</text> : null}
                <text className="flow-label-line" y={row.charging_mw > 0 ? 43 : 29}>
                  floor {row.reserve_pct}% · {fmtUsd(row.price_usd_mwh)}
                </text>
              </>
            ) : null}
          </g>
        )
      })}

      <g className="flow-grid" transform={`translate(${GRID_NODE[0]} ${GRID_NODE[1]})`}>
        <rect x={-150} y={-44} width={300} height={88} />
        <text className="flow-grid-title" y={-24}>ERCOT grid</text>
        <text className="flow-grid-line" y={-4}>
          asks {fmtMw(tick?.target_mw)} · {tick?.target_label ?? "no tick yet"}
        </text>
        <text className="flow-grid-line" y={14}>fleet gives {fmtMw(tick?.delivered_mw)} · confirmed</text>
        <text className="flow-grid-line" y={32}>fleet absorbs {fmtMw(chargingMw)} · charging</text>
      </g>
    </svg>
  )
}
