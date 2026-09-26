import type { TickView } from "./contracts"
import { zoneAggregate } from "./fleetAggregate"
import { formatGridMw, formatPrice } from "./format"
import { zonePaint, type LoadZone } from "./zonePaint"

/**
 * A zone drill-in reads the tick. Outage MW is the zone column.
 * Price is that zone's LZ row when `zone_prices` (or a live North-only stamp) has one.
 * The floor is the fleet floor.
 */

const ZONE_SETTLEMENT: Record<LoadZone, string> = {
  Houston: "LZ_HOUSTON",
  North: "LZ_NORTH",
  South: "LZ_SOUTH",
  West: "LZ_WEST",
}

export type ZoneFacts = {
  zone: LoadZone
  outageMw: number | null
  priceUsdMwh: number | null
  priceCaption: string
  floorPct: number
  floorCaption: string
  discharging: number
  reserved: number
}

const FLEET_FLOOR = "fleet floor, not a zone floor"

function finitePrice(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function priceFact(tick: TickView, zone: LoadZone): { usd: number | null; caption: string } {
  const bound = tick.zone_prices
  if (bound !== undefined) {
    const usd = finitePrice(bound[zone])
    if (usd !== null) {
      return { usd, caption: `${ZONE_SETTLEMENT[zone]} settlement` }
    }
    return { usd: null, caption: "no LZ price for this interval" }
  }
  const label = tick.price_label.trim().toLowerCase()
  if (label === "ercot") {
    if (zone === "North") {
      return { usd: tick.price_usd_mwh, caption: "LZ_NORTH settlement" }
    }
    return { usd: null, caption: "no LZ price for this interval" }
  }
  if (tick.price_usd_mwh === null) {
    return { usd: null, caption: "price missing" }
  }
  const named = tick.price_label.trim()
  const kind = named === "" ? "tape price" : `${named} tape price`
  return { usd: tick.price_usd_mwh, caption: `${kind}, not an LZ settlement` }
}

function zoneOutageMw(tick: TickView, zone: LoadZone): number | null {
  return zonePaint(tick).zones.find((item) => item.zone === zone)?.mw ?? null
}

export function zoneFacts(tick: TickView, zone: LoadZone): ZoneFacts {
  const price = priceFact(tick, zone)
  const homes = zoneAggregate(tick, zone) ?? { discharging: 0, reserved: 0 }
  return {
    zone,
    outageMw: zoneOutageMw(tick, zone),
    priceUsdMwh: price.usd,
    priceCaption: price.caption,
    floorPct: tick.reserve_pct,
    floorCaption: FLEET_FLOOR,
    discharging: homes.discharging,
    reserved: homes.reserved,
  }
}

function homesClause(count: number, role: string): string {
  const homes = count === 1 ? "home" : "homes"
  return `${String(count)} ${homes} ${role}`
}

export function zoneBrief(facts: ZoneFacts): string {
  const outage = facts.outageMw === null ? "Outage unread" : `Outage ${formatGridMw(facts.outageMw)} MW`
  const price =
    facts.priceUsdMwh === null
      ? `Price unread (${facts.priceCaption})`
      : `Price ${formatPrice(facts.priceUsdMwh)} $/MWh (${facts.priceCaption})`
  const floor = `Floor ${String(facts.floorPct)}% (${facts.floorCaption})`
  const homes = `${homesClause(facts.discharging, "discharging")}, ${homesClause(facts.reserved, "reserved")}`
  return `${facts.zone}. ${outage}. ${price}. ${floor}. ${homes}.`
}

/** Map callout for one load zone. The title carries why price and floor are not zone series. */
export function zoneCallout(facts: ZoneFacts): string {
  const outage = facts.outageMw === null ? "outage unread" : `outage ${formatGridMw(facts.outageMw)} MW`
  const price = facts.priceUsdMwh === null ? "price unread" : `${formatPrice(facts.priceUsdMwh)} $/MWh`
  return `${facts.zone} · ${outage} · ${price} · floor ${String(facts.floorPct)}% · ${String(facts.discharging)} discharging · ${String(facts.reserved)} reserved`
}

export function zoneOutageSeries(ticks: readonly TickView[], zone: LoadZone): number[] {
  return ticks.map((tick) => zoneOutageMw(tick, zone) ?? 0)
}
