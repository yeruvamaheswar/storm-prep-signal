import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { AckRail } from "../src/components/organisms/AckRail"
import { ControlBar } from "../src/components/organisms/ControlBar"
import type { FleetRollups, TickView } from "../src/contracts"
import layoutRun from "../src/fixtures/layout-run.json"
import { zoneBrief, zoneCallout, zoneFacts, zoneOutageSeries } from "../src/zoneLens"

const ticks = layoutRun.ticks as TickView[]

function tapeTick(tick: number): TickView {
  const found = ticks.find((item) => item.tick === tick)
  if (found === undefined) {
    throw new Error(`tick ${String(tick)} missing`)
  }
  return found
}

describe("zone lens", () => {
  it("reads North outage, the tape price, the fleet floor, and that zone's homes", () => {
    const facts = zoneFacts(tapeTick(1), "North")
    expect(facts.outageMw).toBe(9429)
    expect(facts.priceUsdMwh).toBe(42)
    expect(facts.priceCaption).toContain("not an LZ settlement")
    expect(facts.floorPct).toBe(30)
    expect(facts.floorCaption).toContain("fleet floor")
    expect(facts.discharging).toBe(10)
    expect(facts.reserved).toBe(0)
    expect(zoneBrief(facts)).toBe(
      "North. Outage 9,429 MW. Price 42 $/MWh (synthetic tape price, not an LZ settlement). Floor 30% (fleet floor, not a zone floor). Intent unread. 10 homes discharging, 0 homes reserved.",
    )
    expect(zoneCallout(facts)).toBe("North · outage 9,429 MW · 42 $/MWh · intent unread · floor 30% · 10 discharging · 0 reserved")
  })

  it("keeps a live North-only price unread on the other zones", () => {
    const live = { ...tapeTick(1), price_usd_mwh: 42.25, price_label: "ercot" }
    expect(zoneFacts(live, "North")).toMatchObject({ priceUsdMwh: 42.25, priceCaption: "LZ_NORTH settlement" })
    expect(zoneFacts(live, "Houston")).toMatchObject({
      priceUsdMwh: null,
      priceCaption: "no LZ price for this interval",
      outageMw: 3427,
    })
  })

  it("binds each zone to its own LZ row when zone_prices has that interval", () => {
    const live = {
      ...tapeTick(1),
      price_usd_mwh: 42.25,
      price_label: "ercot",
      zone_prices: { Houston: 20.63, North: 42.25, South: 18.5, West: 31.1 },
    }
    expect(zoneFacts(live, "Houston")).toMatchObject({
      priceUsdMwh: 20.63,
      priceCaption: "LZ_HOUSTON settlement",
    })
    expect(zoneFacts(live, "West")).toMatchObject({ priceUsdMwh: 31.1, priceCaption: "LZ_WEST settlement" })
    expect(zoneFacts({ ...live, zone_prices: { North: 42.25 } }, "Houston")).toMatchObject({
      priceUsdMwh: null,
      priceCaption: "no LZ price for this interval",
    })
  })

  it("shows the selected zone's own intent when the tick carries one", () => {
    const live = {
      ...tapeTick(1),
      zone_prices: { Houston: 20.63, North: 42.25, South: 18.5, West: 80.0 },
      zone_intent: { Houston: "charge", North: "hold", South: "charge", West: "discharge" },
    } as TickView
    const facts = zoneFacts(live, "West")
    expect(facts.intent).toBe("discharge")
    expect(zoneBrief(facts)).toContain("Intent discharge")
    expect(zoneCallout(facts)).toContain("West · outage 4,474 MW · 80 $/MWh · discharge")
  })

  it("counts reserved and discharging homes inside the storm zone", () => {
    const facts = zoneFacts(tapeTick(5), "North")
    expect(facts.outageMw).toBe(9294)
    expect(facts.floorPct).toBe(60)
    expect(facts.discharging).toBe(12)
    expect(facts.reserved).toBe(13)
  })

  it("plots that zone's outage MW across the tape", () => {
    expect(zoneOutageSeries(ticks, "North").slice(0, 5)).toEqual([9429, 9429, 9429, 9429, 9294])
    expect(zoneOutageSeries(ticks, "Houston")[0]).toBe(3427)
  })

  it("reads reserved, discharging, and MW from persisted rollups instead of index % 4", () => {
    const rollups: FleetRollups = {
      n: 10_000,
      zones: {
        North: {
          live: 1700,
          reserved: 40,
          discharging: 60,
          stale: 6,
          dead: 4,
          silent: 6,
          reserved_mw: 0.2,
          discharging_mw: 0.3,
        },
      },
    }
    const facts = zoneFacts(tapeTick(5), "North", rollups)
    expect(facts.discharging).toBe(60)
    expect(facts.reserved).toBe(40)
    expect(facts.supplyingMw).toBe(0.3)
    expect(zoneBrief(facts)).toContain("60 homes discharging, 40 homes reserved")
    expect(zoneCallout(facts)).toContain("60 discharging · 40 reserved")
    expect(zoneFacts(tapeTick(5), "North", null).discharging).toBe(12)
  })
})

describe("zone controls", () => {
  it("paints ack bars from persisted rollups when the tape has no zone_acks", () => {
    const rollups: FleetRollups = {
      n: 10_000,
      zones: {
        North: {
          live: 1700,
          reserved: 40,
          discharging: 60,
          stale: 6,
          dead: 4,
          silent: 6,
          reserved_mw: 0.2,
          discharging_mw: 0.3,
        },
      },
    }
    const html = renderToStaticMarkup(
      createElement(AckRail, { tick: tapeTick(1), rollups, onSelectZone: () => undefined, onClearZone: () => undefined }),
    )
    expect(html).toContain("North 1660/1710")
    expect(html).not.toContain("North 10/25")
  })

  it("presses the North ack row and leaves All zones as the reset", () => {
    const html = renderToStaticMarkup(
      createElement(AckRail, { tick: tapeTick(1), zone: "North", onSelectZone: () => undefined, onClearZone: () => undefined }),
    )
    expect(html).toContain('aria-label="Show every load zone"')
    expect(html).toContain("All zones")
    expect(html).toContain('class="ack-zone is-selected" aria-pressed="true"')
    expect(html).toContain(">North ")
    expect(html).toContain('aria-pressed="false"')
  })

  it("switches the chart caption to the selected zone", () => {
    const html = renderToStaticMarkup(
      createElement(ControlBar, {
        mode: "AUTO",
        ticks,
        selected: 0,
        scene: null,
        radar: false,
        onSelect: () => undefined,
        onScene: () => undefined,
        onMode: () => undefined,
        onRadar: () => undefined,
        zone: "North",
        zoneTick: tapeTick(1),
      }),
    )
    expect(html).toContain("North outage MW across")
    expect(html).toContain("North · outage 9,429 MW")
    expect(html).toContain("10 discharging")
    expect(html).not.toContain(">Target<")
  })
})
