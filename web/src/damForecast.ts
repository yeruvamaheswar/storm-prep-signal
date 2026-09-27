import type { DamHour, TickView } from "./contracts"
import { LOAD_ZONES, type LoadZone } from "./zonePaint"

const HOUR_MS = 3_600_000

const CHARGE_WHY = [
  "dam_cheap_hour",
  "before_spike",
  "rt_dip",
  "cheaper_hour_later",
  "no_payback",
  "full",
  "sell_band",
] as const

export type ChargeWhy = (typeof CHARGE_WHY)[number]

export type DamCell = {
  hourStart: string
  /** Central hour, e.g. "03:00". */
  label: string
  usdMwh: number
  /** Bar height, 0–100, on one scale shared by every zone. */
  heightPct: number
  charge: boolean
  now: boolean
}

export type DamRow = {
  zone: LoadZone
  cells: DamCell[]
  peakUsdMwh: number
  peakPct: number
  line: string
}

export type DamForecast = {
  rows: DamRow[]
  /** Every $/MWh on the panel carries this. */
  priceLabel: string
  asOf: string | null
}

export function usdMwh(value: number): string {
  const sign = value < 0 ? "-" : ""
  return `${sign}$${Math.abs(value).toFixed(2)}/MWh`
}

function damPriceLabel(label: string | undefined): string | null {
  if (label === "ercot") return "ERCOT DAM"
  if (label?.startsWith("recorded:")) return "recorded ERCOT DAM"
  return null
}

function isChargeWhy(value: string | undefined): value is ChargeWhy {
  return (CHARGE_WHY as readonly (string | undefined)[]).includes(value)
}

function isDamHour(value: unknown): value is DamHour {
  if (typeof value !== "object" || value === null) return false
  const hour = value as Record<string, unknown>
  return (
    typeof hour.hour_start === "string" &&
    !Number.isNaN(Date.parse(hour.hour_start)) &&
    typeof hour.usd_mwh === "number" &&
    Number.isFinite(hour.usd_mwh)
  )
}

function cheapestPhrase(count: number): string {
  return `${String(count)} cheapest ${count === 1 ? "hour" : "hours"}`
}

/** One sentence per zone from the engine's zone_charge_why. Unknown or missing reasons are named, not guessed. */
export function damLine(
  zone: LoadZone,
  why: string | undefined,
  cells: readonly DamCell[],
  hoursNeeded: number | undefined,
  priceLabel: string,
): string {
  if (!isChargeWhy(why)) return `${zone} · no charge reason on this tick`
  const chosen = cells.filter((cell) => cell.charge)
  const nowIndex = cells.findIndex((cell) => cell.now)
  const nowCell = nowIndex < 0 ? undefined : cells[nowIndex]
  const nowPrice = nowCell === undefined ? "" : ` · ${usdMwh(nowCell.usdMwh)} ${priceLabel}`
  switch (why) {
    case "dam_cheap_hour": {
      const hours = `${cheapestPhrase(hoursNeeded ?? chosen.length)} of the next ${String(cells.length)}`
      return `${zone} · charging now · ${hours}${nowPrice}`
    }
    case "before_spike":
      return `${zone} · charging now · ${cheapestPhrase(chosen.length)} before the next sell-band hour${nowPrice}`
    case "rt_dip": {
      if (chosen.length === 0) return `${zone} · charging now · real-time dip`
      const dearest = Math.max(...chosen.map((cell) => cell.usdMwh))
      return `${zone} · charging now · real-time dip · at or below the dearest chosen hour, ${usdMwh(dearest)} ${priceLabel}`
    }
    case "cheaper_hour_later": {
      const next = cells.slice(nowIndex + 1).find((cell) => cell.charge)
      if (next === undefined) return `${zone} · waiting · cheaper hour later`
      return `${zone} · waiting · cheaper hour ${next.label} · ${usdMwh(next.usdMwh)} ${priceLabel}`
    }
    case "no_payback":
      return `${zone} · not charging · no later hour pays back`
    case "full":
      return `${zone} · not charging · full, 0 hours needed`
    case "sell_band":
      return `${zone} · selling · real-time price is in the sell band`
    default: {
      const neverWhy: never = why
      return neverWhy
    }
  }
}

/** Null hides the panel: no DAM hours, or no known price label. Never falls back to tape numbers. */
export function damForecast(tick: TickView | null | undefined): DamForecast | null {
  if (!tick?.dam_hours) return null
  const priceLabel = damPriceLabel(tick.dam_label)
  if (priceLabel === null) return null
  const tickMs = Date.parse(tick.ts)
  const zones = LOAD_ZONES.flatMap((zone) => {
    const hours = (tick.dam_hours?.[zone] ?? []).filter(isDamHour)
    return hours.length === 0 ? [] : [{ zone, hours }]
  })
  if (zones.length === 0) return null
  const scale = Math.max(0, ...zones.flatMap(({ hours }) => hours.map((hour) => hour.usd_mwh)))
  const pct = (value: number) => (scale > 0 ? (Math.max(0, value) / scale) * 100 : 0)
  const rows = zones.map(({ zone, hours }): DamRow => {
    const chosen = new Set((tick.zone_charge_hours?.[zone] ?? []).map((start) => Date.parse(start)))
    const cells = hours.map((hour): DamCell => {
      const startMs = Date.parse(hour.hour_start)
      return {
        hourStart: hour.hour_start,
        label: hour.hour_start.slice(11, 16),
        usdMwh: hour.usd_mwh,
        heightPct: pct(hour.usd_mwh),
        charge: chosen.has(startMs),
        now: tickMs >= startMs && tickMs < startMs + HOUR_MS,
      }
    })
    const peakUsdMwh = Math.max(...cells.map((cell) => cell.usdMwh))
    return {
      zone,
      cells,
      peakUsdMwh,
      peakPct: pct(peakUsdMwh),
      line: damLine(zone, tick.zone_charge_why?.[zone], cells, tick.zone_hours_needed?.[zone], priceLabel),
    }
  })
  return { rows, priceLabel, asOf: tick.dam_as_of ?? null }
}
