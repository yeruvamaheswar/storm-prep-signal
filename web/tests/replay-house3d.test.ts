import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FlowHome, OrderTimelineEntry } from "../src/features/flow/types"
// vi.mock below is hoisted, so HomePanel sees the mocked hasWebGL.
import { HomePanel } from "../src/features/replay/HomePanel"
import {
  CABLE_FALLBACK, cableLook, cableMode, cableSegments, fitView, houseModel, resolveColor, segmentBetween, type Vec3,
} from "../src/features/replay/house3dModel"
import { probeWebGL } from "../src/features/replay/webgl"
import { WebGLBoundary } from "../src/features/replay/WebGLBoundary"
import { lotLook } from "../src/features/replay/zoneModel"

const webgl = vi.hoisted(() => ({ ok: false }))
vi.mock("../src/features/replay/webgl", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/features/replay/webgl")>()
  return { ...real, hasWebGL: () => webgl.ok }
})
// jsdom has no WebGL; stand in for the lazy 3D chunk so the test never loads three.js.
// The marker carries the model HomePanel passed, so the 3D branch is provable in the DOM.
vi.mock("../src/features/replay/House3D", () => ({
  default: ({ model }: { model: { cable: string; fillLook: { token: string } } }) =>
    createElement("div", { className: "house3d-marker", "data-cable": model.cable, "data-fill": model.fillLook.token }),
}))

// Real tick-3 timelines (failures tape, seed 1), the same as tests/replay-zone.test.ts.
const orders: Record<string, OrderTimelineEntry[]> = {
  // Lost, retried at 1:00, ran at 1:20.7, confirmed at 1:22.3.
  "home-066": [[0, "sent", 2.11], [0, "drop", null], [60, "retry", null], [80.7, "exec", 2.11], [82.3, "conf", 2.11]],
  // Ran at 0:09.4 but its report was lost.
  "home-054": [[0, "sent", 0.01], [9.4, "exec", 0.01], [9.4, "rdrop", null], [60, "retry", null], [74.8, "dup", null], [74.8, "rdrop", null]],
  // A charge order: sent, ran, confirmed.
  "home-010": [[0, "sent", -3.2], [8, "exec", -3.2], [13, "conf", -3.2]],
}

function home(id: string, extra: Partial<FlowHome> = {}): FlowHome {
  return { id, zone: "North", soc_pct: 55, soc_before_pct: 60, kw: 0, state: "selling", status: "live", floor_pct: 30, ...extra } as FlowHome
}

function modeAt(id: string, t: number) {
  const look = lotLook(home(id), orders[id], t, false)
  return cableMode(look)
}

describe("house3dModel cable", () => {
  it("reads the cable mode from the real order state at the playhead", () => {
    expect(modeAt("home-066", 30)).toBe("off") // lost, waiting for the retry
    expect(modeAt("home-066", 81)).toBe("selling") // gave energy, report not in yet
    expect(modeAt("home-066", 90)).toBe("confirmed")
    expect(modeAt("home-054", 30)).toBe("off") // report lost: the flat art shows no flow either
    expect(modeAt("home-010", 10)).toBe("charging")
    expect(modeAt("home-010", 20)).toBe("charging") // a confirmed charge stays amber
    expect(modeAt("home-066", 125)).toBe("confirmed")
    expect(cableMode(null)).toBe("off")
    expect(cableMode(lotLook(home("home-002"), undefined, 60, false))).toBe("off")
  })

  it("colours the cable from the state tokens, with the brief's literal only for giving energy", () => {
    expect(CABLE_FALLBACK).toBe("#35C3CE")
    expect(cableLook("selling")).toEqual({ token: "--rg-gave-energy", fallback: "#35C3CE", glow: true })
    expect(cableLook("confirmed")).toEqual({ token: "--rg-gave-energy", fallback: "#35C3CE", glow: true })
    expect(cableLook("charging")).toEqual({ token: "--rg-charging", fallback: null, glow: true })
    expect(cableLook("off")).toEqual({ token: null, fallback: null, glow: false })
  })

  it("resolves a token once, falling back only when the token is unreadable", () => {
    const read = (name: string) => ({ "--rg-gave-energy": " #35c3ce ", "--rg-charging": "#c98a1b" })[name] ?? ""
    expect(resolveColor(cableLook("selling"), read)).toBe("#35c3ce")
    expect(resolveColor(cableLook("charging"), read)).toBe("#c98a1b")
    expect(resolveColor(cableLook("selling"), () => "")).toBe("#35C3CE")
    expect(resolveColor(cableLook("charging"), () => "")).toBeNull()
    expect(resolveColor(cableLook("off"), read)).toBeNull()
  })
})

describe("house3dModel battery", () => {
  it("fills the battery face from soc_pct, clamped to 0..1", () => {
    expect(houseModel(home("a", { soc_pct: 55 }), null).fill).toBeCloseTo(0.55)
    expect(houseModel(home("a", { soc_pct: 140 }), null).fill).toBe(1)
    expect(houseModel(home("a", { soc_pct: -5 }), null).fill).toBe(0)
    expect(houseModel(home("a", { soc_pct: 55 }), null).fillLabel).toBeNull()
  })

  it("places the floor line from floor_pct, or draws none when it is missing", () => {
    expect(houseModel(home("a", { floor_pct: 30 }), null).floor).toBeCloseTo(0.3)
    expect(houseModel(home("a", { floor_pct: 250 }), null).floor).toBe(1)
    expect(houseModel(home("a", { floor_pct: undefined }), null).floor).toBeNull()
  })

  it("never invents a charge level: no fill and a Not reported label", () => {
    const model = houseModel(home("a", { soc_pct: undefined as unknown as number }), null)
    expect(model.fill).toBeNull()
    expect(model.fillLabel).toBe("Not reported")
    expect(model.label).toContain("Battery charge not reported")
    expect(houseModel(null, null)).toMatchObject({ fill: null, fillLabel: "Not reported", floor: null, cable: "off" })
  })

  it("describes the scene in words from the same numbers", () => {
    const look = lotLook(home("home-066"), orders["home-066"], 90, false)
    const model = houseModel(home("home-066", { soc_pct: 55, floor_pct: 30 }), look)
    expect(model.label).toBe("House, battery and power line. Battery charge 55%, backup floor 30%. Cable glowing: confirmed.")
    expect(model.cable).toBe("confirmed")
  })
})

describe("house3dModel battery fill colour", () => {
  const fillAt = (id: string, t: number, timeline = orders[id]) => houseModel(home(id), lotLook(home(id), timeline, t, false)).fillLook

  it("stays the idle colour, unlit, for a home that has not run", () => {
    expect(fillAt("home-002", 60, undefined)).toEqual({ token: "--rg-batt-idle", glow: false }) // not asked
    expect(fillAt("home-066", 30)).toEqual({ token: "--rg-batt-idle", glow: false }) // lost, not run yet
    expect(houseModel(home("a"), null).fillLook).toEqual({ token: "--rg-batt-idle", glow: false })
  })

  it("glows the battery colour once a sell order ran", () => {
    expect(fillAt("home-066", 81)).toEqual({ token: "--rg-battery-glow", glow: true })
    expect(fillAt("home-054", 30)).toEqual({ token: "--rg-battery-glow", glow: true }) // ran, report lost
  })

  it("glows amber for a charge that ran, never the sell colour", () => {
    expect(fillAt("home-010", 10)).toEqual({ token: "--rg-charging", glow: true })
    expect(fillAt("home-010", 20)).toEqual({ token: "--rg-charging", glow: true })
  })

  it("names the same token the flat art paints (lotLook.batt)", () => {
    for (const [id, t] of [["home-002", 60], ["home-066", 81], ["home-010", 10]] as const) {
      const look = lotLook(home(id), orders[id], t, false)
      expect(`var(${houseModel(home(id), look).fillLook.token})`).toBe(look.batt)
    }
  })
})

describe("cable rule has one source", () => {
  it("follows lotLook.flowing and the flat cable exactly", () => {
    for (const id of Object.keys(orders)) {
      for (const t of [0, 10, 30, 60, 81, 90, 125]) {
        const look = lotLook(home(id), orders[id], t, false)
        expect(cableMode(look) !== "off").toBe(look.flowing)
        expect(look.cable !== "rgba(0,0,0,0)").toBe(look.flowing)
      }
    }
  })
})

describe("cable geometry", () => {
  it("aligns a unit cylinder with the segment it spans", () => {
    const a: Vec3 = [1, 2, 3]
    const b: Vec3 = [-2, 0.5, 4]
    const seg = segmentBetween(a, b)
    expect(seg.position).toEqual([-0.5, 1.25, 3.5])
    expect(seg.length).toBeCloseTo(Math.hypot(3, 1.5, 1))
    // The cylinder's axis is local +Y. Euler "YZX" (Ry·Rz) sends it to (-sinZ·cosY, cosZ, sinZ·sinY).
    const [, ry, rz] = seg.rotation
    const axis = [-Math.sin(rz) * Math.cos(ry), Math.cos(rz), Math.sin(rz) * Math.sin(ry)]
    const dir = [-3, -1.5, 1].map((v) => v / seg.length)
    axis.forEach((v, k) => expect(v).toBeCloseTo(dir[k]))
  })

  it("sags between its ends and joins end to end", () => {
    const segs = cableSegments([0, 2, 0], [4, 2, 0], 0.5, 8)
    expect(segs).toHaveLength(8)
    // The curve's middle dips by `sag`; the middle pieces sit just above that.
    const lowest = Math.min(...segs.map((s) => s.position[1]))
    expect(lowest).toBeLessThan(1.52)
    expect(lowest).toBeGreaterThan(1.5)
    const total = segs.reduce((sum, s) => sum + s.length, 0)
    expect(total).toBeGreaterThan(4)
  })
})

describe("camera fit", () => {
  it("centres the points on screen and fits the tighter side", () => {
    // Looking straight down the +Z axis: screen x is world x, screen y is world y.
    const fit = fitView([[0, 0, 0], [10, 0, 0], [10, 4, 0], [0, 4, 0]], [0, 0, 1], 200, 200, 0)
    expect(fit.target.map((v) => Math.round(v * 1000) / 1000)).toEqual([5, 2, 0])
    expect(fit.zoom).toBeCloseTo(20)
    expect(fitView([[0, 0, 0], [10, 0, 0], [10, 4, 0], [0, 4, 0]], [0, 0, 1], 200, 40, 0).zoom).toBeCloseTo(10)
  })
})

describe("webgl probe", () => {
  it("is false without a WebGL context and true with one", () => {
    const none = { getContext: () => null } as unknown as HTMLCanvasElement
    const gl = { getContext: (kind: string) => (kind === "webgl2" ? {} : null) } as unknown as HTMLCanvasElement
    const throws = { getContext: () => { throw new Error("blocked") } } as unknown as HTMLCanvasElement
    expect(probeWebGL(() => none)).toBe(false)
    expect(probeWebGL(() => gl)).toBe(true)
    expect(probeWebGL(() => throws)).toBe(false)
  })

  it("releases the probe's context once it has answered", () => {
    const loseContext = vi.fn()
    const getExtension = vi.fn((name: string) => (name === "WEBGL_lose_context" ? { loseContext } : null))
    const canvas = { getContext: (kind: string) => (kind === "webgl" ? { getExtension } : null) } as unknown as HTMLCanvasElement
    expect(probeWebGL(() => canvas)).toBe(true)
    expect(getExtension).toHaveBeenCalledWith("WEBGL_lose_context")
    expect(loseContext).toHaveBeenCalledTimes(1)
  })
})

describe("home panel art", () => {
  const panelEl = (t: number) => createElement(HomePanel, { homeId: "home-066", home: home("home-066"), orders, tSeconds: t, onClose: () => {} })

  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement("div")
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    webgl.ok = false
  })

  async function mount(t: number) {
    await act(async () => {
      root.render(panelEl(t))
    })
    // Let the lazy chunk resolve and commit.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    return host.querySelector(".zone-home-art") as HTMLElement
  }

  function chipCheck(art: HTMLElement, label: string) {
    const chips = host.querySelectorAll(".zone-chip")
    expect(chips).toHaveLength(1)
    expect(art.contains(chips[0])).toBe(true)
    expect(chips[0].textContent).toBe(label)
    expect(host.textContent).not.toContain("Running on grid")
  }

  it("shows the flat house when WebGL is unavailable", async () => {
    webgl.ok = false
    const art = await mount(90)
    expect(art.querySelector(".zone-house-art")).not.toBeNull()
    expect(art.querySelector(".house3d-marker")).toBeNull()
    chipCheck(art, "Confirmed, counted")
  })

  it("takes the 3D branch when WebGL is available, with the model from the playhead", async () => {
    webgl.ok = true
    const art = await mount(90)
    const marker = art.querySelector(".house3d-marker")
    expect(marker).not.toBeNull()
    expect(marker?.getAttribute("data-cable")).toBe("confirmed")
    expect(marker?.getAttribute("data-fill")).toBe("--rg-battery-glow")
    expect(art.querySelector(".zone-house-art")).toBeNull()
    chipCheck(art, "Confirmed, counted")
  })

  it("keeps the chip on the 3D path while the order is still waiting", async () => {
    webgl.ok = true
    const art = await mount(81)
    expect(art.querySelector(".house3d-marker")?.getAttribute("data-cable")).toBe("selling")
    chipCheck(art, "Gave energy, waiting for its report")
  })

  it("shows the flat house as the fallback while the 3D chunk loads", async () => {
    webgl.ok = true
    // A fresh HomePanel module has a fresh React.lazy that has not resolved yet (the tests above resolved theirs).
    vi.resetModules()
    const fresh = await import("../src/features/replay/HomePanel")
    const html = renderToStaticMarkup(createElement(fresh.HomePanel, { homeId: "home-066", home: home("home-066"), orders, tSeconds: 90, onClose: () => {} }))
    expect(html).toContain('class="zone-house-art"')
    expect(html).not.toContain("house3d-marker")
  })
})

describe("WebGL error boundary", () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement("div")
    document.body.appendChild(host)
    root = createRoot(host, { onCaughtError: () => {} })
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it("shows the fallback when the canvas throws", async () => {
    function Broken(): ReactNode {
      throw new Error("WebGL context lost")
    }
    await act(async () => {
      root.render(createElement(WebGLBoundary, { fallback: createElement("p", null, "flat art"), children: createElement(Broken) }))
    })
    expect(host.textContent).toBe("flat art")
  })
})
