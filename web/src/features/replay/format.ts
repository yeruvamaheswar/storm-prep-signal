export const NOT_REPORTED = "Not reported"

export function mw(value: number | string | null | undefined, digits = 3): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(digits)} MW` : NOT_REPORTED
}

export function kw(value: number | string | null | undefined, digits = 0): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(digits)} kW` : NOT_REPORTED
}

/** A whole count, or "Not reported" when the value is missing. Never shows 0 for a missing count. */
export function count(value: number | string | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : NOT_REPORTED
}

export function plainReason(code: string): string {
  const words = code.replace(/_/g, " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Collapses whitespace. The rail clamps the text to two lines in CSS, so nothing is cut here. */
export function oneLine(text: string | undefined, fallback = "No summary reported"): string {
  const trimmed = (text ?? "").replace(/\s+/g, " ").trim()
  return trimmed || fallback
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/** Sum of the reported values. "Not reported" when every value is missing, never an invented 0. */
export function sum(values: Array<number | null | undefined>): number | typeof NOT_REPORTED {
  const known = values.filter(isNumber)
  if (!known.length) return NOT_REPORTED
  return known.reduce((total, value) => total + value, 0)
}
