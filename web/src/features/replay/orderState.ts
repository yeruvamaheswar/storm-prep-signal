import type { OrderKind, OrderTimelineEntry } from "../flow/types"

export type ReplayOrderStatus = "out" | "retry" | "lost" | "wait" | "rlost" | "ok" | "nc" | "idle"

export type ReplayOrderState = {
  s: ReplayOrderStatus
  gave: boolean
  retried: boolean
  dup: boolean
  charging: boolean
}

export const REPLAY_STATE_COLORS: Record<ReplayOrderStatus, string> = {
  out: "#1FA9B5",
  retry: "#1FA9B5",
  lost: "#C8412F",
  wait: "#35C3CE",
  rlost: "#C8412F",
  ok: "#2F8A55",
  nc: "#8A928C",
  idle: "#8A928C",
}

const DEFAULT_STATE: ReplayOrderState = { s: "idle", gave: false, retried: false, dup: false, charging: false }

export function splitOrders(timeline: OrderTimelineEntry[] = []): { own: OrderTimelineEntry[]; r: OrderTimelineEntry[] } {
  const split = { own: [] as OrderTimelineEntry[], r: [] as OrderTimelineEntry[] }
  for (const entry of timeline) {
    const key = entry[3] ?? "own"
    split[key].push(entry)
  }
  return split
}

export function homeOrderState(timeline: OrderTimelineEntry[] = [], tSeconds: number): ReplayOrderState {
  if (!timeline.length) return { ...DEFAULT_STATE }

  let s: ReplayOrderStatus = "out"
  let gave = false
  let retried = false
  let dup = false
  let charging = false

  for (const [at, kind, extra] of [...timeline].sort((a, b) => a[0] - b[0])) {
    if (at > tSeconds) break
    if (kind === "sent" && typeof extra === "number" && extra < 0) charging = true
    if ((kind === "exec" || kind === "conf") && typeof extra === "number" && extra < 0) charging = true
    if (kind === "drop") s = "lost"
    if (kind === "retry") {
      retried = true
      s = gave ? "wait" : "retry"
    }
    if (kind === "exec") {
      gave = true
      s = "wait"
    }
    if (kind === "rdrop") s = "rlost"
    if (kind === "dup") dup = true
    if (kind === "conf") {
      gave = true
      s = "ok"
    }
  }
  if (tSeconds >= 120 && s !== "ok") s = "nc"
  return { s, gave, retried, dup, charging }
}

export function stateLabel(state: Pick<ReplayOrderState, "s" | "gave"> & Partial<ReplayOrderState>, _kw?: number): string {
  if (state.s === "out") return "Order on its way"
  if (state.s === "retry") return "Retrying"
  if (state.s === "lost") return "Order lost"
  if (state.s === "wait") return "Gave energy, waiting for its report"
  if (state.s === "rlost") return "Gave energy, report lost"
  if (state.s === "ok") return "Confirmed, counted"
  if (state.s === "nc") return state.gave ? "Gave energy, not counted" : "No answer, not counted"
  return "Holding at its floor"
}

export function stateColor(state: ReplayOrderStatus | Pick<ReplayOrderState, "s">): string {
  const key = typeof state === "string" ? state : state.s
  return REPLAY_STATE_COLORS[key]
}

export function isReplayOrderKind(kind: string): kind is OrderKind {
  return [
    "sent",
    "drop",
    "exec",
    "rdrop",
    "retry",
    "reassigned",
    "reassign_failed",
    "dup",
    "conf",
    "timeout",
    "mismatch",
    "late",
  ].includes(kind)
}
