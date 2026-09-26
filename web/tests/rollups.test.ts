import { describe, expect, it, vi } from "vitest"
import { fetchFleetRollups } from "../src/api/rollups"
import type { FleetRollups } from "../src/contracts"

const body: FleetRollups = {
  n: 10000,
  zones: {
    South: {
      live: 2500,
      reserved: 0,
      discharging: 0,
      stale: 0,
      dead: 0,
      silent: 0,
      reserved_mw: 0,
      discharging_mw: 0,
    },
  },
  clusters: [{ id: "South:0", zone: "South", lng: -98.475, lat: 29.45 }],
}

describe("fetchFleetRollups", () => {
  it("reads GET /v1/fleet/rollups", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
    })
    await expect(fetchFleetRollups(fetchFn, "")).resolves.toEqual(body)
    expect(String(vi.mocked(fetchFn).mock.calls[0][0])).toBe("/v1/fleet/rollups")
  })

  it("returns null when the fetch is missing so the wall keeps index % 4", async () => {
    const down = vi.fn<typeof fetch>(async () => new Response("no", { status: 404 }))
    await expect(fetchFleetRollups(down, "")).resolves.toBeNull()
    const bad = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ n: "nope" }), { status: 200, headers: { "Content-Type": "application/json" } })
    })
    await expect(fetchFleetRollups(bad, "")).resolves.toBeNull()
    const boom = vi.fn<typeof fetch>(async () => {
      throw new Error("offline")
    })
    await expect(fetchFleetRollups(boom, "")).resolves.toBeNull()
  })
})
