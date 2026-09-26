/** NWS NEXRAD composite, served as map tiles by Iowa State. The wall labels this NWS radar. */
const NWS_RADAR_TILES =
  "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png"

/** One tile over the North zone. If this image fails, the overlay never covers the map. */
export const RADAR_PROBE_TILE = NWS_RADAR_TILES.replace("{z}", "6").replace("{x}", "14").replace("{y}", "26")

export const RADAR_OPACITY = 0.45

export const RADAR_LABEL = "NWS radar"

export const RADAR_UNAVAILABLE = "radar unavailable"

export type RadarState = "off" | "ready" | "unavailable"

export function radarTileTemplate(): string {
  return NWS_RADAR_TILES
}

export function radarNote(state: RadarState): string | null {
  switch (state) {
    case "off":
      return null
    case "ready":
      return RADAR_LABEL
    case "unavailable":
      return RADAR_UNAVAILABLE
    default: {
      const neverState: never = state
      return neverState
    }
  }
}
