import L from "leaflet"
import type { TickView } from "../../contracts"
import { feedChip } from "../../format"
import { RADAR_OPACITY, RADAR_PROBE_TILE, radarNote, radarTileTemplate } from "./radarTiles"

/** Iowa State keeps the NEXRAD composite as past frames, one every 5 minutes, stamped in UTC. */
const ARCHIVE_TILES = "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/ridge::USCOMP-N0Q-{stamp}/{z}/{x}/{y}.png"
const ARCHIVE_STEP_MS = 5 * 60_000

/** Live ticks get the current mosaic. A tape gets the radar frame from its own timestamp. */
export type RadarClock = { source: "live" } | { source: "tape"; ts: string }

export function radarClock(tick: Pick<TickView, "ts" | "target_label" | "price_label">): RadarClock {
  return feedChip(tick.target_label, tick.price_label) === "LIVE" ? { source: "live" } : { source: "tape", ts: tick.ts }
}

/** `2026-07-08T14:20:00-05:00` becomes `202607081920`. Returns null when `ts` cannot be read. */
export function archiveStamp(ts: string): string | null {
  const ms = Date.parse(ts)
  if (Number.isNaN(ms)) {
    return null
  }
  const at = new Date(ms - (ms % ARCHIVE_STEP_MS))
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}`
}

function probeTile(template: string): string {
  return template.replace("{z}", "6").replace("{x}", "14").replace("{y}", "26")
}

function radarTiles(clock: RadarClock): { template: string; probe: string } | null {
  switch (clock.source) {
    case "live":
      return { template: radarTileTemplate(), probe: RADAR_PROBE_TILE }
    case "tape": {
      const stamp = archiveStamp(clock.ts)
      if (stamp === null) {
        return null
      }
      const template = ARCHIVE_TILES.replace("{stamp}", stamp)
      return { template, probe: probeTile(template) }
    }
    default: {
      const neverClock: never = clock
      return neverClock
    }
  }
}

/**
 * Draws NWS radar above zone fills and below home markers.
 * A failed tile request removes the layer and leaves the map in place.
 */
export function attachNwsRadar(
  map: L.Map,
  onState: (note: string | null) => void,
  clock: RadarClock = { source: "live" },
): () => void {
  const tiles = radarTiles(clock)
  if (tiles === null) {
    onState(radarNote("unavailable"))
    return () => {}
  }

  let cancelled = false
  let layer: L.TileLayer | null = null
  const probe = new Image()

  probe.onload = () => {
    if (cancelled) {
      return
    }
    const pane = map.getPane("radar") ?? map.createPane("radar")
    pane.style.zIndex = "450"
    pane.style.pointerEvents = "none"
    const next = L.tileLayer(tiles.template, {
      pane: "radar",
      opacity: RADAR_OPACITY,
      attribution: radarNote("ready") ?? "",
    })
    let sawTile = false
    next.on("tileload", () => {
      sawTile = true
    })
    next.on("tileerror", () => {
      if (cancelled || sawTile) {
        return
      }
      next.remove()
      layer = null
      onState(radarNote("unavailable"))
    })
    next.addTo(map)
    layer = next
    onState(radarNote("ready"))
  }

  probe.onerror = () => {
    if (!cancelled) {
      onState(radarNote("unavailable"))
    }
  }

  probe.src = tiles.probe

  return () => {
    cancelled = true
    probe.onload = null
    probe.onerror = null
    layer?.remove()
  }
}
