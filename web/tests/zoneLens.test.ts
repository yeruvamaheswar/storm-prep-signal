import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { AckRail } from "../src/components/organisms/AckRail"
import { ControlBar } from "../src/components/organisms/ControlBar"
import type { TickView } from "../src/contracts"
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
      "North. Outage 9,429 MW. Price 42 $/MWh (synthetic tape price, not an LZ settlement). Floor 30% (fleet floor, not a zone floor). 10 homes discharging, 0 homes reserved.",
    )
    expect(zoneCallout(facts)).toBe("North · outage 9,429 MW · 42 $/MWh · floor 30% · 10 discharging · 0 reserved")
  })

  it("keeps a live price on North and leaves the other zones unread", () => {
    const live = { ...tapeTick(1), price_usd_mwh: 42.25, price_label: "ercot" }
    expect(zoneFacts(live, "North")).toMatchObject({ priceUsdMwh: 42.25, priceCaption: "LZ_NORTH settlement" })
    expect(zoneFacts(live, "Houston")).toMatchObject({
      priceUsdMwh: null,
      priceCaption: "no LZ price; this wall reads LZ_NORTH",
      outageMw: 3427,
    })
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
})

describe("zone controls", () => {
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
