import type { TickView } from "../../contracts"

/** States the legend names. The layout tape has no per-home rows, so cells are a reading of the tick. */
export const HOME_STATES = ["ok", "reserved", "discharging", "stale", "dead", "unconfirmed"] as const

export type HomeState = (typeof HOME_STATES)[number]

/** Start charge is spread evenly across this band. See the fleet settings in the build plan. */
const SOC_LO = 45
const SOC_HI = 75

/** One home tops out at 5 kW, which is 0.005 MW. */
export const MW_PER_HOME = 0.005

function nonNeg(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0
  }
  return Math.floor(value)
}

function repeat(state: HomeState, count: number): HomeState[] {
  return Array.from({ length: count }, () => state)
}

/** How many live homes sit under the floor on a 45%–75% start band. */
export function homesUnderFloor(live: number, reservePct: number): number {
  const fraction = (reservePct - SOC_LO) / (SOC_HI - SOC_LO)
  const clamped = Math.min(1, Math.max(0, fraction))
  return Math.round(live * clamped)
}

export function countState(cells: readonly HomeState[], state: HomeState): number {
  return cells.reduce((sum, cell) => sum + (cell === state ? 1 : 0), 0)
}

export function fleetGrid(count: number): { cols: number; rows: number } {
  if (count <= 0) {
    return { cols: 1, rows: 1 }
  }
  const cols = Math.ceil(Math.sqrt(count))
  const rows = Math.ceil(count / cols)
  return { cols, rows }
}

/** Column count that keeps cells near-square inside the main pane. */
export function packGrid(count: number, width: number, height: number, gap: number): { cols: number; rows: number } {
  if (count <= 0 || width < 8 || height < 8) {
    return fleetGrid(count)
  }

  let best = { cols: 1, rows: count, score: -1, skew: Number.POSITIVE_INFINITY }

  for (let rows = 1; rows <= count; rows += 1) {
    const cols = Math.ceil(count / rows)
    const cellW = (width - gap * (cols - 1)) / cols
    const cellH = (height - gap * (rows - 1)) / rows
    if (cellW <= 0 || cellH <= 0) {
      continue
    }
    const score = Math.min(cellW, cellH)
    const skew = Math.abs(cellW - cellH)
    const tighter = score > best.score + 0.5 || (Math.abs(score - best.score) <= 0.5 && skew < best.skew)
    if (tighter) {
      best = { cols, rows, score, skew }
    }
  }

  return { cols: best.cols, rows: best.rows }
}

export type FleetCounts = Record<HomeState, number>

/** Index order of the runs in fleetCells. Zone by `index % 4` depends on it. */
export const FLEET_RUNS = ["reserved", "dead", "stale", "discharging", "ok", "unconfirmed"] as const satisfies readonly HomeState[]

/**
 * Homes per state for one tick.
 * On HIGH, homes under the raised floor cannot sell. Any other live home that is
 * not discharging is held too, so a storm tick has no all-clear "ok" homes.
 * Delivered MW is read as discharging homes, capped by who is still above the floor.
 * Unconfirmed is not on this tape, so that count stays zero and the legend hides the row.
 */
export function fleetCounts(tick: TickView): FleetCounts {
  const live = nonNeg(tick.live_homes)
  const stale = nonNeg(tick.stale_homes)
  const dead = nonNeg(tick.dead_homes)
  const underFloor = tick.risk_level === "HIGH" ? homesUnderFloor(live, tick.reserve_pct) : 0

  let discharging = 0
  if (tick.mode !== "HOLD" && tick.delivered_mw > 0) {
    const aboveFloor = live - underFloor
    const fromDelivered = Math.round(tick.delivered_mw / MW_PER_HOME)
    discharging = Math.min(aboveFloor, Math.max(0, fromDelivered))
  }

  const reserved = tick.risk_level === "HIGH" ? live - discharging : 0
  const ok = live - reserved - discharging

  return { ok, reserved, discharging, stale, dead, unconfirmed: 0 }
}

/** One cell per home, in FLEET_RUNS order. Grows with the fleet, so views should read fleetCounts. */
export function fleetCells(tick: TickView): HomeState[] {
  const counts = fleetCounts(tick)
  return FLEET_RUNS.flatMap((state) => repeat(state, counts[state]))
}
