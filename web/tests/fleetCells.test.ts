import { describe, expect, it } from "vitest"
import layoutRun from "../src/fixtures/layout-run.json"
import type { RunFile } from "../src/contracts"
import { countState, fleetCells, homesUnderFloor, packGrid } from "../src/components/organisms/fleetCells"

const run = layoutRun as RunFile

function tick(n: number) {
  const found = run.ticks.find((item) => item.tick === n)
  if (found === undefined) {
    throw new Error(`missing tick ${n}`)
  }
  return found
}

describe("fleetCells", () => {
  it("parks the lower half of the start band when the floor is 60%", () => {
    expect(homesUnderFloor(100, 60)).toBe(50)
    expect(homesUnderFloor(100, 30)).toBe(0)
  })

  it("draws tick 05 as reserved ground, not an all-clear", () => {
    const cells = fleetCells(tick(5))
    const reserved = countState(cells, "reserved")
    const discharging = countState(cells, "discharging")
    const ok = countState(cells, "ok")

    expect(cells).toHaveLength(100)
    expect(reserved).toBe(50)
    expect(discharging).toBe(50)
    expect(ok).toBe(0)
    expect(reserved).toBeGreaterThan(ok)
    expect(cells.slice(0, reserved).every((state) => state === "reserved")).toBe(true)
  })

  it("keeps a low-risk tick free of reserved homes", () => {
    const cells = fleetCells(tick(1))
    expect(countState(cells, "reserved")).toBe(0)
    expect(countState(cells, "discharging")).toBe(40)
    expect(countState(cells, "ok")).toBe(60)
    expect(countState(cells, "unconfirmed")).toBe(0)
  })

  it("packs a wide pane into near-square cells", () => {
    const grid = packGrid(100, 900, 320, 4)
    const cellW = (900 - 4 * (grid.cols - 1)) / grid.cols
    const cellH = (320 - 4 * (grid.rows - 1)) / grid.rows

    expect(grid.cols * grid.rows).toBeGreaterThanOrEqual(100)
    expect(Math.min(cellW, cellH)).toBeGreaterThan(40)
    expect(Math.abs(cellW - cellH)).toBeLessThan(16)
  })

  it("matches dead and stale counts and stops discharge on HOLD", () => {
    const cells = fleetCells(tick(8))
    expect(countState(cells, "dead")).toBe(20)
    expect(countState(cells, "stale")).toBe(10)
    expect(countState(cells, "discharging")).toBe(0)
    expect(countState(cells, "reserved")).toBeGreaterThan(countState(cells, "ok"))
  })
})
