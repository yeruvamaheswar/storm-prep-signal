// Clocks keep the offset on the wire so a tape is not relabeled as Texas local time.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

export function formatClock(iso: string): string {
  const match = iso.match(/^\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})$/)
  if (match === null) return iso
  const month = MONTHS[Number(match[1]) - 1]
  const day = match[2]
  const time = match[3]
  const offset = match[4]
  if (month === undefined || day === undefined || time === undefined || offset === undefined) return iso
  const zone = offset === "Z" ? "UTC" : offset
  return `${Number(day)} ${month} ${time}${zone}`
}

export function ageMinutes(asOf: string, tickTs: string): number | null {
  const deltaMs = Date.parse(tickTs) - Date.parse(asOf)
  if (Number.isNaN(deltaMs)) return null
  return Math.round(deltaMs / 60000)
}

export function formatMw(value: number): string {
  const digits = Math.abs(value) >= 100 ? 0 : 2
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

export function formatSignedMw(value: number): string {
  if (value > 0) return `+${formatMw(value)}`
  return formatMw(value)
}

export function formatUsd(value: number): string {
  const digits = Number.isInteger(value) ? 0 : 2
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: 2,
  })
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 })
}

export function formatProvenance(source: string, asOf: string, quality?: string): string {
  const clock = formatClock(asOf)
  if (quality === undefined || quality === "ok") return `${source} · ${clock}`
  return `${source} · ${clock} · ${quality}`
}

export function earliestIso(stamps: string[]): string {
  const first = stamps[0]
  if (first === undefined) return ""
  return stamps.reduce((earliest, stamp) =>
    Date.parse(stamp) < Date.parse(earliest) ? stamp : earliest,
  )
}
