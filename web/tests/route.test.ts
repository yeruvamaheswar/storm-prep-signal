import { describe, expect, it } from "vitest"
import { isFleetPath, isFleetTablePath, isLivePath, isReplayPath, isWallPath } from "../src/pages/route"

describe("shell routes", () => {
  it("keeps replay on the root path", () => {
    expect(isReplayPath("/")).toBe(true)
    expect(isReplayPath("/index.html")).toBe(true)
    expect(isReplayPath("/replay")).toBe(true)
    expect(isReplayPath("/live")).toBe(false)
  })

  it("owns live, fleet, and wall paths without a router package", () => {
    expect(isLivePath("/live")).toBe(true)
    expect(isLivePath("/live/")).toBe(true)
    expect(isLivePath("/live.html")).toBe(true)
    expect(isFleetPath("/fleet")).toBe(true)
    expect(isWallPath("/wall")).toBe(true)
    expect(isWallPath("/")).toBe(false)
  })

  it("matches the fleet table before the fleet grid", () => {
    expect(isFleetTablePath("/fleet/table")).toBe(true)
    expect(isFleetTablePath("/fleet/table/")).toBe(true)
    expect(isFleetTablePath("/fleet/table.html")).toBe(true)
    expect(isFleetPath("/fleet/table")).toBe(false)
    expect(isFleetPath("/fleet/table.html")).toBe(false)
    expect(isFleetTablePath("/fleet")).toBe(false)
  })
})
