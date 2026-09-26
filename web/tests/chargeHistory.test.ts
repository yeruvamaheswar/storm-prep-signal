import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { createClient } from "../src/api/client"
import { parseHomeHistory } from "../src/domain/parse"
import { ChargeHistory } from "../src/features/fleet/ChargeHistory"
import { HomePage } from "../src/features/fleet/HomePage"
import { formatSeen } from "../src/features/fleet/display"
import { previewHomes } from "../src/features/fleet/preview-data"

const BASE = "http://ops.example/v1"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

const body = {
  home_id: "home-001",
  readings: [
    { tick: 1, seen_at: "2026-09-26T22:00:00+00:00", soc_kwh: 12.4, charge_state: "DISCHARGING", power_kw: 4.0 },
    { tick: 2, seen_at: "2026-09-26T22:05:00+00:00", soc_kwh: 12.0, charge_state: "DISCHARGING", power_kw: 4.0 },
    { tick: 3, seen_at: "2026-09-26T22:10:00+00:00", soc_kwh: 12.0, charge_state: "HOLDING", power_kw: 0 },
  ],
  commands: [
    { command_id: "home-001:1", tick: 1, kw: 4.0, actual_kw: 4.0, ack: "ok", sent_at: "2026-09-26T22:00:00+00:00" },
    { command_id: "home-001:2", tick: 2, kw: 4.0, actual_kw: 4.0, ack: "ok", sent_at: "2026-09-26T22:05:00+00:00" },
    { command_id: "home-001:3", tick: 3, kw: 0, actual_kw: 0, ack: "timeout", sent_at: "2026-09-26T22:10:00+00:00" },
  ],
}

describe("parseHomeHistory", () => {
  it("parses the shared history shape oldest-first", () => {
    const parsed = parseHomeHistory(body)
    expect(parsed.home_id).toBe("home-001")
    expect(parsed.readings.map((reading) => reading.soc_kwh)).toEqual([12.4, 12.0, 12.0])
    expect(parsed.readings[0]).toMatchObject({ charge_state: "DISCHARGING", power_kw: 4.0 })
    expect(parsed.commands.map((command) => command.command_id)).toEqual([
      "home-001:1",
      "home-001:2",
      "home-001:3",
    ])
    expect(parsed.commands[2]).toMatchObject({ kw: 0, ack: "timeout" })
  })

  it("treats missing arrays as empty instead of a fake series", () => {
    expect(parseHomeHistory({ home_id: "home-001" })).toEqual({
      home_id: "home-001",
      readings: [],
      commands: [],
    })
    expect(parseHomeHistory({ home_id: "home-001", readings: [], commands: [] })).toEqual({
      home_id: "home-001",
      readings: [],
      commands: [],
    })
  })

  it("tolerates null optionals and rejects a bad charge number", () => {
    const parsed = parseHomeHistory({
      home_id: "home-001",
      readings: [{ tick: null, seen_at: "2026-09-26T22:00:00+00:00", soc_kwh: 10, charge_state: null, power_kw: null }],
      commands: [{ command_id: "home-001:1", tick: null, kw: 0, actual_kw: null, ack: null, sent_at: null }],
    })
    expect(parsed.readings[0]).toMatchObject({ tick: null, charge_state: null, power_kw: null })
    expect(parsed.commands[0]).toMatchObject({ tick: null, actual_kw: null, ack: null, sent_at: "" })
    expect(() =>
      parseHomeHistory({
        home_id: "home-001",
        readings: [{ seen_at: "2026-09-26T22:00:00+00:00", soc_kwh: "full" }],
        commands: [],
      }),
    ).toThrow(/soc_kwh/)
  })
})

describe("history client", () => {
  it("fetches the home history path and parses the body", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(body))
    const client = createClient({ fetch: fetchMock, baseUrl: BASE, operatorId: "op-14" })
    const history = await client.history("home-001")
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${BASE}/homes/home-001/history`)
    expect(history.home_id).toBe("home-001")
    expect(history.readings).toHaveLength(3)
  })

  it("clamps the limit so a caller cannot request 10k rows", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(body))
    const client = createClient({ fetch: fetchMock, baseUrl: BASE, operatorId: "op-14" })
    await client.history("home-001", 10_000)
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${BASE}/homes/home-001/history?limit=200`)
    await client.history("home-001", 48)
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(`${BASE}/homes/home-001/history?limit=48`)
  })
})

describe("ChargeHistory", () => {
  it("shows an em dash and no curve when the history is empty", () => {
    const html = renderToStaticMarkup(
      createElement(ChargeHistory, { readings: [], commands: [], floorKwh: 12 }),
    )
    expect(html).toContain("Charge history")
    expect(html).toContain("—")
    expect(html).not.toContain("<polyline")
    expect(html).not.toContain("<circle")
  })

  it("draws charge as an ink polyline with a hairline floor and muted labels", () => {
    const parsed = parseHomeHistory(body)
    const html = renderToStaticMarkup(
      createElement(ChargeHistory, {
        readings: parsed.readings,
        commands: parsed.commands,
        floorKwh: 12,
      }),
    )
    expect(html).toContain("<polyline")
    expect(html).toContain('stroke="var(--ink)"')
    expect(html).toContain('stroke="var(--line)"')
    expect(html).toContain('fill="var(--muted)"')
    expect(html).toContain("IBM Plex Sans")
    expect(html).not.toContain("gradient")
    expect(html).not.toContain("shadow")
    expect(html).toContain("12.4")
    expect(html).toContain("floor")
    expect(html).toContain(formatSeen("2026-09-26T22:00:00+00:00"))
    expect(html).toContain(formatSeen("2026-09-26T22:10:00+00:00"))
  })

  it("draws a flat hold as a visible line instead of collapsing it", () => {
    const html = renderToStaticMarkup(
      createElement(ChargeHistory, {
        readings: [
          { tick: 1, seen_at: "2026-09-26T22:00:00+00:00", soc_kwh: 12.0, charge_state: "HOLDING", power_kw: 0 },
          { tick: 2, seen_at: "2026-09-26T22:05:00+00:00", soc_kwh: 12.0, charge_state: "HOLDING", power_kw: 0 },
        ],
        commands: [],
        floorKwh: 10,
      }),
    )
    expect(html).toContain("<polyline")
  })

  it("lists commands oldest-first so the newest stays at the bottom with the graph", () => {
    const parsed = parseHomeHistory(body)
    const html = renderToStaticMarkup(
      createElement(ChargeHistory, {
        readings: parsed.readings,
        commands: parsed.commands,
        floorKwh: 12,
      }),
    )
    // Command rows render kW, ack, and sent time; order in the payload is kept.
    expect(html).toContain("4.0")
    expect(html).toContain("timeout")
    expect(html).toContain(formatSeen("2026-09-26T22:10:00+00:00"))
    const cmdSection = html.slice(html.indexOf('aria-label="Commands"'))
    const posFirstSent = cmdSection.indexOf(formatSeen("2026-09-26T22:00:00+00:00"))
    const posLastSent = cmdSection.indexOf(formatSeen("2026-09-26T22:10:00+00:00"))
    expect(posFirstSent).toBeGreaterThanOrEqual(0)
    expect(posLastSent).toBeGreaterThan(posFirstSent)
  })
})

describe("HomePage history", () => {
  it("renders the charge history section with an em dash before the fetch resolves", () => {
    const html = renderToStaticMarkup(
      createElement(HomePage, { home: previewHomes[0], onBack: () => undefined }),
    )
    expect(html).toContain("Charge history")
    expect(html).toContain("Commands")
    expect(html).toContain("—")
  })
})
