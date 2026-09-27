export function mw(value: number | null | undefined, digits = 3): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(digits)} MW` : "Not reported"
}

export function kw(value: number | null | undefined, digits = 0): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(digits)} kW` : "Not reported"
}

export function plainReason(code: string): string {
  const words = code.replace(/_/g, " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function oneLine(text: string | undefined, fallback = "No summary reported"): string {
  const trimmed = (text ?? "").replace(/\s+/g, " ").trim()
  if (!trimmed) return fallback
  return trimmed.length > 72 ? `${trimmed.slice(0, 69)}...` : trimmed
}

export function sum(values: Array<number | undefined>): number {
  return values.reduce<number>((total, value) => total + (typeof value === "number" && Number.isFinite(value) ? value : 0), 0)
}
