// Task 9 part 2: the Live page's states, rendered from the real reply shapes. Nothing stale reads as current.
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { LivePage, type LivePageProps } from "../src/features/live/LivePage"
import { homesFromReply, ordersFromReply, settingsFromRun, type HomesState } from "../src/features/live/liveModel"
import { PromisePanel } from "../src/features/replay/PromisePanel"
import {
  archiveSnapshot, homesHeaders, homesRows, liveOrders, liveSnapshot, NOW_1221, oldRun10k, runLatest,
} from "./fixtures/live"

const headers = (h: Record<string, string>) => ({ get: (name: string) => h[name.toLowerCase()] ?? null })
const homes: HomesState = { kind: "ready", ...homesFromReply(homesRows, headers(homesHeaders)) }

function render(overrides: Partial<LivePageProps> = {}): string {
  const props: LivePageProps = {
    snapshot: { kind: "ready", value: liveSnapshot },
    settings: settingsFromRun(runLatest),
    orders: ordersFromReply(200, liveOrders),
    homes,
    demoFleet: 100,
    nowMs: NOW_1221,
    replayStartMs: null,
    selectedZone: null,
    selectedHome: null,
    onZone: () => {},
    onBack: () => {},
    onHome: () => {},
    onCloseHome: () => {},
    onReplay: () => {},
    ...overrides,
  }
  return renderToStaticMarkup(createElement(LivePage, props))
}

function replayButton(html: string): string {
  return html.match(/<button[^>]*>Replay this tick<\/button>/)?.[0] ?? ""
}

describe("Live page: loading", () => {
  it("says it is reading the snapshot and shows no numbers", () => {
    const html = render({ snapshot: { kind: "loading" }, orders: { kind: "loading" }, homes: { kind: "loading" } })
    expect(html).toContain("Reading the ERCOT snapshot")
    expect(html).not.toContain("Live from ERCOT")
    expect(html).not.toContain("$185")
    expect(html).not.toContain("This tick, whole fleet")
    expect(replayButton(html)).toContain("disabled")
  })
})

describe("Live page: snapshot error", () => {
  it("says plainly the snapshot is unavailable, with the server's brief", () => {
    const html = render({ snapshot: { kind: "error", brief: "http 404: No run file is available." } })
    expect(html).toContain("ERCOT snapshot unavailable")
    expect(html).toContain("The ERCOT snapshot is unavailable: http 404: No run file is available.")
    expect(html).not.toContain("$185")
    expect(html).not.toContain("This tick, whole fleet")
    expect(replayButton(html)).toContain("disabled")
  })
})

describe("Live page: not live", () => {
  it("the live worker is off: says so and when the last tick ran, with no current numbers", () => {
    const later = Date.parse("2026-09-27T17:31:00Z")
    const html = render({ nowMs: later })
    expect(html).toContain("Not live, last tick 11 min ago")
    expect(html).toContain("No new tick since 12:20 CT, so the live worker looks stopped.")
    expect(html).toContain("Last tick ran at 12:20 CT. Next tick was due at 12:25 CT and has not arrived.")
    expect(html).not.toContain("Live from ERCOT")
    expect(html).not.toContain("$185")
    expect(html).not.toContain("This tick, whole fleet")
    expect(replayButton(html)).toContain("disabled")
  })

  it("an old 10,000-home run: not live, and never a 10,000 count", () => {
    const html = render({ settings: settingsFromRun(oldRun10k) })
    expect(html).toContain("The newest run is from before the 100-home demo fleet, so it is not shown.")
    expect(html).not.toMatch(/10,?000/)
    expect(html).not.toContain("This tick, whole fleet")
    expect(replayButton(html)).toContain("disabled")
  })

  it("an archive run is not live ERCOT", () => {
    const html = render({ snapshot: { kind: "ready", value: archiveSnapshot } })
    expect(html).toContain("ERCOT archive (tuning-2026), not live")
    expect(html).toContain("The newest run replays the tuning-2026 archive, not live ERCOT.")
    expect(html).toContain("Newest tick is stamped Sep 25, 12:00 CT (archive clock).")
    expect(html).not.toContain("Live from ERCOT")
  })
})

describe("Live page: no orders yet", () => {
  it("shows the live inputs and says no orders are on file, never 0 orders", () => {
    const html = render({ orders: ordersFromReply(404, { error: "no_tick_orders", brief: "No tick has written its orders yet." }) })
    expect(html).toContain("Live from ERCOT, updated 1 min ago")
    expect(html).toContain("What ERCOT is telling us")
    expect(html).toContain("$185")
    expect(html).toContain("22,539 MW")
    expect(html).toContain("Last tick ran at 12:20 CT. Next tick in 3:40.")
    expect(html).toContain("No orders to replay yet. No tick has written its orders yet.")
    expect(html).not.toMatch(/\b0 orders\b/)
    expect(replayButton(html)).toContain("disabled")
  })
})

describe("Live page: orders present", () => {
  const html = render()

  it("matches the approved live variant: inputs, pill, bar and an enabled Replay this tick", () => {
    expect(html).toContain("Live from ERCOT, updated 1 min ago")
    expect(html).toContain("What ERCOT is telling us")
    expect(html).toContain("Over the line by")
    expect(html).toContain("Passed")
    expect(html).toContain("Live. Click a zone to zoom in.")
    expect(html).toContain("Last tick ran at 12:20 CT. Next tick in 3:40.")
    expect(html).toContain("Live shows the newest tick. Replay it to watch its orders move.")
    expect(replayButton(html)).not.toContain("disabled")
  })

  it("reuses Replay's promise panel without the ledger or About actions", () => {
    expect(html).toContain("This tick, whole fleet")
    expect(html).toContain("Asked by ERCOT")
    expect(html).not.toContain("Open the ledger")
    expect(html).not.toContain("About this data")
  })

  it("labels real versus simulated and notes the engine zones", () => {
    expect(html).toContain("These are live ERCOT inputs.")
    expect(html).toContain("The 100-home demo fleet and its orders are simulated.")
    expect(html).toContain("Homes sit in the engine&#x27;s zones, which can differ from the Fleet page.")
    expect(html).not.toMatch(/JEV/i)
  })

  it("while replaying, says where the playhead is", () => {
    const replaying = render({ replayStartMs: NOW_1221 - 12_500 })
    expect(replaying).toContain("Replaying this tick&#x27;s orders: 1:02 of 2:00.")
  })

  it("opens a zone on the engine's zones (home-001 is Houston there)", () => {
    const zone = render({ selectedZone: "Houston" })
    expect(zone).toContain("home-001")
    expect(zone).not.toContain("home-002")
    const south = render({ selectedZone: "South" })
    expect(south).not.toContain("home-001")
  })
})

describe("Replay's promise panel keeps its actions by default", () => {
  it("shows the ledger and About actions unless hidden", () => {
    const html = renderToStaticMarkup(createElement(PromisePanel, { tick: null, onOpenLedger: () => {}, onOpenData: () => {} }))
    expect(html).toContain("Open the ledger")
    expect(html).toContain("About this data")
  })
})
