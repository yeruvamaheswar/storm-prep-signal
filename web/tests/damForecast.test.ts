import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { DamForecast } from "../src/components/organisms/DamForecast"
import type { TickView } from "../src/contracts"
import { damForecast, type DamRow } from "../src/damForecast"

function hours(prices: number[]): { hour_start: string; usd_mwh: number }[] {
  return prices.map((usd_mwh, index) => ({
    hour_start: `2026-09-25T${String(12 + index).padStart(2, "0")}:00-05:00`,
    usd_mwh,
  }))
}

function tick(extra: Partial<TickView>): TickView {
  return {
    tick: 1,
    ts: "2026-09-25T12:05:00-05:00",
    mode: "AUTO",
    target_mw: 0.4,
    target_label: "synthetic",
    delivered_mw: 0.4,
    missed_mw: 0,
    price_usd_mwh: 185,
    price_label: "synthetic",
    reserve_pct: 30,
    policy_reason: "normal",
    risk_level: "LOW",
    live_homes: 100,
    stale_homes: 0,
    dead_homes: 0,
    breaches: 0,
    reasons: [],
    brief: "",
    dam_label: "ercot",
    dam_as_of: "2026-09-25",
    ...extra,
  }
}

function row(why: string, prices: number[], charge: string[], needed?: number): DamRow {
  const forecast = damForecast(
    tick({
      dam_hours: { Houston: hours(prices) },
      zone_charge_hours: { Houston: charge },
      zone_charge_why: { Houston: why },
      zone_hours_needed: needed === undefined ? {} : { Houston: needed },
    }),
  )
  const first = forecast?.rows[0]
  if (first === undefined) throw new Error("expected a Houston row")
  return first
}

describe("DAM forecast cells", () => {
  it("scales bars on one shared max, flags charge hours, the current hour, and each zone's high", () => {
    const forecast = damForecast(
      tick({
        dam_hours: { North: hours([10, 20]), Houston: hours([40, 5, 20]) },
        zone_charge_hours: { Houston: ["2026-09-25T13:00-05:00"] },
      }),
    )
    expect(forecast?.rows.map((r) => r.zone)).toEqual(["Houston", "North"])
    const [houston, north] = forecast?.rows ?? []
    expect(houston?.cells.map((c) => c.heightPct)).toEqual([100, 12.5, 50])
    expect(houston?.cells.map((c) => c.charge)).toEqual([false, true, false])
    expect(houston?.cells.map((c) => c.now)).toEqual([true, false, false])
    expect(houston?.cells.map((c) => c.label)).toEqual(["12:00", "13:00", "14:00"])
    expect(houston?.peakPct).toBe(100)
    expect(north?.peakUsdMwh).toBe(20)
    expect(north?.peakPct).toBe(50)
    expect(north?.cells).toHaveLength(2)
  })

  it("keeps a negative price at zero height", () => {
    const cells = row("full", [-5, 20], [], 0).cells
    expect(cells.map((c) => c.heightPct)).toEqual([0, 100])
  })
})

describe("DAM forecast lines", () => {
  it("dam_cheap_hour names the hours needed, the window, and this hour's price", () => {
    const line = row("dam_cheap_hour", [14.1, 30, 12, 40], ["2026-09-25T12:00-05:00", "2026-09-25T14:00-05:00"], 2).line
    expect(line).toBe("Houston · charging now · 2 cheapest hours of the next 4 · $14.10/MWh ERCOT DAM")
  })

  it("dam_cheap_hour says hour for one", () => {
    expect(row("dam_cheap_hour", [9, 30], ["2026-09-25T12:00-05:00"], 1).line).toContain("1 cheapest hour of the next 2")
  })

  it("rt_dip names the dearest chosen hour", () => {
    const line = row("rt_dip", [30, 11.2, 18.4], ["2026-09-25T13:00-05:00", "2026-09-25T14:00-05:00"], 2).line
    expect(line).toBe(
      "Houston · charging now · real-time dip · at or below the dearest chosen hour, $18.40/MWh ERCOT DAM",
    )
  })

  it("cheaper_hour_later names the next chosen hour and its price", () => {
    const line = row("cheaper_hour_later", [20, 30, 11.2], ["2026-09-25T14:00-05:00"], 1).line
    expect(line).toBe("Houston · waiting · cheaper hour 14:00 · $11.20/MWh ERCOT DAM")
  })

  it("no_payback, full, and sell_band carry no price", () => {
    expect(row("no_payback", [20, 21], [], 1).line).toBe("Houston · not charging · no later hour pays back")
    expect(row("full", [20, 21], [], 0).line).toBe("Houston · not charging · full, 0 hours needed")
    expect(row("sell_band", [70, 21], [], 1).line).toBe("Houston · selling · real-time price is in the sell band")
  })

  it("names a missing or unknown reason instead of guessing one", () => {
    expect(row("", [20], [], 1).line).toBe("Houston · no charge reason on this tick")
    expect(row("later_maybe", [20], [], 1).line).toBe("Houston · no charge reason on this tick")
  })

  it("labels recorded tape prices as recorded", () => {
    const forecast = damForecast(
      tick({
        dam_label: "recorded:ERCOT NP4-190-CD",
        dam_hours: { West: hours([14.1]) },
        zone_charge_hours: { West: ["2026-09-25T12:00-05:00"] },
        zone_charge_why: { West: "dam_cheap_hour" },
      }),
    )
    expect(forecast?.rows[0]?.line).toContain("$14.10/MWh recorded ERCOT DAM")
  })

  it("every $/MWh in every line carries its label", () => {
    const whys = ["dam_cheap_hour", "rt_dip", "cheaper_hour_later", "no_payback", "full", "sell_band"]
    for (const why of whys) {
      const line = row(why, [20, 11, 30], ["2026-09-25T13:00-05:00"], 1).line
      for (const match of line.matchAll(/\$-?[\d.]+\/MWh/g)) {
        expect(line.slice((match.index ?? 0) + match[0].length)).toMatch(/^ ERCOT DAM/)
      }
    }
  })
})

describe("DAM forecast hidden", () => {
  it("hides with no tick, no dam_hours, empty zones, or no price label", () => {
    expect(damForecast(null)).toBeNull()
    expect(damForecast(tick({}))).toBeNull()
    expect(damForecast(tick({ dam_hours: {} }))).toBeNull()
    expect(damForecast(tick({ dam_hours: { Houston: [] } }))).toBeNull()
    expect(damForecast(tick({ dam_hours: { Houston: hours([10]) }, dam_label: "none" }))).toBeNull()
    expect(damForecast(tick({ dam_hours: { Houston: hours([10]) }, dam_label: undefined }))).toBeNull()
  })

  it("renders nothing without dam_hours and never shows the tape price", () => {
    expect(renderToStaticMarkup(createElement(DamForecast, { tick: tick({}) }))).toBe("")
    const html = renderToStaticMarkup(
      createElement(DamForecast, {
        tick: tick({ dam_hours: { Houston: hours([14.1]) }, zone_charge_why: { Houston: "no_payback" } }),
      }),
    )
    expect(html).toContain("Next 24 h price (ERCOT DAM, $/MWh)")
    expect(html).toContain("Houston · not charging · no later hour pays back")
    expect(html).toContain("$14.10/MWh ERCOT DAM")
    expect(html).not.toContain("185")
  })
})
