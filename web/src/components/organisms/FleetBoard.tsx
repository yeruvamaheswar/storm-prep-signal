import { useEffect, useRef, useState, type CSSProperties } from "react"
import L from "leaflet"
import "leaflet/dist/leaflet.css"
import "./zoneMap.css"
import type { TickView } from "../../contracts"
import { callCaption, formatGridMw, homeRoleNote, lossCaption } from "../../format"
import { zonePaint, zonePathPaint, type ZoneFill, type ZonePathPaint } from "../../zonePaint"
import { FleetLegend } from "../molecules/FleetLegend"
import { countState, fleetCells } from "./fleetCells"
import { useHomeNodes } from "./homeNodeLayer"
import { attachNwsRadar } from "./radarLayer"

const GEO_URL = "/geo/ercot-load-zones.json"

const TEXAS_BOUNDS: L.LatLngBoundsExpression = [
  [25.84, -106.65],
  [36.5, -93.51],
]

const LINE = "#D6D1C8"
const FIELD = "#F4F1EA"

/** Esri light gray canvas. Carto Positron now needs an API key and serves placeholder tiles without one. */
const BASEMAP_TILES =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}"
const BASEMAP_ATTRIBUTION = "Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ"

/** Unpainted zones must stay see-through so the basemap reads under them. */
const UNPAINTED_FILL_OPACITY = 0.35

/** Stand-in boxes when geo/ercot-load-zones.json cannot be read. */
const FALLBACK_ZONES = [
  { name: "West", bounds: [[31.17, -106.65], [36.5, -100.08]] as [L.LatLngTuple, L.LatLngTuple] },
  { name: "North", bounds: [[31.17, -100.08], [36.5, -93.51]] as [L.LatLngTuple, L.LatLngTuple] },
  { name: "South", bounds: [[25.84, -106.65], [31.17, -100.08]] as [L.LatLngTuple, L.LatLngTuple] },
  { name: "Houston", bounds: [[25.84, -100.08], [31.17, -93.51]] as [L.LatLngTuple, L.LatLngTuple] },
]

/** Sits over the top of the map, clear of the zoom control on the left and the radar note on the right. */
const CALL_CAPTION_STYLE: CSSProperties = {
  position: "absolute",
  top: "var(--space-5)",
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 800,
  maxWidth: "60%",
  margin: 0,
  padding: "var(--space-1) var(--space-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--radius-control)",
  background: "var(--field)",
  color: "var(--ink)",
  fontSize: "var(--text-body)",
  fontWeight: 500,
  fontVariantNumeric: "tabular-nums",
  textAlign: "center",
  pointerEvents: "none",
}

const LOSS_LINE_STYLE: CSSProperties = {
  display: "block",
  marginTop: "var(--space-1)",
}

const LOSS_MISSED_STYLE: CSSProperties = {
  color: "var(--reserved)",
  fontWeight: 600,
}

/** DESIGN.md motion: fades only, 120ms per step, no scale. */
const FADE_STEP_MS = 120
const FADE_ONCE: Keyframe[] = [{ opacity: 1 }, { opacity: 0.25 }, { opacity: 1 }]

function prefersStill(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

function fadeOnce(element: Element | null | undefined): Animation | null {
  if (element == null || prefersStill()) {
    return null
  }
  return element.animate(FADE_ONCE, { duration: FADE_STEP_MS * 2, easing: "ease-out" })
}

/** The board remounts per tick, so each discharging dot is added, and pulses, once. */
function pulseDischarging(layer: L.Layer) {
  if (!(layer instanceof L.CircleMarker) || layer.options.pane !== "home-nodes") {
    return
  }
  const element = layer.getElement()
  if (element?.getAttribute("data-status") === "discharging") {
    fadeOnce(element)
  }
}

type FleetBoardProps = {
  tick: TickView
  radar?: boolean
}

function featureZoneName(properties: GeoJSON.GeoJsonProperties): string {
  if (properties === null) {
    return "Zone"
  }
  const record = properties as Record<string, unknown>
  for (const key of ["zone", "ZONE", "ZONE_NAME", "name", "NAME"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim()
    }
  }
  return "Zone"
}

function pathOptions(paint: ZonePathPaint): L.PathOptions {
  return {
    color: paint.stroke,
    weight: paint.weight,
    fillColor: paint.fill,
    fillOpacity: paint.fillOpacity,
  }
}

/** Only the driving zone carries the reserved fill, so the eye lands on the zone behind the call. */
function pathPaint(fill: ZoneFill | undefined, muted: boolean, risk: TickView["risk_level"]): L.PathOptions {
  if (fill === undefined || (!muted && !fill.emphasized)) {
    return { color: LINE, weight: 1, fillColor: FIELD, fillOpacity: UNPAINTED_FILL_OPACITY }
  }
  return pathOptions(zonePathPaint(fill, muted, risk))
}

function zoneCaption(name: string, fill: ZoneFill | undefined): string {
  if (fill?.mw == null) {
    return name
  }
  return `${name} ${formatGridMw(fill.mw)} MW`
}

function labelZone(layer: L.Layer, name: string) {
  if (!(layer instanceof L.Path)) {
    return
  }
  layer.bindTooltip(name, {
    permanent: true,
    direction: "center",
    className: "zone-name",
    opacity: 1,
  })
}

/** useHomeNodes owns the markers. Its "add" handler sets data-status before the map fires layeradd. */
function noteHomeRole(layer: L.Layer) {
  if (!(layer instanceof L.CircleMarker) || layer.options.pane !== "home-nodes") {
    return
  }
  const status = layer.getElement()?.getAttribute("data-status")
  const note = status == null ? null : homeRoleNote(status)
  const content = layer.getTooltip()?.getContent()
  if (note === null || typeof content !== "string" || content.endsWith(note)) {
    return
  }
  layer.setTooltipContent(`${content} · ${note}`)
}

function fitTexas(map: L.Map) {
  map.invalidateSize()
  if (map.getSize().y < 20) {
    return
  }
  map.fitBounds(TEXAS_BOUNDS, { padding: [16, 16], animate: false })
}

async function loadZones(): Promise<GeoJSON.FeatureCollection | null> {
  try {
    const response = await fetch(GEO_URL)
    if (!response.ok) {
      return null
    }
    const body: unknown = await response.json()
    if (typeof body !== "object" || body === null) {
      return null
    }
    const record = body as { type?: unknown; features?: unknown }
    if (record.type !== "FeatureCollection" || !Array.isArray(record.features)) {
      return null
    }
    return body as GeoJSON.FeatureCollection
  } catch {
    return null
  }
}

export function FleetBoard({ tick, radar = false }: FleetBoardProps) {
  const paintNow = zonePaint(tick)
  const cells = fleetCells(tick)
  const loss = lossCaption(tick)
  const hostRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const missedRef = useRef<HTMLSpanElement>(null)
  const pulseRef = useRef(false)
  const [zoneNames, setZoneNames] = useState<string[]>(FALLBACK_ZONES.map((zone) => zone.name))
  const [standIn, setStandIn] = useState(false)
  const [radarNote, setRadarNote] = useState<string | null>(null)
  const lossKind = loss?.kind ?? null

  useEffect(() => {
    pulseRef.current = lossKind === "reallocated"
    const flash = lossKind === null ? null : fadeOnce(missedRef.current)
    return () => {
      flash?.cancel()
    }
  }, [lossKind])

  useEffect(() => {
    const host = hostRef.current
    if (host === null) {
      return
    }
    const map = L.map(host, {
      zoomControl: true,
      attributionControl: true,
      scrollWheelZoom: false,
      zoomSnap: 0.25,
    })
    mapRef.current = map
    L.tileLayer(BASEMAP_TILES, {
      maxZoom: 16,
      attribution: BASEMAP_ATTRIBUTION,
    }).addTo(map)
    map.on("layeradd", (event) => {
      noteHomeRole(event.layer)
      if (pulseRef.current) {
        pulseDischarging(event.layer)
      }
    })
    const homePane = map.createPane("home-nodes")
    homePane.style.zIndex = "650"
    const fit = () => fitTexas(map)
    map.whenReady(fit)
    requestAnimationFrame(fit)
    const observer = new ResizeObserver(fit)
    observer.observe(host)
    return () => {
      observer.disconnect()
      map.remove()
      mapRef.current = null
    }
  }, [])

  useHomeNodes(mapRef, tick)

  useEffect(() => {
    const map = mapRef.current
    if (map === null) {
      return
    }
    const board = map
    let cancelled = false
    const group = L.layerGroup().addTo(board)
    const paint = zonePaint(tick)
    const byName = new Map(paint.zones.map((zone) => [zone.zone.toLowerCase(), zone]))

    async function draw() {
      const geo = await loadZones()
      if (cancelled) {
        return
      }
      group.clearLayers()
      if (geo === null) {
        // TODO: geo/ercot-load-zones.json is missing. These four rectangles stand in for the ERCOT load zones.
        for (const zone of FALLBACK_ZONES) {
          const rect = L.rectangle(zone.bounds, pathPaint(byName.get(zone.name.toLowerCase()), paint.muted, tick.risk_level))
          labelZone(rect, zoneCaption(zone.name, byName.get(zone.name.toLowerCase())))
          rect.addTo(group)
        }
        setStandIn(true)
        setZoneNames(FALLBACK_ZONES.map((zone) => zone.name))
        fitTexas(board)
        return
      }
      const names: string[] = []
      L.geoJSON(geo, {
        style: (feature) =>
          pathPaint(byName.get(featureZoneName(feature?.properties ?? null).toLowerCase()), paint.muted, tick.risk_level),
        onEachFeature: (feature, layer) => {
          const name = featureZoneName(feature.properties)
          names.push(name)
          labelZone(layer, zoneCaption(name, byName.get(name.toLowerCase())))
        },
      }).addTo(group)
      setStandIn(false)
      setZoneNames(names)
      fitTexas(board)
    }

    void draw()
    return () => {
      cancelled = true
      group.remove()
    }
  }, [tick])

  useEffect(() => {
    const map = mapRef.current
    if (!radar || map === null) {
      setRadarNote(null)
      return
    }
    return attachNwsRadar(map, setRadarNote)
  }, [radar])

  return (
    <section
      className="fleet-board"
      aria-label="Texas load zones"
      data-zone-source={standIn ? "fallback" : "geo"}
      data-muted={paintNow.muted ? "true" : "false"}
      data-north={paintNow.zones.find((zone) => zone.zone === "North")?.emphasized ? "emphasized" : "plain"}
    >
      <div ref={hostRef} className="zone-map" />
      <p className="call-caption" role="status" style={CALL_CAPTION_STYLE}>
        {callCaption(tick, countState(cells, "discharging"), countState(cells, "reserved"))}
        {loss === null ? null : (
          <span className="loss-line" data-loss={loss.kind} style={LOSS_LINE_STYLE}>
            <span ref={missedRef} style={LOSS_MISSED_STYLE}>
              {loss.missed}
            </span>
            {` · ${loss.line}`}
          </span>
        )}
      </p>
      <FleetLegend cells={cells} />
      {radarNote === null ? null : (
        <p className="radar-note" role="status">
          {radarNote}
        </p>
      )}
      <p className="zone-map-names">{zoneNames.join(" · ")}</p>
    </section>
  )
}
