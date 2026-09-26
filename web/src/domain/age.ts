import type { Tick } from "./types"

function stamp(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) return null
  if (Number.isNaN(Date.parse(value))) return null
  return value
}

export function oldestAsOf(tick: Tick): string | null {
  const target = stamp(tick.target?.as_of)
  const price = stamp(tick.price?.as_of)
  const stress = stamp(tick.stress?.as_of)
  if (target === null || price === null || stress === null) return null
  const stamps = [target, price, stress]
  return stamps.reduce((earliest, current) =>
    Date.parse(current) < Date.parse(earliest) ? current : earliest,
  )
}
