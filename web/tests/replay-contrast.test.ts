import { describe, expect, it } from "vitest"
import tokens from "../src/design/tokens.css?raw"
import replayCss from "../src/features/replay/replay.css?raw"
import zoneCss from "../src/features/replay/zone.css?raw"

/** WCAG 2 contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function token(name: string): string {
  const match = tokens.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))
  if (!match) throw new Error(`${name} not found`)
  return match[1]
}

function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`${selector} not found`)
  return css.slice(start, css.indexOf("}", start))
}

describe("amber text reads at 4.5:1 or better on the Replay panels (Task 12 fix 1: M3)", () => {
  it("the charging text token clears 4.5:1 on the map panel and the clay panel", () => {
    const text = token("--rg-charging-text-strong")
    expect(contrast(text, token("--rg-panel-map"))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(text, token("--rg-panel-clay"))).toBeGreaterThanOrEqual(4.5)
  })

  it("the charged row, the Charged column, the zone charge text and the refill line use it", () => {
    expect(rule(replayCss, ".replay-ledger .is-charge")).toContain("var(--rg-charging-text-strong)")
    expect(rule(zoneCss, ".is-charge")).toContain("var(--rg-charging-text-strong)")
    expect(rule(zoneCss, ".zone-home-head p.zone-refill")).toContain("var(--rg-charging-text-strong)")
  })

  it("keeps the amber fill token unchanged", () => {
    expect(token("--rg-charging")).toBe("#c98a1b")
  })
})
