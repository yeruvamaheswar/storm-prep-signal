// Task 9 part 2: the Live page's states, rendered from the real reply shapes. Nothing stale reads as current.
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { LivePage, type LivePageProps } from "../src/features/live/LivePage"
import { homesFromReply, ordersFromReply, runFromReply, type HomesState } from "../src/features/live/liveModel"
import { PromisePanel } from "../src/features/replay/PromisePanel"
import tokens from "../src/design/tokens.css?raw"
import {
  archiveSnapshot, homesHeaders, homesRows, liveOrders, liveSnapshot, NOW_1221, oldRun10k, runLatest, tableRunNoSettings,
} from "./fixtures/live"

const headers = (h: Record<string, string>) => ({ get: (name: string) => h[name.toLowerCase()] ?? null })
// Six fixture rows stand in for a full page: the headers say 100 of 100, so `rows` is set to match.
const homes: HomesState = { kind: "ready", ...homesFromReply(homesRows, headers(homesHeaders)), rows: 100 }

function render(overrides: Partial<LivePageProps> = {}): string {
  const props: LivePageProps = {
    snapshot: { kind: "ready", value: liveSnapshot },
    run: runFromReply(200, runLatest),
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
    const html = render({ run: runFromReply(200, oldRun10k) })
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

  it("a table run with no settings (the Supabase path before 9c) is not live", () => {
    const html = render({ run: runFromReply(200, tableRunNoSettings) })
    expect(html).toContain("The run does not report its fleet size, so it cannot be checked against the 100-home demo fleet.")
    expect(html).not.toContain("Live from ERCOT")
    expect(html).not.toContain("$185")
  })

  it("an unread run file, an unknown tick length or an unknown demo fleet is not live", () => {
    expect(render({ run: { kind: "error", brief: "cannot reach the ReserveGate API" } }))
      .toContain("The run file could not be read (cannot reach the ReserveGate API), so this tick cannot be checked.")
    const noLength = runFromReply(200, { ...runLatest, settings: { fleet_size: 100 }, totals: {} })
    expect(render({ run: noLength })).toContain("The run does not report its tick length, so freshness cannot be checked.")
    expect(render({ demoFleet: null })).toContain("The demo fleet size is not reported")
  })

  it("the crumb never says Live when the page is not live", () => {
    const html = render({ snapshot: { kind: "ready", value: archiveSnapshot } })
    expect(html).not.toContain("Live. Click a zone")
    expect(html).toContain("Click a zone to zoom in.")
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

  it("the happy path looks normal: the simulated-fleet line, and no warning notes", () => {
    expect(html).toContain("The 100-home demo fleet and its orders are simulated.")
    expect(html).not.toContain("These are live ERCOT inputs.")
    expect(html).not.toContain("differ from the Fleet page")
    expect(html).not.toContain("Live fleet from Supabase")
    expect(html).not.toContain("live-warning")
    expect(html).not.toContain("replay-worker-empty")
    expect(html).not.toMatch(/JEV/i)
  })

  it("adds the meaning sentence when the snapshot's fields support it", () => {
    const storm = {
      ...liveSnapshot, policy_reason: "storm_risk_high", reserve_pct: 60, risk_level: "HIGH",
      zone_reserve_pct: { Houston: 60, North: 60, South: 60, West: 60 },
    }
    expect(render({ snapshot: { kind: "ready", value: storm } }))
      .toContain("Offline plants are over the stress line, so every home keeps 60% for backup.")
    // The fixture's floors disagree with its reason (normal, but 60% zones): no sentence.
    expect(html).not.toContain("Offline plants are")
  })

  it("warns about the homes only when the read is partial, sample or failed", () => {
    const partial = render({ homes: { ...homes, rows: 6 } as HomesState })
    expect(partial).toContain("100-home demo fleet. Live fleet from Supabase: 100 of 100 homes.")
    expect(render({ homes: { kind: "error", brief: "http 500: boom" } })).toContain("Could not read the homes: http 500: boom.")
  })

  it("while replaying, says where the playhead is", () => {
    const replaying = render({ replayStartMs: NOW_1221 - 12_500 })
    expect(replaying).toContain("Replaying this tick&#x27;s orders: 1:02 of 2:00.")
  })

  it("places homes by the zone /v1/homes reports (engine-zone rows: home-001 is Houston)", () => {
    const zone = render({ selectedZone: "Houston" })
    expect(zone).toContain("home-001")
    expect(zone).not.toContain("home-002")
    const south = render({ selectedZone: "South" })
    expect(south).not.toContain("home-001")
  })

  it("never shows the table's stale charge: an open home says Not reported", () => {
    const panel = render({ selectedZone: "Houston", selectedHome: "home-001" })
    expect(panel).toContain("Houston-Harris-001")
    expect(panel).toContain("Not reported")
    expect(panel).not.toContain("70%")
  })
})

describe("contrast", () => {
  it("the confirmed text token reads at 4.5:1 or better on the map panel", () => {
    const hex = (name: string) => tokens.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1] ?? ""
    const lum = (h: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const [hi, lo] = [lum(hex("--rg-panel-map")), lum(hex("--rg-confirmed-text"))].sort((x, y) => y - x)
    expect((hi + 0.05) / (lo + 0.05)).toBeGreaterThanOrEqual(4.5)
  })
})

describe("Replay's promise panel keeps its actions by default", () => {
  it("shows the ledger and About actions unless hidden", () => {
    const html = renderToStaticMarkup(createElement(PromisePanel, { tick: null, onOpenLedger: () => {}, onOpenData: () => {} }))
    expect(html).toContain("Open the ledger")
    expect(html).toContain("About this data")
  })
})
