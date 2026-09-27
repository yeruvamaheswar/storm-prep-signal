import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { LedgerDrawer } from "../src/features/replay/LedgerDrawer"
import { PromisePanel } from "../src/features/replay/PromisePanel"
import { ReplayPage } from "../src/features/replay/ReplayPage"
import type { HistoryPoint } from "../src/features/flow/types"

const history: HistoryPoint[] = [
  { tick: 1, ts: "2024-01-15T13:00:00-06:00", target_mw: 0.2, delivered_mw: 0.18, charging_mw: 0, missed_mw: 0.01, unconfirmed_mw: 0.01, reserve_pct: 30, risk_level: "LOW", reasons: ["network_loss"] },
  { tick: 2, ts: "2024-01-15T13:05:00-06:00", target_mw: 0.4, delivered_mw: 0.25, charging_mw: 0, missed_mw: 0.1, unconfirmed_mw: 0.05, reserve_pct: 60, risk_level: "HIGH", reasons: ["storm_risk_high"] },
]

describe("Replay promise panel", () => {
  it("renders real tick fields and the ledger action without inventing missing values", () => {
    const html = renderToStaticMarkup(createElement(PromisePanel, {
      tick: { target_mw: 0.4, delivered_mw: 0.25, missed_mw: 0.1, unconfirmed_mw: 0.05, breaches: 0, reserve_pct: 60, reasons: ["storm_risk_high"] },
      onOpenLedger: () => {},
      onOpenData: () => {},
    }))
    expect(html).toContain("Asked by ERCOT")
    expect(html).toContain("0.400 MW")
    expect(html).toContain("Sold and confirmed")
    expect(html).toContain("0.250 MW")
    expect(html).toContain("Sent, not counted")
    expect(html).toContain("Backup breaches")
    expect(html).toContain(">0<")
    expect(html).toContain("Open the ledger")
  })

  it("heather tick 74: names what the fleet did and the energy bought, in amber, apart from sold", () => {
    const html = renderToStaticMarkup(createElement(PromisePanel, {
      tick: {
        tick: 74, mode: "AUTO", target_mw: 0.2, delivered_mw: 0, missed_mw: 0.2, unconfirmed_mw: 0, charging_mw: 1.1286,
        intent: "charge", intent_reason: "reserve_refill", reasons: ["storm_reserve", "reserve_refill", "homes_stale:1"], breaches: 0,
      },
      onOpenLedger: () => {},
      onOpenData: () => {},
    }))
    expect(html).toContain("Fleet did: Charge — refilled batteries under their floor")
    expect(html).toMatch(/<span class="is-charge">Charged from the grid<\/span><b class="is-charge">1\.129 MW<\/b>/)
    expect(html).toContain("Kept for backup, floor raised")
    expect(html).not.toContain("Not sent")
  })

  it("an operator HOLD tick says the call was not sent because of the hold", () => {
    const html = renderToStaticMarkup(createElement(PromisePanel, {
      tick: {
        tick: 4, mode: "HOLD", target_mw: 0.5477, delivered_mw: 0, missed_mw: 0.5477, unconfirmed_mw: 0, charging_mw: 0,
        intent: "hold", intent_reason: "operator_hold", reasons: ["operator_hold"], breaches: 0,
      },
      onOpenLedger: () => {},
      onOpenData: () => {},
    }))
    expect(html).toContain("Not sent, operator hold")
    expect(html).toContain("Fleet did: Hold — operator hold")
    expect(html).not.toContain("no spare energy")
  })

  it("shows no intent line when the tick carries no intent", () => {
    const html = renderToStaticMarkup(createElement(PromisePanel, {
      tick: { target_mw: 0.4, delivered_mw: 0.25, missed_mw: 0.1, unconfirmed_mw: 0.05, breaches: 0 },
      onOpenLedger: () => {},
      onOpenData: () => {},
    }))
    expect(html).not.toContain("Fleet did")
    expect(html).not.toContain("Charged from the grid")
  })

  it("shows not reported when the tick is missing", () => {
    const html = renderToStaticMarkup(createElement(PromisePanel, {
      tick: null,
      onOpenLedger: () => {},
      onOpenData: () => {},
    }))
    expect(html).toContain("Not reported")
    expect(html).toContain("Open the ledger")
  })
})

describe("Replay ledger", () => {
  it("renders rows and totals from history", () => {
    const html = renderToStaticMarkup(createElement(LedgerDrawer, {
      title: "Ledger, network chaos",
      history,
      onClose: () => {},
    }))
    expect(html).toContain("Every tick")
    expect(html).toContain("Network loss")
    expect(html).toContain("Storm risk high")
    expect(html).toContain("Asked over 2 ticks")
    expect(html).toContain("0.600 MW")
    expect(html).toContain("0.430 MW")
  })
})

describe("Replay worker state", () => {
  it("keeps the Replay layout and stage message when the worker is down", () => {
    const html = renderToStaticMarkup(createElement(ReplayPage, {
      scenarios: { scenarios: [], speeds: [15, 60, 300], default_speed: 60 },
      state: { status: "worker_not_running", brief: "session worker not running" },
      nowMs: 0,
    }))
    expect(html).toContain("Pick a scenario to replay")
    expect(html).toContain("This tick, whole fleet")
    expect(html).toContain("The scenario worker is not running. Start it with")
    expect(html).toContain("scripts/scenario_session.py")
  })
})

describe("Replay promise tick merge", () => {
  const baseSession = {
    status: "paused", error: null, updated_at: "2024-01-15T13:05:00-06:00", scenario: null, seed: null,
    speed: 60, speeds: [15, 60, 300], step_seconds: 2, tick_minutes: 5, tick_index: 1, tick_count: 4,
    start: {}, homes: [], orders: {}, zones: {}, charging_mw: 0, provenance: null, alerts: [], grid_down_zones: [],
    totals: null, log: [], honest_limits: [], history,
  }
  const tickFields = { target_mw: 0.4, delivered_mw: 0.25, missed_mw: 0.1, breaches: 0, reserve_pct: 60, reasons: ["storm_risk_high"] }

  it("merges history's unconfirmed_mw only when the last history point is the current tick", () => {
    const html = renderToStaticMarkup(createElement(ReplayPage, {
      scenarios: null,
      state: { ...baseSession, tick: { ...tickFields, tick: 2 } } as never,
      nowMs: 0,
    }))
    expect(html).toContain("Sent, not counted")
  })

  it("does not merge a stale history point's unconfirmed_mw onto a different tick", () => {
    const html = renderToStaticMarkup(createElement(ReplayPage, {
      scenarios: null,
      state: { ...baseSession, tick: { ...tickFields, tick: 3 } } as never,
      nowMs: 0,
    }))
    expect(html).not.toContain("Sent, not counted")
  })
})

describe("Replay promise panel on a mixed charging tick (Task 12: S3, deferred minor)", () => {
  it("heather tick 1: served the call, then charged; nothing blames missing spare energy", () => {
    // Real merged-engine tick (seed 42, HOME_MAX_KW=11.4, HOME_KWH=25). unconfirmed_mw from its history point.
    const html = renderToStaticMarkup(createElement(PromisePanel, {
      tick: {
        tick: 1, mode: "AUTO", target_mw: 0.2, delivered_mw: 0.19999999971958105, missed_mw: 2.804189658256462e-10, unconfirmed_mw: 0,
        charging_mw: 0.246587997, intent: "charge", intent_reason: "grid_call_served",
        reasons: ["reserve_refill", "timed_out:2", "duplicates_ignored:1", "over_delivery:1"], breaches: 0,
      },
      onOpenLedger: () => {},
      onOpenData: () => {},
    }))
    expect(html).toContain("Fleet did: Charge — served the call, then charged")
    expect(html).toMatch(/<span class="is-charge">Charged from the grid<\/span><b class="is-charge">0\.247 MW<\/b>/)
    expect(html).toMatch(/<span>Not sold<\/span><b>0\.000 MW<\/b>/)
    expect(html).not.toContain("Not sent")
    expect(html).not.toContain("no spare energy")
  })
})
