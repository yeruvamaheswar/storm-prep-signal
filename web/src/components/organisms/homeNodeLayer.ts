import { useEffect, useRef, useState, type RefObject } from "react"
import L from "leaflet"
import type { TickView } from "../../contracts"
import { clusterCaption } from "../../format"
import { isLoadZone, zonePaint } from "../../zonePaint"
import { clusterCounts, clusterGroups } from "../../zoneLabels"
import { homeNodePaint, homeNodes, parseZonePolygons, type HomeNode, type ZonePolygon } from "./homeNodes"

const GEO_URL = "/geo/ercot-load-zones.json"
const groups = new WeakMap<L.Map, L.LayerGroup>()

/** Same stand-in boxes the map uses when the zone file cannot be read. */
const FALLBACK_BOXES = [
  { name: "West", south: 31.17, west: -106.65, north: 36.5, east: -100.08 },
  { name: "North", south: 31.17, west: -100.08, north: 36.5, east: -93.51 },
  { name: "South", south: 25.84, west: -106.65, north: 31.17, east: -100.08 },
  { name: "Houston", south: 25.84, west: -100.08, north: 31.17, east: -93.51 },
] as const

function fallbackPolygons(): ZonePolygon[] {
  return FALLBACK_BOXES.map((zone) => ({
    name: zone.name,
    rings: [
      [
        [zone.west, zone.south],
        [zone.east, zone.south],
        [zone.east, zone.north],
        [zone.west, zone.north],
        [zone.west, zone.south],
      ],
    ],
  }))
}

async function loadPolygons(): Promise<ZonePolygon[]> {
  try {
    const response = await fetch(GEO_URL)
    if (!response.ok) {
      return fallbackPolygons()
    }
    const body: unknown = await response.json()
    const parsed = parseZonePolygons(body)
    return parsed.length > 0 ? parsed : fallbackPolygons()
  } catch {
    return fallbackPolygons()
  }
}

/** Circle markers for the mock fleet. Positions stay put when the tick changes. */
export function useHomeNodes(mapRef: RefObject<L.Map | null>, tick: TickView): void {
  const groupRef = useRef<L.LayerGroup | null>(null)
  const [polygons, setPolygons] = useState<ZonePolygon[] | null>(null)

  useEffect(() => {
    const map = mapRef.current
    if (map === null) {
      return
    }
    let group = groups.get(map)
    if (group === undefined || !map.hasLayer(group)) {
      map.eachLayer((layer) => {
        if (layer instanceof L.LayerGroup && layer.getLayers().some((item) => item instanceof L.CircleMarker)) {
          layer.remove()
        }
      })
      const pane = map.getPane("home-nodes") ?? map.createPane("home-nodes")
      pane.style.zIndex = "480"
      group = L.layerGroup().addTo(map)
      groups.set(map, group)
    }
    groupRef.current = group
    let cancelled = false
    void loadPolygons().then((zones) => {
      if (!cancelled) {
        setPolygons(zones)
      }
    })
    return () => {
      cancelled = true
    }
  }, [mapRef])

  useEffect(() => {
    const map = mapRef.current
    const group = groupRef.current
    if (map === null || group === null || polygons === null) {
      return
    }
    map.eachLayer((layer) => {
      if (layer !== group && layer instanceof L.LayerGroup) {
        const homes = layer.getLayers().filter((item) => item instanceof L.CircleMarker)
        if (homes.length > 0) {
          layer.clearLayers()
        }
      }
    })
    const nodes = homeNodes(tick, polygons)
    const mw = new Map(zonePaint(tick).zones.map((zone) => [zone.zone, zone.mw]))
    const tips = new Map(
      clusterGroups(nodes).map((cluster) => {
        const zoneName = cluster[0]?.zone ?? ""
        const posted = isLoadZone(zoneName) ? (mw.get(zoneName) ?? null) : null
        return [cluster, clusterCaption(clusterCounts(cluster, posted))] as const
      }),
    )
    syncHomeMarkers(group, nodes, tips)
  }, [mapRef, tick, polygons])
}

/** 3px so a metro cluster stays a field of dots instead of a blot. */
const RADIUS_PX = 3

/** Dead homes must be findable inside a 3px cluster without hunting. */
const DEAD_RADIUS_PX = 5

/**
 * Paint mock homes on the zone map.
 * A later tick may change status. The seeded point does not move.
 * Dead homes are added last so live dots never cover them.
 */
export function syncHomeMarkers(
  group: L.LayerGroup,
  nodes: readonly HomeNode[],
  tips: ReadonlyMap<readonly HomeNode[], string> = new Map(),
): void {
  group.clearLayers()
  const alive = nodes.filter((node) => node.status !== "dead")
  const dead = nodes.filter((node) => node.status === "dead")
  for (const node of [...alive, ...dead]) {
    markerFor(node).addTo(group)
  }
  for (const [cluster, text] of tips) {
    clusterHit(cluster, text).addTo(group)
  }
}

function markerFor(node: HomeNode): L.CircleMarker {
  const hollow = node.status === "unconfirmed"
  const paint = homeNodePaint(node.status)
  const marker = L.circleMarker([node.lat, node.lng], {
    pane: "home-nodes",
    radius: node.status === "dead" ? DEAD_RADIUS_PX : RADIUS_PX,
    color: paint.stroke,
    weight: hollow ? 1.5 : 1,
    fillColor: paint.fill,
    fillOpacity: hollow ? 0 : 1,
    opacity: 1,
  })
  marker.on("add", () => {
    marker.getElement()?.setAttribute("data-status", node.status)
  })
  return marker
}

/** A clear pad over the dots. Hovering any home in the metro reads the same counts. */
function clusterHit(nodes: readonly HomeNode[], text: string): L.Rectangle {
  const bounds = L.latLngBounds(nodes.map((node) => [node.lat, node.lng] as L.LatLngTuple)).pad(0.35)
  const hit = L.rectangle(bounds, {
    pane: "home-nodes",
    className: "cluster-hit",
    stroke: false,
    fill: true,
    fillOpacity: 0,
    interactive: true,
  })
  hit.bindTooltip(text, {
    direction: "top",
    opacity: 1,
    className: "home-node-tip",
  })
  const zone = nodes[0]?.zone
  if (zone !== undefined) {
    hit.on("click", (event) => {
      event.target._map?.fire("selectzone", { zone })
    })
  }
  return hit
}
