import { describe, expect, it } from "vitest"
import { homeName, homeNameById } from "../src/features/replay/homeName"

// Real rows from server/engine/scenario.py home_row (seed_fleet, default ZONES order, Houston first).
const ENGINE = [
  { id: "home-001", name: "Houston-Harris-001", zone: "Houston", county: "48201", county_name: "Harris" },
  { id: "home-005", name: "Houston-FortBend-005", zone: "Houston", county: "48157", county_name: "Fort Bend" },
  { id: "home-012", name: "West-TomGreen-012", zone: "West", county: "48451", county_name: "Tom Green" },
  { id: "home-043", name: "South-Travis-043", zone: "South", county: "48453", county_name: "Travis" },
  { id: "home-100", name: "West-Midland-100", zone: "West", county: "48329", county_name: "Midland" },
]

describe("homeName", () => {
  it("returns the engine's name when the row carries one", () => {
    for (const row of ENGINE) expect(homeName(row)).toBe(row.name)
  })

  it("builds the same Zone-County-Number as home_label from zone, county name and the id's number", () => {
    for (const row of ENGINE) {
      const { name: _name, ...rest } = row
      expect(homeName(rest)).toBe(row.name)
    }
  })

  it("reads GET /v1/homes and Fleet grid shapes too", () => {
    expect(homeName({ home_id: "home-012", zone: "West", county_name: "Tom Green" })).toBe("West-TomGreen-012")
    expect(homeName({ id: "home-005", zone: "Houston", countyName: "Fort Bend" })).toBe("Houston-FortBend-005")
  })

  it("uses the county FIPS when the name is missing, as home_label's county_name fallback does", () => {
    expect(homeName({ id: "home-007", zone: "Houston", county: "48999" })).toBe("Houston-48999-007")
  })

  it("returns the raw id when the zone or county is missing, never a new format", () => {
    expect(homeName({ id: "home-005" })).toBe("home-005")
    expect(homeName({ id: "home-005", zone: "Houston" })).toBe("home-005")
    expect(homeName({ id: "home-005", county_name: "Harris" })).toBe("home-005")
    expect(homeName({ id: "home-005", name: "", zone: null, county_name: null })).toBe("home-005")
  })

  it("names an id from a list of homes, or leaves the id when the list does not have it", () => {
    expect(homeNameById(ENGINE, "home-012")).toBe("West-TomGreen-012")
    expect(homeNameById(ENGINE, "home-077")).toBe("home-077")
    expect(homeNameById(undefined, "home-001")).toBe("home-001")
  })
})
