import { describe, expect, it } from "vitest"
import {
  RADAR_LABEL,
  RADAR_OPACITY,
  RADAR_PROBE_TILE,
  RADAR_UNAVAILABLE,
  radarNote,
  radarTileTemplate,
} from "../src/components/organisms/radarTiles"

describe("radar tiles", () => {
  it("names the overlay NWS radar at a light opacity", () => {
    expect(RADAR_LABEL).toBe("NWS radar")
    expect(RADAR_OPACITY).toBe(0.45)
    expect(radarNote("ready")).toBe("NWS radar")
    expect(radarNote("off")).toBeNull()
  })

  it("uses a quiet unavailable line when the tile cannot load", () => {
    expect(radarNote("unavailable")).toBe(RADAR_UNAVAILABLE)
    expect(RADAR_UNAVAILABLE).toBe("radar unavailable")
  })

  it("requests NEXRAD tiles and probes one North-zone tile", () => {
    expect(radarTileTemplate()).toBe(
      "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png",
    )
    expect(RADAR_PROBE_TILE).toBe(
      "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/6/14/26.png",
    )
    expect(radarTileTemplate().toLowerCase().includes("ercot")).toBe(false)
    expect(RADAR_LABEL.toLowerCase().includes("ercot")).toBe(false)
  })
})
