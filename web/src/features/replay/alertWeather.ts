/** Rain on the Replay map (Task 14 ruling): only over the counties the engine applied an alert to this tick, and only
 * for storm-type NWS events. The storm rule (ERCOT risk HIGH), freeze warnings and heat advisories raise floors but
 * draw no rain. Pure: it reads the tick's provenance and the session's active alerts, nothing else.
 *
 * Since #50 the engine names each alert's roster counties in `alerts[].named_counties` and puts the applied counties
 * in the frame's `weather_counties` event (keys are FIPS). The event comes from the alerts that name the county; the
 * `weather_counties` value is not read (it keeps only the first alert's event when two overlap a county). */

/** The alert fields read here. Local so this module does not depend on the shared type while Task 15 edits it;
 * Part B switches to `ActiveAlert` from flow/types. */
export type AlertLike = {
  event?: string
  expires?: string
  sent_at_tick?: number | null
  named_counties?: ReadonlyArray<{ fips: string }>
}

/** The provenance fields read here (the tick's own number, ts and events). */
export type ProvenanceLike = {
  tick?: number
  ts?: string
  events?: Record<string, unknown> | null
}

/** NWS event names that bring rain or storms. A Hard Freeze Warning or a Heat Advisory does not. */
export const RAIN_EVENT = /Tropical Storm|Hurricane|Flash Flood|Flood|Severe Thunderstorm|Tornado/i

export type AlertCounty = {
  fips: string
  /** "rain" when an active alert naming this county is a storm-type event; "none" otherwise. */
  effect: "rain" | "none"
  /** The events of the active alerts that name this county, in alert order. */
  events: string[]
}

/** The county FIPS the engine applied this tick: the keys of the frame's `weather_counties` event. Null when the
 * tick's provenance is not reported at all. */
function appliedFips(provenance: ProvenanceLike | null | undefined): string[] | null {
  if (!provenance) return null
  const counties = provenance.events?.weather_counties
  if (!counties || typeof counties !== "object" || Array.isArray(counties)) return []
  return Object.keys(counties).sort()
}

/** Same rule as the engine's `Session.alert_active`: from `sent_at_tick` until the archived `expires`. A field the
 * alert or the tick does not carry does not rule the alert out. */
function activeAt(alert: AlertLike, provenance: ProvenanceLike): boolean {
  if (typeof alert.sent_at_tick === "number" && typeof provenance.tick === "number" && provenance.tick < alert.sent_at_tick) {
    return false
  }
  const tsMs = provenance.ts ? Date.parse(provenance.ts) : NaN
  const expiresMs = alert.expires ? Date.parse(alert.expires) : NaN
  if (Number.isFinite(tsMs) && Number.isFinite(expiresMs) && tsMs > expiresMs) return false
  return true
}

/** Each county an alert applied to this tick, with its map effect. Null when provenance is not reported. */
export function alertCounties(
  provenance: ProvenanceLike | null | undefined,
  alerts: readonly AlertLike[] | null | undefined,
): AlertCounty[] | null {
  const fipsList = appliedFips(provenance)
  if (fipsList === null || !provenance) return null
  const active = (alerts ?? []).filter((alert) => activeAt(alert, provenance))
  return fipsList.map((fips) => {
    const events = active
      .filter((alert) => (alert.named_counties ?? []).some((county) => county?.fips === fips))
      .map((alert) => alert.event ?? "")
      .filter((event) => event !== "")
    return { fips, effect: events.some((event) => RAIN_EVENT.test(event)) ? "rain" : "none", events }
  })
}

/** The county FIPS that get rain, sorted. Empty when nothing is reported. */
export function rainFips(counties: readonly AlertCounty[] | null | undefined): string[] {
  return (counties ?? []).filter((county) => county.effect === "rain").map((county) => county.fips)
}

export type CountyGeo = { fips: string; zone: string; name: string; ring: Array<[number, number]> }

/** County rings ([lng, lat]) from geo/tx-roster-counties.json (Census 2023 cartographic boundaries, simplified). */
export function countyGeos(geo: unknown): CountyGeo[] {
  type Feature = { properties?: { fips?: unknown; zone?: unknown; name?: unknown }; geometry?: { type?: string; coordinates?: unknown } }
  const features = (geo as { features?: Feature[] } | null)?.features ?? []
  const out: CountyGeo[] = []
  for (const feature of features) {
    const { fips, zone, name } = feature.properties ?? {}
    const ring = (feature.geometry?.coordinates as number[][][] | undefined)?.[0]
    if (typeof fips !== "string" || typeof zone !== "string" || feature.geometry?.type !== "Polygon" || !ring?.length) continue
    out.push({ fips, zone, name: typeof name === "string" ? name : fips, ring: ring.map(([lng, lat]) => [lng, lat] as [number, number]) })
  }
  return out
}

/** True when a rain county lies in this zone, by the session's county roster. */
export function zoneHasRain(zone: string, rain: readonly string[], roster: ReadonlyArray<{ zone: string; fips: string }>): boolean {
  return roster.some((county) => county.zone === zone && rain.includes(county.fips))
}
