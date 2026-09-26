import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { CALM_LINE } from "../src/calmStreak"
import { CalmMeter } from "../src/components/molecules/CalmMeter"

function meter(streak: number): string {
  return renderToStaticMarkup(createElement(CalmMeter, { streak }))
}

describe("calm meter", () => {
  it("draws a zero as a meter with the all-clear definition", () => {
    const html = meter(0)
    expect(html).toContain('role="meter"')
    expect(html).toContain('aria-valuenow="0"')
    expect(html).toContain('aria-valuemax="2"')
    expect(html).toContain("is-zero")
    expect(html).toContain("calm-track")
    expect(html).toContain("calm-mark")
    expect(html).toContain('style="width:0%"')
    expect(html).toContain(CALM_LINE)
    expect(html).not.toContain("calm-pip")
  })

  it("fills halfway at one and full at two", () => {
    expect(meter(1)).toContain('style="width:50%"')
    const full = meter(2)
    expect(full).toContain('style="width:100%"')
    expect(full).toContain("tone-ok")
    expect(full).not.toContain("is-zero")
  })
})