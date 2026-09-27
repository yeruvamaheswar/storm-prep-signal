import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { LivePage } from "../src/features/live/LivePage"
import { PhoneChrome } from "../src/features/replay/PhoneChrome"
import {
  CLOCK_MS_DESKTOP, CLOCK_MS_PHONE, clockMs, isPhonePortrait, scenarioPollMs,
  SCENARIO_POLL_MS_DESKTOP, SCENARIO_POLL_MS_PHONE,
} from "../src/features/replay/phoneMedia"
import { ReplayPage } from "../src/features/replay/ReplayPage"

describe("phoneMedia", () => {
  it("reports the phone band from matchMedia", () => {
    expect(isPhonePortrait(() => ({ matches: true }))).toBe(true)
    expect(isPhonePortrait(() => ({ matches: false }))).toBe(false)
    expect(isPhonePortrait(undefined)).toBe(false)
  })

  it("slows the UI clock and scenario poll on phone", () => {
    expect(clockMs(false)).toBe(CLOCK_MS_DESKTOP)
    expect(clockMs(true)).toBe(CLOCK_MS_PHONE)
    expect(scenarioPollMs(false)).toBe(SCENARIO_POLL_MS_DESKTOP)
    expect(scenarioPollMs(true)).toBe(SCENARIO_POLL_MS_PHONE)
    expect(CLOCK_MS_PHONE).toBeGreaterThan(CLOCK_MS_DESKTOP)
  })
})

describe("PhoneChrome", () => {
  it("exposes Send/Keep/Trust and the two sheet openers", () => {
    const html = renderToStaticMarkup(createElement(PhoneChrome, {
      lens: "send",
      onLens: () => {},
      sheet: null,
      onSheet: () => {},
      setupLabel: "Scenario",
      fleetLabel: "This tick",
    }))
    expect(html).toContain("What to show")
    expect(html).toContain("Send")
    expect(html).toContain("Keep")
    expect(html).toContain("Trust")
    expect(html).toContain("Scenario")
    expect(html).toContain("This tick")
    expect(html).not.toContain("Close panel")
  })

  it("shows a scrim only while a sheet is open", () => {
    const open = renderToStaticMarkup(createElement(PhoneChrome, {
      lens: "keep",
      onLens: () => {},
      sheet: "setup",
      onSheet: () => {},
      setupLabel: "Inputs",
    }))
    expect(open).toContain("Close panel")
    expect(open).toContain("aria-pressed=\"true\"")
  })
})

describe("Replay and Live mount the phone dock", () => {
  it("Replay keeps Scenario and This tick in the page", () => {
    const html = renderToStaticMarkup(createElement(ReplayPage, {
      scenarios: null, state: null, nowMs: 0,
    }))
    expect(html).toContain("replay-phone-chrome")
    expect(html).toContain("Scenario")
    expect(html).toContain("This tick")
    expect(html).toContain("Pick a scenario to replay")
  })

  it("Live uses Inputs for the setup sheet and hides This tick until live", () => {
    const html = renderToStaticMarkup(createElement(LivePage, {
      snapshot: { kind: "loading" },
      run: { kind: "loading" },
      orders: { kind: "loading" },
      homes: { kind: "loading" },
      demoFleet: 100,
      nowMs: 0,
      replayStartMs: null,
      selectedZone: null,
      selectedHome: null,
      onZone: () => {},
      onBack: () => {},
      onHome: () => {},
      onCloseHome: () => {},
      onReplay: () => {},
    }))
    expect(html).toContain("replay-phone-chrome")
    expect(html).toContain("Inputs")
    expect(html).not.toContain(">This tick<")
    expect(html).not.toContain("This tick, whole fleet")
  })
})
