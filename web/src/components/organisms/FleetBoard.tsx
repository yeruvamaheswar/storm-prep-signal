import { useEffect, useRef, useState, type CSSProperties } from "react"
import L from "leaflet"
import "leaflet/dist/leaflet.css"
import "./zoneMap.css"
import type { TickView } from "../../contracts"
import { callCaption, formatGridMw, homeRoleNote, lossCaption } from "../../format"
import { isLoadZone, zoneHierarchyPaint, zonePaint, type LoadZone, type ZoneFill, type ZonePathPaint } from "../../zonePaint"
import {
  haloCandidates,
  labelSize,
  pickLabelAnchor,
  rectCentered,
  type LabelCandidate,
  type PlaneRect,
} from "../../zoneLabels"
import { FleetLegend } from "../molecules/FleetLegend"
import { fleetCounts } from "./fleetCells"
import { homeNodes, labelCandidates, parseZonePolygons, zoneContains, type HomeNode, type ZonePolygon } from "./homeNodes"
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
  zone?: LoadZone | null
  callout?: string | null
  calloutTitle?: string
  onSelectZone?: (zone: LoadZone) => void
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

/** No operator choice: the driving zone stays the filled one. A click replaces that. */
function zoneIsSelected(fill: ZoneFill | undefined, zone: LoadZone | null): boolean {
  if (fill === undefined) {
    return false
  }
  if (zone === null) {
    return fill.emphasized
  }
  return fill.zone === zone
}

function pathPaint(
  fill: ZoneFill | undefined,
  muted: boolean,
  risk: TickView["risk_level"],
  selected: boolean,
): L.PathOptions {
  if (fill === undefined) {
    return { color: LINE, weight: 1, fillColor: FIELD, fillOpacity: UNPAINTED_FILL_OPACITY }
  }
  return pathOptions(zoneHierarchyPaint(fill, muted, risk, selected))
}

function zoneCaption(name: string, fill: ZoneFill | undefined): string {
  if (fill?.mw == null) {
    return name
  }
  return `${name} ${formatGridMw(fill.mw)} MW`
}

type LabelJob = {
  polygons: ZonePolygon[]
  nodes: HomeNode[]
  captions: Map<string, string>
}

function fallbackPolygons(): ZonePolygon[] {
  return FALLBACK_ZONES.map((area) => {
    const southWest = area.bounds[0]
    const northEast = area.bounds[1]
    const south = southWest[0]
    const west = southWest[1]
    const north = northEast[0]
    const east = northEast[1]
    return {
      name: area.name,
      rings: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
    }
  })
}

/** Permanent captions sit off the metro dots. Houston can step south into the gulf. */
function drawZoneLabels(map: L.Map, group: L.LayerGroup, job: LabelJob) {
  group.clearLayers()
  const size = map.getSize()
  if (size.y < 20) {
    return
  }
  const frame = { x: 0, y: 0, w: size.x, h: size.y }
  const blocked: PlaneRect[] = [
    { x: 0, y: 0, w: 48, h: 88 },
    { x: 0, y: size.y - 96, w: 340, h: 96 },
  ]
  const ordered = [...job.polygons].sort((a, b) => labelCandidates(a).length - labelCandidates(b).length)
  for (const polygon of ordered) {
    const text = job.captions.get(polygon.name) ?? polygon.name
    const { w, h } = labelSize(text.toUpperCase())
    const interior: LabelCandidate[] = labelCandidates(polygon).map(([lng, lat]) => {
      const point = map.latLngToLayerPoint([lat, lng])
      return { x: point.x, y: point.y, inside: true }
    })
    const candidates = haloCandidates(interior, w, h, (x, y) => {
      const latlng = map.layerPointToLatLng([x, y])
      return { x, y, inside: zoneContains(polygon, latlng.lng, latlng.lat) }
    })
    const obstacles = job.nodes.map((node) => {
      const point = map.latLngToLayerPoint([node.lat, node.lng])
      return { x: point.x, y: point.y }
    })
    const anchor = pickLabelAnchor(candidates, w, h, obstacles, blocked, frame)
    if (anchor === null) {
      continue
    }
    blocked.push(rectCentered(anchor, w, h))
    L.tooltip({
      permanent: true,
      direction: "center",
      className: "zone-name",
      opacity: 1,
      interactive: false,
    })
      .setLatLng(map.layerPointToLatLng([anchor.x, anchor.y]))
      .setContent(text)
      .addTo(group)
  }
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

export function FleetBoard({
  tick,
  radar = false,
  zone = null,
  callout = null,
  calloutTitle,
  onSelectZone,
}: FleetBoardProps) {
  const paintNow = zonePaint(tick)
  const counts = fleetCounts(tick)
  const loss = lossCaption(tick)
  const hostRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const missedRef = useRef<HTMLSpanElement>(null)
  const pulseRef = useRef(false)
  const [zoneNames, setZoneNames] = useState<string[]>(FALLBACK_ZONES.map((zone) => zone.name))
  const [standIn, setStandIn] = useState(false)
  const [radarNote, setRadarNote] = useState<string | null>(null)
  const lossKind = loss?.kind ?? null
  const onSelectRef = useRef(onSelectZone)
  onSelectRef.current = onSelectZone
  const labelJobRef = useRef<LabelJob | null>(null)
  const labelGroupRef = useRef<L.LayerGroup | null>(null)
  const refreshLabelsRef = useRef<(map: L.Map) => void>(() => {})
  refreshLabelsRef.current = (map) => {
    const job = labelJobRef.current
    if (job === null) {
      return
    }
    let group = labelGroupRef.current
    if (group === null || !map.hasLayer(group)) {
      group = L.layerGroup().addTo(map)
      labelGroupRef.current = group
    }
    drawZoneLabels(map, group, job)
  }

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
    map.on("selectzone", (event) => {
      const picked = (event as L.LeafletEvent & { zone?: string }).zone
      if (picked !== undefined && isLoadZone(picked)) {
        onSelectRef.current?.(picked)
      }
    })
    const homePane = map.createPane("home-nodes")
    homePane.style.zIndex = "650"
    const fit = () => {
      fitTexas(map)
      refreshLabelsRef.current(map)
    }
    map.whenReady(fit)
    requestAnimationFrame(fit)
    const observer = new ResizeObserver(fit)
    observer.observe(host)
    return () => {
      observer.disconnect()
      map.remove()
      mapRef.current = null
      labelGroupRef.current = null
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
      const polygons = geo === null ? fallbackPolygons() : parseZonePolygons(geo)
      const captions = new Map<string, string>()
      if (geo === null) {
        // TODO: geo/ercot-load-zones.json is missing. These four rectangles stand in for the ERCOT load zones.
        for (const area of FALLBACK_ZONES) {
          const fill = byName.get(area.name.toLowerCase())
          const selected = zoneIsSelected(fill, zone)
          const rect = L.rectangle(area.bounds, pathPaint(fill, paint.muted, tick.risk_level, selected))
          captions.set(area.name, zoneCaption(area.name, fill))
          if (isLoadZone(area.name)) {
            const name = area.name
            rect.on("click", () => onSelectRef.current?.(name))
          }
          rect.addTo(group)
        }
        setStandIn(true)
        setZoneNames(FALLBACK_ZONES.map((area) => area.name))
      } else {
        const names: string[] = []
        L.geoJSON(geo, {
          style: (feature) => {
            const name = featureZoneName(feature?.properties ?? null)
            return pathPaint(byName.get(name.toLowerCase()), paint.muted, tick.risk_level, zoneIsSelected(byName.get(name.toLowerCase()), zone))
          },
          onEachFeature: (feature, layer) => {
            const name = featureZoneName(feature.properties)
            names.push(name)
            captions.set(name, zoneCaption(name, byName.get(name.toLowerCase())))
            if (isLoadZone(name)) {
              layer.on("click", () => onSelectRef.current?.(name))
            }
          },
        }).addTo(group)
        setStandIn(false)
        setZoneNames(names)
      }
      labelJobRef.current = {
        polygons,
        nodes: homeNodes(tick, polygons),
        captions,
      }
      fitTexas(board)
      refreshLabelsRef.current(board)
    }

    void draw()
    return () => {
      cancelled = true
      group.remove()
    }
  }, [tick, zone])

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
      <p className="call-caption" role="status" title={calloutTitle}>
        {callout ?? callCaption(tick, counts.discharging, counts.reserved)}
        {callout !== null || loss === null ? null : (
          <span className="loss-line" data-loss={loss.kind} style={LOSS_LINE_STYLE}>
            <span ref={missedRef} style={LOSS_MISSED_STYLE}>
              {loss.missed}
            </span>
            {` · ${loss.line}`}
          </span>
        )}
      </p>
      <div className="zone-stage">
        <div ref={hostRef} className="zone-map" />
        {radarNote === null ? null : (
          <p className="radar-note" role="status">
            {radarNote}
          </p>
        )}
      </div>
      <FleetLegend counts={counts} />
      <p className="zone-map-names">{zoneNames.join(" · ")}</p>
    </section>
  )
}
