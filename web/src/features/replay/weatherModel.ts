import type { Point } from "../flow/flowMath"
import type { FlowCounty, FlowTick, FlowZoneRow } from "../flow/types"
import { zoneRaised } from "./mapModel"
import { SIGNAL_MISSING_REASON, isWeatherReason } from "./reasonCodes"

export { isWeatherReason }

/** Weather on the Replay views: the one rule the map and the zone board both read. Pure, and it reads the
 * playhead's tick only (the tick on screen), never a newer one. Nothing is guessed: missing data shows nothing. */

export const ISLANDED_TEXT = "Islanded: backing up its own homes"

export type ZoneWeather = {
  /** The zone's floor is above the fleet's base floor this tick, whatever the reason. Drives the amber map fill. */
  floorRaised: boolean
  /** Weather raised the zone this tick: its floor is raised or its reason is a storm or weather-alert code, and
   * the reason is not a missing ERCOT signal (a dead feed is not weather). Drives clouds, rain, dim and windows. */
  weather: boolean
  /** The data reports the zone's grid down this tick. False when the data says nothing. */
  gridDown: boolean
}

type WeatherTick = Partial<Pick<FlowTick, "zone_reserve_pct" | "zone_reasons" | "grid_down_zones">>
type WeatherRow = Partial<Pick<FlowZoneRow, "reserve_pct" | "reason" | "grid_down">>

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v)
}

export function zoneWeather(
  zone: string,
  tick: WeatherTick | null | undefined,
  row: WeatherRow | null | undefined,
  baseFloorPct: number | undefined,
): ZoneWeather {
  // The tick's own floor wins; the zone row (built from the same tick) fills in when the tick has none.
  const tickFloor = tick?.zone_reserve_pct?.[zone]
  const floor = isNum(tickFloor) ? tickFloor : row?.reserve_pct
  const floorRaised = zoneRaised(zone, { zone_reserve_pct: isNum(floor) ? { [zone]: floor } : {} }, baseFloorPct)
  const reason = tick?.zone_reasons?.[zone] ?? row?.reason
  const gridDown = Array.isArray(tick?.grid_down_zones)
    ? tick.grid_down_zones.includes(zone)
    : row?.grid_down === true
  const weather = (floorRaised || isWeatherReason(reason)) && reason !== SIGNAL_MISSING_REASON
  return { floorRaised, weather, gridDown }
}

/** Muted note for a zone where an NWS alert was sent but JEV said no, so the base floor was kept. */
export const JEV_NO_TEXT = "NWS alert · JEV no · base floor kept"

type CountyTick = Partial<Pick<FlowTick, "zone_reasons" | "county_reasons">>

/** #47: an alert names counties; JEV said no for this zone's named counties, so its reason stays `normal` and
 * nothing on the map would change. True when the zone reason is normal and some county of this zone (from the
 * session's county roster) reads `jev_no`. False when the tick or roster carries nothing to read. */
export function alertKeptBase(zone: string, tick: CountyTick | null | undefined, counties: readonly FlowCounty[] | null | undefined): boolean {
  const reasons = tick?.county_reasons
  if (!reasons || !counties?.length) return false
  if (tick?.zone_reasons?.[zone] !== "normal") return false
  return counties.some((county) => county.zone === zone && reasons[county.fips] === "jev_no")
}

export function fleetWeather(
  zones: readonly string[],
  tick: WeatherTick | null | undefined,
  rows: Partial<Record<string, WeatherRow>> | null | undefined,
  baseFloorPct: number | undefined,
): Record<string, ZoneWeather> {
  return Object.fromEntries(zones.map((zone) => [zone, zoneWeather(zone, tick, rows?.[zone], baseFloorPct)]))
}

export type Box = { x: number; y: number; w: number; h: number }

/** The pixel box around a zone's projected ring, or null when the ring has no usable point. */
export function ringBox(points: Point[]): Box | null {
  const ok = points.filter(([x, y]) => isNum(x) && isNum(y))
  if (!ok.length || ok.length !== points.length) return null
  const xs = ok.map((p) => p[0])
  const ys = ok.map((p) => p[1])
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

export type CloudBlob = { cx: number; cy: number; rx: number; ry: number }

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** The mockup's blurred cloud ellipses (Main.dc.html), sized from the zone's box instead of fixed pixels:
 * one over the zone's anchor and two beside it, every centre kept inside the box. */
export function cloudBlobs(box: Box, anchor: Point): CloudBlob[] {
  const inX = (v: number) => clamp(v, box.x, box.x + box.w)
  const inY = (v: number) => clamp(v, box.y, box.y + box.h)
  const rx = (f: number) => Math.max(8, Math.min(box.w / 2, box.w * f))
  const ry = (f: number) => Math.max(6, Math.min(box.h / 2, box.h * f))
  return [
    { cx: inX(anchor[0]), cy: inY(anchor[1]), rx: rx(0.4), ry: ry(0.26) },
    { cx: inX(box.x + box.w * 0.72), cy: inY(box.y + box.h * 0.28), rx: rx(0.3), ry: ry(0.2) },
    { cx: inX(box.x + box.w * 0.3), cy: inY(box.y + box.h * 0.72), rx: rx(0.32), ry: ry(0.2) },
  ]
}

/** A CSS clip-path polygon of the ring, in pixels relative to the box, so rain stays inside the zone. */
export function clipPolygon(points: Point[], box: Box): string {
  const px = (v: number) => `${Math.round(v * 10) / 10}px`
  return `polygon(${points.map(([x, y]) => `${px(x - box.x)} ${px(y - box.y)}`).join(", ")})`
}
