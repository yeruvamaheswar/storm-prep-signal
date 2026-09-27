/** Where the sun is, for the Replay map's night shading. Pure.
 *
 * NOAA Global Monitoring Laboratory, "General Solar Position Calculations" (the fractional-year equations for
 * declination and the equation of time). No refraction: the shading only needs day, twilight and night, which are
 * 6 degrees either side of the horizon. Time is the tick's own instant (its `ts` carries its UTC offset), so no
 * time-zone database is needed. Checked against the NOAA Solar Calculator in web/tests/replay-day.test.ts. */

const RAD = Math.PI / 180
const DAY_MS = 86_400_000

/** Day at or above this elevation, night below its negative; civil twilight in between. */
export const DAY_ELEV_DEG = 6
export const NIGHT_ELEV_DEG = -6
/** The sun's upper limb on the horizon with standard refraction (sunrise and sunset). */
const SUNRISE_ELEV_DEG = -0.833

export type Daylight = "day" | "twilight" | "night"

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/** Solar elevation in degrees above the horizon at `utcMs`, for a place at `lat`, `lng` (east positive). */
export function solarElevationDeg(utcMs: number, lat: number, lng: number): number {
  const date = new Date(utcMs)
  const year = date.getUTCFullYear()
  const dayOfYear = Math.floor((utcMs - Date.UTC(year, 0, 1)) / DAY_MS) + 1
  const hours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600
  const gamma = ((2 * Math.PI) / (isLeap(year) ? 366 : 365)) * (dayOfYear - 1 + (hours - 12) / 24)
  const eqTimeMin = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma))
  const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma) - 0.006758 * Math.cos(2 * gamma)
    + 0.000907 * Math.sin(2 * gamma) - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma)
  // True solar time in minutes (UTC, so no zone term), then the hour angle.
  const trueSolarMin = hours * 60 + eqTimeMin + 4 * lng
  const hourAngle = (trueSolarMin / 4 - 180) * RAD
  const latRad = lat * RAD
  const cosZenith = Math.sin(latRad) * Math.sin(decl) + Math.cos(latRad) * Math.cos(decl) * Math.cos(hourAngle)
  return 90 - Math.acos(Math.min(1, Math.max(-1, cosZenith))) / RAD
}

export function daylight(elevationDeg: number): Daylight {
  if (elevationDeg >= DAY_ELEV_DEG) return "day"
  if (elevationDeg >= NIGHT_ELEV_DEG) return "twilight"
  return "night"
}

/** The first sunrise after `fromMs` within a day, to the second, or null if the sun does not rise. */
export function nextSunriseMs(fromMs: number, lat: number, lng: number): number | null {
  const above = (ms: number) => solarElevationDeg(ms, lat, lng) >= SUNRISE_ELEV_DEG
  const stepMs = 60_000
  for (let t = fromMs; t < fromMs + DAY_MS; t += stepMs) {
    if (above(t) || !above(t + stepMs)) continue
    let lo = t
    let hi = t + stepMs
    while (hi - lo > 1000) {
      const mid = (lo + hi) / 2
      if (above(mid)) hi = mid
      else lo = mid
    }
    return hi
  }
  return null
}
