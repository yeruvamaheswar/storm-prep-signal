import { describe, expect, it } from "vitest"
import { wallOrigin } from "../src/wallOrigin"

describe("wall origin", () => {
  it("keeps 01–12 only for the layout fixture in Demo", () => {
    expect(
      wallOrigin({ runtime: "demo", source: "fixture", runId: "layout-fixture" }),
    ).toMatchObject({
      kind: "fixture",
      chip: "DEMO",
      clock: "fixture",
      event: null,
      showScrubber: true,
    })
    expect(wallOrigin({ runtime: "demo", source: "live", runId: "layout-fixture" }).showScrubber).toBe(true)
    expect(wallOrigin({ runtime: "demo", source: "archive", event: "beryl", runId: "demo-stress" }).showScrubber).toBe(
      false,
    )
  })

  it("names Live from the ERCOT interval and hides the tape buttons", () => {
    expect(
      wallOrigin({ runtime: "live", source: "live", clock: "wall", intervalLabel: "14:30–14:45 CT" }),
    ).toEqual({
      kind: "live",
      event: null,
      eventLabel: null,
      clock: "wall",
      clockAt: null,
      chip: "LIVE",
      place: "Live · 14:30–14:45 CT",
      showScrubber: false,
    })
  })

  it("names an archive event and treats it as clocked, not a 12-tick tape", () => {
    expect(wallOrigin({ runtime: "live", source: "archive", event: "beryl", clock: "archive" })).toEqual({
      kind: "archive",
      event: "beryl",
      eventLabel: "Beryl",
      clock: "archive",
      clockAt: null,
      chip: "ARCHIVE",
      place: "ARCHIVE · Beryl",
      showScrubber: false,
    })
    expect(wallOrigin({ runtime: "live", source: "scenario", event: "heather" }).kind).toBe("archive")
    expect(wallOrigin({ runtime: "live", source: "scenario", clock: "archive" }).chip).toBe("ARCHIVE")
    expect(
      wallOrigin({ runtime: "demo", source: "archive", event: "beryl", clock: "archive", runId: "layout-fixture" }),
    ).toMatchObject({ kind: "archive", chip: "ARCHIVE", clock: "archive", showScrubber: false })
  })
})
