import type { Mode, RiskLevel, TickView } from "./contracts"

export function formatMw(value: number): string {
  return value.toFixed(2)
}

export function formatGridMw(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)
}

export function formatSignedGridMw(value: number): string {
  const body = formatGridMw(Math.abs(value))
  if (value > 0) {
    return `+${body}`
  }
  if (value < 0) {
    return `-${body}`
  }
  return body
}

function homesPhrase(count: number): string {
  return count === 1 ? "1 home" : `${count} homes`
}

/** Hover copy for one metro cluster. Both MW figures keep a word in front of them. */
export function clusterCaption(counts: {
  homes: number
  reserved: number
  discharging: number
  supplyingMw: number
  zoneMw: number | null
}): string {
  const fleet = `${counts.homes} homes · ${counts.reserved} reserved · ${counts.discharging} discharging · supplying ${formatMw(counts.supplyingMw)} MW`
  if (counts.zoneMw === null) {
    return fleet
  }
  return `${fleet} · zone ${formatGridMw(counts.zoneMw)} MW`
}

/** Who is answering ERCOT on this tick. The target keeps its label, as every on-screen MW must. */
export function callCaption(tick: TickView, discharging: number, reserved: number): string {
  const call = `ERCOT call ${formatMw(tick.target_mw)} MW (${tick.target_label})`
  const supply = `supplying ${formatMw(tick.delivered_mw)} MW from ${homesPhrase(discharging)}`
  return `${call} · ${supply} · ${reserved} held`
}

export type LossCaption = {
  kind: "reallocated" | "frozen"
  missed: string
  line: string
}

/**
 * The second caption line once homes are dead. It reads the tick's counts; the engine did the allocating.
 * Given up is the dead homes' even share of the call, capped by what was actually missed,
 * so a storm tick's on-purpose miss is not blamed on the loss.
 */
export function lossCaption(tick: TickView): LossCaption | null {
  const dead = Math.max(0, tick.dead_homes)
  if (dead === 0) {
    return null
  }
  const missed = `missed ${formatMw(tick.missed_mw)} MW rising`
  switch (tick.mode) {
    case "HOLD":
      return { kind: "frozen", missed, line: "no reallocate · discharge frozen" }
    case "AUTO": {
      const live = Math.max(0, tick.live_homes)
      const fleet = live + Math.max(0, tick.stale_homes) + dead
      const givenUp = Math.min(Math.max(0, tick.missed_mw), (tick.target_mw * dead) / fleet)
      const homes = live === 1 ? "1 live home" : `${live} live homes`
      return { kind: "reallocated", missed, line: `reallocated to ${homes} · ${formatMw(givenUp)} MW given up` }
    }
    default: {
      const neverMode: never = tick.mode
      return neverMode
    }
  }
}

/** Silent is unconfirmed plus dead. "still" only reads true once someone has gone quiet. */
export function ackCaption(
  counts: { pending: number; acked: number; unconfirmed: number; dead: number },
  deliveredMw: number,
): string {
  const silent = counts.unconfirmed + counts.dead
  const parts = counts.pending > 0 ? [`${counts.pending} pending`] : []
  parts.push(`${silent} silent`, `${counts.acked} acked`)
  parts.push(`call ${silent > 0 ? "still " : ""}${formatMw(deliveredMw)} MW`)
  return parts.join(" · ")
}

/** What a home's state means for the call. Other states add nothing to the tooltip. */
export function homeRoleNote(status: string): string | null {
  if (status === "discharging") return "counts toward the call"
  if (status === "reserved") return "held for backup"
  return null
}

export function formatPrice(value: number | null): string {
  if (value === null) {
    return "—"
  }
  return value.toFixed(0)
}

export function formatTs(ts: string): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) {
    return ts
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "America/Chicago",
    timeZoneName: "short",
  }).format(date)
}

export function modeName(mode: Mode): string {
  switch (mode) {
    case "AUTO":
      return "AUTO"
    case "HOLD":
      return "HOLD"
    default: {
      const neverMode: never = mode
      return neverMode
    }
  }
}

export type FeedChip = "TAPE" | "LIVE" | "SYNTHETIC"

/** What the mast shows for this run. Fixture copy stays on the Demo badge title. */
export type HeaderIdentity = {
  runId: string | null
  demoTitle: string | null
}

function isFixtureRunId(runId: string): boolean {
  return /fixture|^demo[-_]/i.test(runId)
}

function isFixtureDisclaimer(line: string): boolean {
  return /layout fixture|not an engine run|demo tape/i.test(line)
}

/**
 * A layout fixture and a demo tape id are tape chrome.
 * A timestamp run id and a real decision line stay on the wall.
 */
export function headerIdentity(runId: string, decisionLine: string | null): HeaderIdentity {
  const id = runId.trim()
  const line = decisionLine?.trim() ?? ""
  const fixtureId = id !== "" && isFixtureRunId(id)
  const fixtureLine = line !== "" && isFixtureDisclaimer(line)
  if (!fixtureId && !fixtureLine) {
    return { runId: id === "" ? null : id, demoTitle: null }
  }
  const gated = [fixtureId ? id : "", fixtureLine ? line : ""].filter((part) => part !== "").join(" — ")
  return {
    runId: fixtureId ? null : id,
    demoTitle: gated,
  }
}

/** The brief footer is the decision line. A fixture disclaimer is not a decision. */
export function briefDecision(decisionLine: string | null | undefined): string | null {
  const text = decisionLine?.trim() ?? ""
  if (text === "" || isFixtureDisclaimer(text)) {
    return null
  }
  return text
}

// One chip for the whole strip. Synthetic wins so a mixed tick is not read as live.
export function feedChip(targetLabel: string, priceLabel: string): FeedChip {
  const kinds = [labelKind(targetLabel), labelKind(priceLabel)]
  if (kinds.includes("synthetic")) return "SYNTHETIC"
  if (kinds.includes("tape")) return "TAPE"
  if (kinds.includes("live")) return "LIVE"
  return "SYNTHETIC"
}

function labelKind(label: string): "synthetic" | "tape" | "live" | "skip" {
  const value = label.trim().toLowerCase()
  if (value === "" || value === "none") return "skip"
  if (value === "synthetic") return "synthetic"
  if (value.startsWith("recorded:") || value.startsWith("tape:")) return "tape"
  if (value === "live" || value === "ercot" || value === "utility") return "live"
  return "skip"
}

const REASON_LINES: Record<string, string> = {
  storm_reserve: "Storm reserve raised",
  fleet_headroom_short: "Not enough headroom above the floor",
  operator_hold: "Operator hold",
  signal_unavailable: "Storm signal could not be read",
  holding_spare_energy: "Holding spare energy",
}

export type ReasonCopy = {
  label: string
  tooltip?: string
}

// Floor and Risk share these codes. The label is what the operator reads; the tooltip says why the floor moved.
const FLOOR_REASONS: Record<string, ReasonCopy> = {
  normal: {
    label: "Normal",
    tooltip: "Outage MW is under the reserve threshold, so the floor stays at the base reserve.",
  },
  storm_risk_high: {
    label: "Storm risk high",
    tooltip: "Outage MW is past the reserve threshold, so every home's floor rose to the storm reserve.",
  },
  signal_unavailable: {
    label: "Signal unavailable",
    tooltip: "The storm signal could not be read, so the floor rose to the storm reserve.",
  },
  weather_alert: {
    label: "Weather alert",
    tooltip: "A weather alert covers this zone, so that zone's floor rose to the storm reserve.",
  },
}

/** Sentence-case a floor or risk reason. A caption that is already a sentence is left as written. */
export function headerReason(code: string): ReasonCopy {
  const known = FLOOR_REASONS[code]
  if (known !== undefined) {
    return known
  }
  if (!code.includes("_")) {
    return { label: code }
  }
  const words = code.replaceAll("_", " ").replaceAll(":", " ")
  return { label: words.charAt(0).toUpperCase() + words.slice(1) }
}

export type BriefTick = {
  delivered_mw: number
  target_mw: number
  reserve_pct: number
  reasons: string[]
  policy_reason: string
}

function briefCodes(tick: BriefTick): string[] {
  if (tick.policy_reason === "signal_unavailable" && !tick.reasons.includes("signal_unavailable")) {
    return ["signal_unavailable", ...tick.reasons]
  }
  return [...tick.reasons]
}

function joinReasonClauses(lines: string[]): string {
  const [first, ...rest] = lines
  if (first === undefined) {
    return ""
  }
  return [first, ...rest.filter(Boolean).map((line) => `${line.slice(0, 1).toLowerCase()}${line.slice(1)}`)].join("; ")
}

/** One or two sentences from TickResult codes. Live uses this; Demo keeps the tape brief. */
export function tickBrief(tick: BriefTick): string {
  const delivered = `Delivered ${formatMw(tick.delivered_mw)} of ${formatMw(tick.target_mw)} MW`
  const codes = briefCodes(tick)
  if (codes.length === 0) {
    return `${delivered}. Floor ${String(tick.reserve_pct)}%.`
  }
  return `${delivered}. ${joinReasonClauses(codes.map(reasonText))}.`
}

export function reasonText(code: string): string {
  const known = REASON_LINES[code]
  if (known !== undefined) {
    return known
  }
  const dead = countedHomes(code, "homes_dead:", "dead")
  if (dead !== null) {
    return dead
  }
  const stale = countedHomes(code, "homes_stale:", "stale")
  if (stale !== null) {
    return stale
  }
  return code.replaceAll("_", " ").replaceAll(":", " ")
}

function countedHomes(code: string, prefix: string, state: "dead" | "stale"): string | null {
  if (!code.startsWith(prefix)) {
    return null
  }
  const raw = code.slice(prefix.length)
  const count = Number(raw)
  if (!Number.isInteger(count) || count < 0) {
    return `${raw} homes are ${state}`
  }
  if (count === 1) {
    return `1 home is ${state}`
  }
  return `${count} homes are ${state}`
}

/** Tape ticks are clean. A scene can pass timeout or stale when the feed cannot be trusted. */
export function tapeStamp(tick: number, tickCount: number, quality = "ok"): string {
  return `quality: ${quality} · tape tick ${tick}/${tickCount}`
}

export function riskName(level: RiskLevel | null): string {
  switch (level) {
    case "LOW":
      return "LOW"
    case "HIGH":
      return "HIGH"
    case null:
      return "UNKNOWN"
    default: {
      const neverLevel: never = level
      return neverLevel
    }
  }
}
