import { describe, expect, it, vi } from "vitest"
import type { RunFile } from "../src/contracts"
import { loadEngineRun, loadMeta, loadRun, pickRun, requestedEvent, requestedMode, resolveWallEvent, runFromTableRows, wantsLayoutTape } from "../src/loadRun"
import { preferredMode } from "../src/runtimeMode"
import layoutRun from "../src/fixtures/layout-run.json"

const fixture = layoutRun as RunFile

describe("loadRun", () => {
  it("does not treat an empty PostgREST /runs body as a run", () => {
    expect(runFromTableRows([])).toBeNull()
    expect(runFromTableRows(null)).toBeNull()
    expect(runFromTableRows([{}])).toBeNull()
    expect(runFromTableRows([{ run_id: "x", result: [] }])).toBeNull()
    expect(runFromTableRows([{ run_id: "x", result: "var/runs/latest.json" }])).toBeNull()
    expect(pickRun([], null).run_id).toBe("layout-fixture")
    expect(pickRun([], fixture).run_id).toBe("layout-fixture")
  })

  it("reads a runs-table row only when result is a run file", () => {
    const tableRun = { ...fixture, run_id: "table-run" }
    expect(runFromTableRows([{ run_id: "table-run", result: tableRun }])?.run_id).toBe("table-run")
    expect(pickRun([{ result: tableRun }], fixture).run_id).toBe("layout-fixture")
  })

  it("returns the layout tape and does not fetch /v1/runs/latest", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response("no", { status: 500 }))
    vi.stubGlobal("fetch", fetchFn)
    await expect(loadRun()).resolves.toMatchObject({ run_id: "layout-fixture" })
    expect(fetchFn).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("can still read an engine run when asked", async () => {
    const run = { run_id: "engine-run", decision_line: null, ticks: layoutRun.ticks }
    const fetchFn = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify(run), { status: 200, headers: { "Content-Type": "application/json" } })
    })
    await expect(loadEngineRun(fetchFn, "")).resolves.toMatchObject({ run_id: "engine-run" })
  })

  it("reads GET /v1/meta", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ mode: "live", fleet_size: 10000, source: "live", event: null, clock: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    })
    await expect(loadMeta(fetchFn, "")).resolves.toEqual({
      mode: "live",
      fleet_size: 10000,
      source: "live",
      event: null,
      clock: null,
    })
    expect(String(vi.mocked(fetchFn).mock.calls[0][0])).toBe("/v1/meta")
  })

  it("reads an archive event and clock from GET /v1/meta", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          mode: "live",
          fleet_size: 100,
          source: "archive",
          event: "beryl",
          clock: "archive",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    })
    await expect(loadMeta(fetchFn, "")).resolves.toEqual({
      mode: "live",
      fleet_size: 100,
      source: "archive",
      event: "beryl",
      clock: "archive",
    })
  })

  it("honors ?mode= over VITE_DEFAULT_MODE", () => {
    expect(preferredMode("live", "demo")).toBe("live")
    expect(preferredMode("demo", "live")).toBe("demo")
    expect(preferredMode(null, "live")).toBe("live")
    expect(preferredMode("tape", "demo")).toBe("demo")
    expect(preferredMode(null, undefined)).toBeNull()
    expect(requestedMode("?mode=demo", "live")).toBe("demo")
    expect(requestedMode("", "live")).toBe("live")
    expect(requestedEvent("?event=beryl")).toBe("beryl")
    expect(requestedEvent("?event=heather")).toBe("heather")
    expect(requestedEvent("?event=tuning-2026")).toBe("tuning-2026")
    expect(requestedEvent("?event=none")).toBeNull()
    expect(requestedEvent("")).toBeNull()
    expect(wantsLayoutTape("?event=none")).toBe(true)
    expect(wantsLayoutTape("?event=beryl")).toBe(false)
    expect(wantsLayoutTape("")).toBe(false)
    expect(resolveWallEvent("", true, null)).toBe("beryl")
    expect(resolveWallEvent("?event=none", true, "beryl")).toBeNull()
    expect(resolveWallEvent("?event=heather", true, null)).toBe("heather")
    expect(resolveWallEvent("", false, "beryl")).toBe("beryl")
    expect(resolveWallEvent("", false, null)).toBeNull()
  })
})
