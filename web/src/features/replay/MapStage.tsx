import { useEffect, useMemo, useRef } from "react"
import type { Map as LeafletMap } from "leaflet"
import geo from "../../../../geo/ercot-load-zones.json"
import { FLOW_ZONES, type FlowHome, type FlowTick, type FlowZoneRow, type OrderTimelineEntry } from "../flow/types"
import { zoneShapes } from "../flow/flowMath"
import { kw } from "./format"
import type { Lens } from "./ScenarioRail"

type Props = {
  zones: Partial<Record<string, FlowZoneRow>>
  homes: FlowHome[]
  orders?: Record<string, OrderTimelineEntry[]>
  tick: FlowTick | null
  lens: Lens
  workerDown: boolean
  onZone: (zone: string) => void
}

const CHIP_POS: Record<string, { left: number; top: number }> = {
  North: { left: 900, top: 196 },
  West: { left: 520, top: 238 },
  South: { left: 700, top: 600 },
  Houston: { left: 960, top: 492 },
}

const NODE: Record<string, [number, number]> = {
  North: [958, 238],
  West: [570, 320],
  South: [744, 598],
  Houston: [988, 500],
}

function zoneOrders(zone: string, homes: FlowHome[], orders: Record<string, OrderTimelineEntry[]> | undefined): OrderTimelineEntry[][] {
  const ids = new Set(homes.filter((home) => home.zone === zone).map((home) => home.id))
  return Object.entries(orders ?? {}).filter(([id]) => ids.has(id)).map(([, timeline]) => timeline)
}

function askedCount(timelines: OrderTimelineEntry[][]): number {
  return timelines.filter((timeline) => timeline.some((entry) => entry[1] === "sent")).length
}

function confirmedCount(timelines: OrderTimelineEntry[][]): number {
  return timelines.filter((timeline) => timeline.some((entry) => entry[1] === "conf")).length
}

function hasDrop(timelines: OrderTimelineEntry[][]): boolean {
  return timelines.some((timeline) => timeline.some((entry) => entry[1] === "drop" || entry[1] === "rdrop"))
}

function chipText(row: FlowZoneRow | undefined, timelines: OrderTimelineEntry[][], lens: Lens): [string, string] {
  if (!row) return ["Not reported", "Open zone"]
  if (lens === "keep") return [`Floor ${row.reserve_pct}%`, row.reason.replace(/_/g, " ")]
  if (lens === "trust") return [`${askedCount(timelines)} homes asked`, `${confirmedCount(timelines)} confirmed`]
  return [`${askedCount(timelines)} homes asked`, `${kw(row.selling_mw * 1000, 0)} sold`]
}

export function MapStage({ zones, homes, orders, tick, lens, workerDown, onZone }: Props) {
  const leafletRef = useRef<HTMLDivElement | null>(null)
  const shapes = useMemo(() => zoneShapes(geo), [])
  const baseFloor = 30
  const arcClass = lens === "keep" ? "arc arc-keep" : lens === "trust" ? "arc arc-live" : "arc arc-send"

  useEffect(() => {
    let map: LeafletMap | null = null
    let frame = 0
    let cancelled = false
    async function mountLeaflet() {
      if (!leafletRef.current) return
      const L = await import("leaflet")
      if (cancelled || !leafletRef.current) return
      map = L.map(leafletRef.current, { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false })
        .setView([31.2, -99.2], 6)
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 12,
      }).addTo(map)
      frame = requestAnimationFrame(() => map?.invalidateSize())
    }
    void mountLeaflet()
    return () => {
      cancelled = true
      if (frame) cancelAnimationFrame(frame)
      map?.remove()
    }
  }, [])

  return (
    <div className="replay-map-stage" aria-label="Map of the four Texas load zones">
      <div className="replay-leaflet" ref={leafletRef} aria-hidden="true" />
      <div className="replay-map-scrim" aria-hidden="true" />
      <svg width="1440" height="836" viewBox="0 0 1440 836" aria-hidden="true">
        <defs>
          <filter id="replay-terrain" x="0" y="0" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency="0.012 0.018" numOctaves="4" seed="7" />
            <feColorMatrix values="0 0 0 0 0.07  0 0 0 0 0.11  0 0 0 0 0.09  0 0 0 0.9 0" />
          </filter>
          <filter id="replay-grain" x="0" y="0" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3" />
            <feColorMatrix values="0 0 0 0 0.6  0 0 0 0 0.66  0 0 0 0 0.6  0 0 0 0.07 0" />
          </filter>
          <pattern id="replay-homes" width="7" height="7" patternUnits="userSpaceOnUse">
            <circle cx="3.5" cy="3.5" r="1.6" fill={lens === "keep" ? "#E7C07A" : "#8FE3E9"} />
          </pattern>
        </defs>
        <rect width="1440" height="836" fill="#101A16" />
        <rect width="1440" height="836" filter="url(#replay-terrain)" />
        <path d="M1010 560 C1100 520 1200 540 1440 520 L1440 836 L760 836 C860 760 930 640 1010 560 Z" fill="#0A1115" />
        <text x="1210" y="700" fill="#3B5058" fontSize="15" fontStyle="italic">Gulf of Mexico</text>
        <g transform="translate(330,40) scale(0.86)">
          {shapes.map((shape) => {
            const row = zones[shape.zone]
            const raised = (row?.reserve_pct ?? tick?.reserve_pct ?? baseFloor) > baseFloor
            return (
              <path
                key={shape.zone}
                d={shape.path}
                fill={raised ? "var(--rg-raised-floor-zone)" : shape.zone === "North" && lens !== "keep" ? "#1E3730" : "var(--rg-calm-zone)"}
                stroke={raised ? "var(--rg-raised-floor-stroke)" : shape.zone === "North" && lens !== "keep" ? "var(--rg-gave-energy)" : "var(--rg-zone-stroke)"}
                strokeWidth={shape.zone === "North" && lens !== "keep" ? 2.5 : 1.5}
              />
            )
          })}
          <circle cx="730" cy="300" r="30" fill="url(#replay-homes)" />
          <circle cx="815" cy="468" r="24" fill="url(#replay-homes)" />
          <circle cx="575" cy="560" r="24" fill="url(#replay-homes)" />
          <circle cx="330" cy="330" r="20" fill="url(#replay-homes)" />
        </g>
        {FLOW_ZONES.map((zone) => {
          const [x, y] = NODE[zone]
          return <path key={zone} className={arcClass} d={`M856,410 Q${(856 + x) / 2},${Math.min(y, 410) - 60} ${x},${y}`} />
        })}
        {FLOW_ZONES.map((zone) => {
          const timelines = zoneOrders(zone, homes, orders)
          if (!hasDrop(timelines)) return null
          const [x, y] = NODE[zone]
          return <circle key={zone} cx={x - 28} cy={y - 24} r="6" fill="#E0533F" stroke="#101A16" strokeWidth="2" />
        })}
        <g>
          <circle cx="856" cy="410" r="15" fill="#F2F3EF" />
          <path d="M857 401 L851 412 H860 L854 421" fill="none" stroke="#0E6F78" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        </g>
        <rect width="1440" height="836" filter="url(#replay-grain)" pointerEvents="none" />
      </svg>
      <div className="replay-crumb replay-panel"><b>Texas</b><span>{workerDown ? "Worker offline. Click a zone to zoom in." : "Click a zone to zoom in."}</span></div>
      {workerDown ? (
        <div className="replay-panel replay-worker-empty">
          <p>The scenario worker is not running. Start it with <code>.venv/bin/python scripts/scenario_session.py</code></p>
        </div>
      ) : null}
      {FLOW_ZONES.map((zone) => {
        const pos = CHIP_POS[zone]
        const timelines = zoneOrders(zone, homes, orders)
        const [line1, line2] = chipText(zones[zone], timelines, lens)
        return (
          <button key={zone} type="button" className={zone === "North" ? "replay-chip go" : "replay-chip"} style={pos} onClick={() => onZone(zone)}>
            <b>{zone}</b>{line1}<br />{line2}
          </button>
        )
      })}
    </div>
  )
}
