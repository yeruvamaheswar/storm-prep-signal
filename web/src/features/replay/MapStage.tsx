import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { GeoJSON as LeafletGeoJSON, Map as LeafletMap, Path as LeafletPath } from "leaflet"
import "leaflet/dist/leaflet.css"
import geo from "../../../../geo/ercot-load-zones.json"
import type { Point } from "../flow/flowMath"
import { FLOW_ZONES, type FlowHome, type FlowTick, type FlowZoneRow, type OrderTimelineEntry } from "../flow/types"
import { ROSTER_COUNTIES, alertCounties, rainFips, type AlertLike, type ProvenanceLike } from "./alertWeather"
import { daylight, solarElevationDeg, type Daylight } from "./sun"
import {
  CONTROLLER_LATLNG, arcPath, arcPoint, chargeOnly, chipLines, chipPlacement, clusterRadius, geoBounds, zoneActivity,
  zoneArcClass, zoneGeos, zoneGoes, type LatLng, type ZoneActivity,
} from "./mapModel"
import { ISLANDED_TEXT, clipPolygon, cloudBlobs, fleetWeather, ringBox } from "./weatherModel"
import type { Lens } from "./ScenarioRail"

export type StageNotice = "worker_down" | "api_down" | null

type Props = {
  zones: Partial<Record<string, FlowZoneRow>>
  homes: FlowHome[]
  orders?: Record<string, OrderTimelineEntry[]>
  tick: FlowTick | null
  /** `state.start.base_floor_pct`. Missing means no zone is marked raised. */
  baseFloorPct?: number
  /** Task 14: the tick's provenance (same tick as `tick`). The keys of its `events.weather_counties` are the counties
   * an alert applied this tick. Missing: no rain. */
  provenance?: ProvenanceLike | null
  /** `state.alerts`, to name each applied county's event (rain only for storm-type events). */
  alerts?: readonly AlertLike[]
  /** Room kept below the map, in px: the playback bar's measured height plus gutters (ReplayPage). Missing: the
   * Watch orders bar's 96 px. The Day view bar is taller, so the south of Texas would sit under it. */
  padBottom?: number
  tSeconds: number
  lens: Lens
  notice: StageNotice
  apiBase?: string
  onZone: (zone: string) => void
  /** The breadcrumb's hint. Live (Task 9) passes its own; unset keeps Replay's words. */
  crumbHint?: string
}

const TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"

// Room for the side panels: left column 280 px, right column 292 px, 20 px gutters,
// the breadcrumb on top and the playback bar at the bottom.
const PAD_LEFT = 20 + 280 + 28
const PAD_RIGHT = 20 + 292 + 28
const PAD_TOP = 76
const PAD_BOTTOM = 20 + 96 + 24

/** Screen points from Leaflet: the controller node, each zone's anchor and each zone's outline. */
type Projected = { node: Point; zones: Record<string, Point>; rings: Record<string, Point[]>; counties?: Record<string, Point[]> }

function ringPath(points: Point[]): string {
  return `M${points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L")} Z`
}

function noticeText(notice: StageNotice, apiBase: string): ReactNode {
  if (notice === "api_down") {
    return <p>Cannot reach the ReserveGate API at <code>{apiBase}/v1</code>. Check that the API server is running.</p>
  }
  if (notice === "worker_down") {
    return <p>The scenario worker is not running. Start it with <code>.venv/bin/python scripts/scenario_session.py</code></p>
  }
  return null
}

export function MapStage({
  zones, homes, orders, tick, baseFloorPct, provenance, alerts, padBottom, tSeconds, lens, notice, apiBase = "", onZone,
  crumbHint,
}: Props) {
  // Read by fit() at call time, so a taller or shorter playback bar refits the map (the effect below).
  const padBottomRef = useRef(padBottom ?? PAD_BOTTOM)
  padBottomRef.current = padBottom ?? PAD_BOTTOM
  const refit = useRef<(() => void) | null>(null)
  const leafletRef = useRef<HTMLDivElement | null>(null)
  const zoneLayers = useRef<Record<string, LeafletPath>>({})
  const onZoneRef = useRef(onZone)
  onZoneRef.current = onZone
  const geos = useMemo(() => zoneGeos(geo), [])
  const [projected, setProjected] = useState<Projected | null>(null)
  const [terrain, setTerrain] = useState(false)

  const activity = useMemo(() => {
    const out: Record<string, ZoneActivity | null> = {}
    for (const zone of FLOW_ZONES) out[zone] = orders ? zoneActivity(zone, homes, orders, tSeconds) : null
    return out
  }, [homes, orders, tSeconds])
  // Weather at the playhead's tick: the same rule the zone board reads (weatherModel).
  const weather = useMemo(() => fleetWeather(FLOW_ZONES, tick, zones, baseFloorPct), [tick, zones, baseFloorPct])
  // The amber fill shows any raised floor (a missing signal too); clouds and rain show weather only.
  const raised = useMemo(() => Object.fromEntries(FLOW_ZONES.map((zone) => [zone, weather[zone].floorRaised])), [weather])
  // Task 14: rain only over the counties an alert applied this tick, and only for storm-type events (alertWeather).
  const rain = useMemo(() => rainFips(alertCounties(provenance, alerts)), [provenance, alerts])
  // Task 14: night and twilight from the sun at each zone's anchor at the tick's own instant. No tick, no shading.
  const tickTs = tick?.ts
  const sun = useMemo(() => {
    const ms = tickTs ? Date.parse(tickTs) : NaN
    const out: Record<string, Daylight> = {}
    if (!Number.isFinite(ms)) return out
    for (const z of geos) out[z.zone] = daylight(solarElevationDeg(ms, z.anchor.lat, z.anchor.lng))
    return out
  }, [tickTs, geos])
  const homeCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const home of homes) counts[home.zone] = (counts[home.zone] ?? 0) + 1
    return counts
  }, [homes])

  useEffect(() => {
    let map: LeafletMap | null = null
    let frame = 0
    let cancelled = false
    let observer: ResizeObserver | null = null

    async function mountLeaflet() {
      const el = leafletRef.current
      if (!el) return
      const L = await import("leaflet")
      if (cancelled || !leafletRef.current) return
      // Phone portrait only: pan and pinch. Desktop stays click-to-select with locked map chrome.
      const phone = typeof window.matchMedia === "function" && window.matchMedia("(max-width: 720px)").matches
      const m = L.map(el, {
        zoomControl: false, attributionControl: false, dragging: phone, scrollWheelZoom: false,
        doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: phone, zoomSnap: 0.1,
      })
      map = m

      let tilesLoaded = 0
      L.tileLayer(TILE_URL, { maxZoom: 12 })
        .on("tileload", () => {
          tilesLoaded += 1
          setTerrain(false)
        })
        .on("tileerror", () => {
          if (tilesLoaded === 0) setTerrain(true)
        })
        .addTo(m)

      // A dark scrim pane between the imagery and the zones, so zone colours read on top of it.
      const scrim = m.createPane("replay-scrim")
      scrim.style.zIndex = "350"
      scrim.style.pointerEvents = "none"
      L.rectangle([[-85, -180], [85, 180]], { pane: "replay-scrim", className: "replay-scrim-rect", interactive: false }).addTo(m)

      const layer: LeafletGeoJSON = L.geoJSON(geo as Parameters<typeof L.geoJSON>[0], {
        style: () => ({ className: "replay-zone", weight: 1.5 }),
        onEachFeature: (feature, featureLayer) => {
          const zone = (feature.properties as { zone?: string } | null)?.zone
          if (typeof zone !== "string") return
          zoneLayers.current[zone] = featureLayer as LeafletPath
          featureLayer.on("click", () => onZoneRef.current(zone))
        },
      })
      layer.addTo(m)

      const [[s, w], [n, e]] = geoBounds(geos)
      const fit = () => {
        const width = m.getSize().x
        const room = width > PAD_LEFT + PAD_RIGHT + 240
        // Phone dock + playback sit under the map; keep Texas clear of that chrome.
        const top = phone ? 64 : PAD_TOP
        const bottom = phone ? 200 : PAD_BOTTOM
        // Phone: clear the dock; desktop (and phone with a measured bar) uses padBottomRef.
        const padBottom = phone ? Math.max(padBottomRef.current, bottom) : padBottomRef.current
        const padTop = phone ? top : PAD_TOP
        m.fitBounds([[s, w], [n, e]], {
          paddingTopLeft: room ? [PAD_LEFT, PAD_TOP] : [16, padTop],
          paddingBottomRight: room ? [PAD_RIGHT, padBottom] : [16, padBottom],
          animate: false,
        })
      }
      const toPoint = (ll: LatLng): Point => {
        const p = m.latLngToContainerPoint([ll.lat, ll.lng])
        return [p.x, p.y]
      }
      const reproject = () => {
        if (cancelled) return
        setProjected({
          node: toPoint(CONTROLLER_LATLNG),
          zones: Object.fromEntries(geos.map((z) => [z.zone, toPoint(z.anchor)])),
          rings: Object.fromEntries(geos.map((z) => [z.zone, z.ring.map(([lng, lat]) => toPoint({ lat, lng }))])),
          counties: Object.fromEntries(ROSTER_COUNTIES.map((c) => [c.fips, c.ring.map(([lng, lat]) => toPoint({ lat, lng }))])),
        })
      }
      m.on("zoomend moveend", reproject)
      m.on("resize", fit)
      refit.current = fit
      fit()
      reproject()
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(() => m.invalidateSize({ animate: false }))
        observer.observe(el)
      }
      frame = requestAnimationFrame(() => {
        frame = 0
        m.invalidateSize({ animate: false })
        fit()
      })
      paintZones()
    }

    mountLeaflet().catch(() => {
      // Leaflet could not start (no layout, for example). The stage keeps its dark background.
      if (!cancelled) setTerrain(true)
    })
    return () => {
      cancelled = true
      if (frame) cancelAnimationFrame(frame)
      observer?.disconnect()
      zoneLayers.current = {}
      refit.current = null
      map?.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function paintZones() {
    for (const [zone, layer] of Object.entries(zoneLayers.current)) {
      const el = layer.getElement?.()
      if (!el) continue
      el.classList.toggle("is-raised", raised[zone] === true)
      el.setAttribute("data-zone", zone)
      // A zone that only charges was asked nothing for the call: no blue highlight.
      el.classList.toggle("is-go", zoneGoes(activity[zone]))
    }
  }

  useEffect(paintZones)

  // The playback bar changed height (Day view vs Watch orders, wrapping): fit Texas above it again.
  useEffect(() => {
    refit.current?.()
  }, [padBottom])

  return (
    <div className={`replay-map-stage lens-${lens}`} aria-label="Map of the four Texas load zones">
      {terrain ? (
        <svg className="replay-terrain" aria-hidden="true" preserveAspectRatio="none">
          <defs>
            <filter id="replay-terrain" x="0" y="0" width="100%" height="100%">
              <feTurbulence type="fractalNoise" baseFrequency="0.012 0.018" numOctaves="4" seed="7" />
              <feColorMatrix values="0 0 0 0 0.07  0 0 0 0 0.11  0 0 0 0 0.09  0 0 0 0.9 0" />
            </filter>
          </defs>
          <rect width="100%" height="100%" filter="url(#replay-terrain)" />
        </svg>
      ) : null}
      <div className="replay-leaflet" ref={leafletRef} aria-hidden="true" />
      <svg className="replay-overlay" aria-hidden="true">
        <defs>
          <filter id="replay-grain" x="0" y="0" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3" />
            <feColorMatrix values="0 0 0 0 0.6  0 0 0 0 0.66  0 0 0 0 0.6  0 0 0 0.07 0" />
          </filter>
          <pattern id="replay-homes" width="7" height="7" patternUnits="userSpaceOnUse">
            <circle className="replay-dot" cx="3.5" cy="3.5" r="1.6" />
          </pattern>
        </defs>
        {projected ? (
          <>
            {FLOW_ZONES.map((zone) => {
              const ring = projected.rings[zone]
              if (!ring?.length) return null
              // Task 14: two stacked layers, so day, twilight and night change opacity only.
              const shade = sun[zone]
              return (
                <g key={`s-${zone}`}>
                  <path className={`replay-sun replay-sun-twilight${shade === "twilight" || shade === "night" ? " is-on" : ""}`}
                    data-zone={zone} data-daylight={shade ?? "unknown"} d={ringPath(ring)} />
                  <path className={`replay-sun replay-sun-night${shade === "night" ? " is-on" : ""}`} data-zone={zone} d={ringPath(ring)} />
                </g>
              )
            })}
            {FLOW_ZONES.map((zone) => {
              const ring = projected.rings[zone]
              if (!weather[zone].gridDown || !ring?.length) return null
              return <path key={`i-${zone}`} className="replay-wx-islanded" data-zone={zone} d={ringPath(ring)} />
            })}
            {FLOW_ZONES.map((zone) => {
              const at = projected.zones[zone]
              if (!at || !homeCounts[zone]) return null
              return <circle key={`c-${zone}`} className="replay-cluster" cx={at[0]} cy={at[1]} r={clusterRadius(homeCounts[zone])} />
            })}
            {FLOW_ZONES.map((zone) => {
              const at = projected.zones[zone]
              if (!at || !activity[zone]?.sent) return null
              return <path key={`a-${zone}`} className={zoneArcClass(lens, activity[zone])} data-zone={zone} d={arcPath(projected.node, at)} />
            })}
            {FLOW_ZONES.map((zone) => {
              const at = projected.zones[zone]
              if (!at || !activity[zone]?.dropped) return null
              const [x, y] = arcPoint(projected.node, at, 0.7)
              return <circle key={`l-${zone}`} className="replay-loss" data-zone={zone} cx={x} cy={y} r="6" />
            })}
            <g className="replay-node" transform={`translate(${projected.node[0]},${projected.node[1]})`}>
              <circle r="15" />
              <path d="M1 -9 L-5 2 H4 L-2 11" />
            </g>
          </>
        ) : null}
        <rect width="100%" height="100%" filter="url(#replay-grain)" />
      </svg>
      {projected ? (
        <svg className="replay-wx" aria-hidden="true">
          <defs>
            <filter id="replay-cloud" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="18" /></filter>
          </defs>
          {rain.map((fips) => {
            const ring = projected.counties?.[fips]
            const box = ring ? ringBox(ring) : null
            if (!box) return null
            const centre: Point = [box.x + box.w / 2, box.y + box.h / 2]
            return (
              <g key={fips} className="replay-wx-clouds" data-fips={fips} filter="url(#replay-cloud)">
                {cloudBlobs(box, centre).map((blob, k) => <ellipse key={k} cx={blob.cx} cy={blob.cy} rx={blob.rx} ry={blob.ry} />)}
              </g>
            )
          })}
        </svg>
      ) : null}
      {projected ? rain.map((fips) => {
        const ring = projected.counties?.[fips]
        const box = ring ? ringBox(ring) : null
        if (!ring || !box) return null
        return (
          <div key={`r-${fips}`} className="replay-wx-rain" data-fips={fips} aria-hidden="true"
            style={{ left: box.x, top: box.y, width: box.w, height: box.h, clipPath: clipPolygon(ring, box) }}>
            <div className="replay-wx-rain-sheet" />
          </div>
        )
      }) : null}
      <div className="replay-crumb replay-panel"><b>Texas</b><span>{crumbHint ?? (notice ? "No live session. Click a zone to zoom in." : "Click a zone to zoom in.")}</span></div>
      <p className="replay-map-legend replay-panel">
        <span>Shading: night and twilight at the tick's time (sun position, NOAA equations).</span>
        <span>Rain: counties an NWS storm alert names this tick (Census outlines, simplified).</span>
      </p>
      {notice ? (
        <div className={`replay-panel replay-worker-empty is-${notice}`} role="status">
          {noticeText(notice, apiBase)}
        </div>
      ) : null}
      {projected ? FLOW_ZONES.map((zone) => {
        const at = projected.zones[zone]
        if (!at) return null
        const [line1, line2] = chipLines(zone, activity[zone], zones[zone], tick, lens, homes)
        const go = zoneGoes(activity[zone])
        const charge = chargeOnly(activity[zone])
        const placement = chipPlacement(at, clusterRadius(homeCounts[zone] ?? 0), projected.node)
        return (
          <button
            key={zone}
            type="button"
            className={`replay-chip${go ? " go" : ""}${charge ? " charge" : ""}${placement.below ? " is-below" : ""}`}
            style={{ left: at[0], top: placement.top }}
            onClick={() => onZone(zone)}
          >
            <b>{zone}</b>{line1}<br />{line2}
            {weather[zone].gridDown ? <span className="replay-chip-islanded">{ISLANDED_TEXT}</span> : null}
          </button>
        )
      }) : null}
    </div>
  )
}
