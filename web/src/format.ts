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

/** Two reserve stops. Bad data and a high outage reading are not the same reason. */
export function reserveBanner(tick: TickView, quality: string): string | null {
  if (tick.policy_reason === "signal_unavailable" || quality === "timeout" || quality === "stale") {
    return "RESERVE because data cannot be trusted"
  }
  if (tick.policy_reason === "storm_risk_high" && tick.risk_level === "HIGH" && tick.mode !== "HOLD") {
    return "RESERVE because outage MW is over the line."
  }
  return null
}
