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
