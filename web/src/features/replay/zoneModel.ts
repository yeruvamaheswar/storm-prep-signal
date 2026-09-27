import type { Point } from "../flow/flowMath"
import type { BatteryState, FlowHome, OrderTimelineEntry } from "../flow/types"
import { keyMoments } from "./keyMoments"
import { NOT_REPORTED } from "./format"
import { homeOrderState, splitOrders, stateColor, stateLabel, type ReplayOrderState } from "./orderState"
import { fmtClock } from "./tickClock"

/** Pure zone-board logic: lot layout, isometric geometry, path classes, story lots and the home journey.
 * Everything here reads logged order events and reported home fields only. Nothing is invented. */

export const LOTS_PER_ZONE = 25
export const GRID = 5

/** The mockup's isometric projection (Zone.dc.html): one lot step is 80 px across and 44 px down. */
export function iso(i: number, j: number): Point {
  return [700 + (i - j) * 80, 250 + (i + j) * 44]
}

/** Where the zone's substation sits, in board coordinates. Every order path starts here. */
export const SUBSTATION: Point = [444, 285]

/** The board's drawing window in board coordinates. The board is scaled to fit this box. */
export const WORLD = { x: 200, y: 124, w: 1000, h: 576 } as const

function round(p: Point): string {
  return p.map(Math.round).join(",")
}

export function boardPath(): string {
  return `M${[iso(-0.9, -0.9), iso(4.9, -0.9), iso(4.9, 4.9), iso(-0.9, 4.9)].map(round).join(" L")} Z`
}

export function streetsPath(): string {
  const rows = [0, 1, 2, 3, 4].map((j) => ` M${round(iso(-0.5, j + 0.5))} L${round(iso(4.5, j + 0.5))}`).join("")
  return `M${round(iso(-0.5, -0.5))} L${round(iso(-0.5, 4.5))} M${round(SUBSTATION)} L${round(iso(-0.5, 2))}${rows}`
}

export type LotSlot = {
  slot: number
  i: number
  j: number
  /** Lot centre in board coordinates. */
  cx: number
  cy: number
  /** Null for an empty lot (the zone has fewer than 25 homes). */
  home: FlowHome | null
}

export type ZoneLots = {
  /** All 25 lots, in paint order (back to front). */
  slots: LotSlot[]
  /** Homes the session reports in this zone. */
  total: number
  /** Homes drawn on the board (at most 25). */
  shown: number
}

function byId(a: FlowHome, b: FlowHome): number {
  return a.id.localeCompare(b.id, undefined, { numeric: true })
}

export function zoneHomes(homes: FlowHome[], zone: string): FlowHome[] {
  return homes.filter((home) => home.zone === zone).sort(byId)
}

/** The zone's homes in id order on a 5 x 5 grid: slot k sits at column k % 5, row floor(k / 5). */
export function zoneLots(homes: FlowHome[], zone: string): ZoneLots {
  const inZone = zoneHomes(homes, zone)
  const slots: LotSlot[] = []
  for (let slot = 0; slot < LOTS_PER_ZONE; slot += 1) {
    const i = slot % GRID
    const j = Math.floor(slot / GRID)
    const [cx, cy] = iso(i, j)
    slots.push({ slot, i, j, cx, cy, home: inZone[slot] ?? null })
  }
  slots.sort((a, b) => a.i + a.j - (b.i + b.j) || a.slot - b.slot)
  return { slots, total: inZone.length, shown: Math.min(LOTS_PER_ZONE, inZone.length) }
}

/** Substation, down the side street, along the lot's row, into the lot. `off` is the lane offset in px. */
export function orderPathPoints(i: number, j: number, off: number): Point[] {
  const a = iso(-0.5, 2)
  const b = iso(-0.5, j + 0.5)
  const c = iso(i, j + 0.5)
  const d = iso(i, j + 0.3)
  return [SUBSTATION, a, b, c, d].map(([x, y]) => [x, y + off] as Point)
}

export function orderPath(i: number, j: number, off: number): string {
  return `M${orderPathPoints(i, j, off).map(round).join(" L")}`
}

/** The loss marker: halfway along the lot's row street. */
export function lossPoint(i: number, j: number, off: number): Point {
  const b = iso(-0.5, j + 0.5)
  const c = iso(i, j + 0.5)
  return [Math.round((b[0] + c[0]) / 2), Math.round((b[1] + c[1]) / 2 + off)]
}

export type UnitKey = "own" | "r"

/** True when the unit's first `sent` carries a negative planned kW (a charge order). */
export function isChargeUnit(timeline: OrderTimelineEntry[]): boolean {
  const sent = timeline.find(([, kind]) => kind === "sent")
  return typeof sent?.[2] === "number" && sent[2] < 0
}

/** The planned kW on the unit's first `sent`, signed (negative means charge). Undefined when not logged. */
export function plannedKw(timeline: OrderTimelineEntry[]): number | undefined {
  const sent = timeline.find(([, kind]) => kind === "sent")
  return typeof sent?.[2] === "number" && Number.isFinite(sent[2]) ? sent[2] : undefined
}

/** Order state at the playhead. A unit with no event yet (a reassigned-in order sent at 1:00) is idle. */
export function unitState(timeline: OrderTimelineEntry[], tSeconds: number): ReplayOrderState {
  const seen = timeline.filter(([at]) => at <= tSeconds)
  if (!seen.length) return homeOrderState([], tSeconds)
  return homeOrderState(timeline, tSeconds)
}

/** Mockup path class for a state. Charge orders keep the class and add `p-charge` (amber) while they are
 * on their way, running or confirmed; a lost or not-counted charge keeps the red or grey of every order. */
export function pathClass(state: ReplayOrderState, charging: boolean): string {
  const base = `p-${state.s}`
  const amber = charging && (state.s === "out" || state.s === "retry" || state.s === "wait" || state.s === "ok")
  return amber ? `${base} p-charge` : base
}

/** Charge orders draw amber (the charging token), set inline so the colour holds whatever the class. */
export const CHARGE_STROKE = "var(--rg-charging)"

export type OrderPathView = {
  homeId: string
  key: UnitKey
  d: string
  cls: string
  charging: boolean
  /** The red loss marker, only while the order itself is lost. */
  marker: Point | null
}

export function zonePaths(slots: LotSlot[], orders: Record<string, OrderTimelineEntry[]> | undefined, tSeconds: number): OrderPathView[] {
  const out: OrderPathView[] = []
  const ordered = slots.filter((lot) => lot.home && orders?.[lot.home.id]?.length).sort((a, b) => a.slot - b.slot)
  ordered.forEach((lot, k) => {
    const home = lot.home as FlowHome
    const split = splitOrders(orders?.[home.id])
    const lane = (k % 3 - 1) * 4
    for (const key of ["own", "r"] as UnitKey[]) {
      const timeline = split[key]
      if (!timeline.length) continue
      // A home with both keys draws its reassigned-in order on a lane just beside its own.
      const off = key === "r" ? lane + 6 : lane
      const state = unitState(timeline, tSeconds)
      const charging = isChargeUnit(timeline)
      out.push({
        homeId: home.id,
        key,
        d: orderPath(lot.i, lot.j, off),
        cls: state.s === "idle" ? "p-idle" : pathClass(state, charging),
        charging,
        marker: state.s === "lost" ? lossPoint(lot.i, lot.j, off) : null,
      })
    }
  })
  return out
}

/** The state a lot shows: its own order, or its reassigned-in order when it has no own order. */
export function lotUnit(timeline: OrderTimelineEntry[] | undefined): { key: UnitKey; timeline: OrderTimelineEntry[] } | null {
  const split = splitOrders(timeline)
  if (split.own.length) return { key: "own", timeline: split.own }
  if (split.r.length) return { key: "r", timeline: split.r }
  return null
}

/** Not asked and at its floor. below_floor is counted apart: a live home under its floor now always refills. */
const AT_FLOOR_STATES: BatteryState[] = ["at_floor", "reserved"]

export type LotLook = {
  state: ReplayOrderState | null
  glow: string
  ring: string
  batt: string
  cable: string
  aria: string
  label: string
  charging: boolean
  /** Energy is on the service cable: the order ran and waits for its report, or is confirmed. The one cable rule
   * for the flat art (`cable`) and the 3D house (house3dModel.cableMode). */
  flowing: boolean
  tookOver: boolean
}

const CLEAR = "rgba(0,0,0,0)"
/** Battery top colour of a battery that has not run this tick. */
export const BATT_IDLE = "var(--rg-batt-idle)"
export const TRANSPARENT = CLEAR

/** One colour rule for a lot's ring and the home chip's dot: amber for a charge order while it is on its way,
 * running or confirmed; otherwise the state colour (a lost or not-counted charge keeps red or grey). */
export function orderColor(state: ReplayOrderState, charging: boolean): string {
  const failed = state.s === "lost" || state.s === "rlost" || state.s === "nc"
  return charging && !failed ? "var(--rg-charging)" : stateColor(state)
}

/** The planner used a reading that was not live (scenario.py `plan_status`, from telemetry.reported_homes).
 * False when the row carries no `plan_status` (an older worker). */
export function planNotLive(home: Pick<FlowHome, "plan_status">): boolean {
  return typeof home.plan_status === "string" && home.plan_status !== "live"
}

export const NO_FRESH_READING = "No fresh reading, so no order"

/** Why the home sits under its floor, in words (scenario.py `under_floor_why`). Empty when not reported. */
export function underFloorWords(why: FlowHome["under_floor_why"]): string {
  if (why === "started_under") return "started under it"
  if (why === "floor_raised") return "the floor rose"
  return ""
}

/** Why a home got no order. An operator HOLD sends nothing (controller.py); a home the planner saw as stale or
 * dead gets nothing; since #41 a live home under its floor always refills, so one that did not names that.
 * Empty when nothing reported gives a reason. */
export function notAskedReason(home: Pick<FlowHome, "state" | "under_floor_why" | "plan_status">, mode?: string | null): string {
  if (mode === "HOLD") return "Operator hold: no orders this tick."
  if (planNotLive(home)) return `${NO_FRESH_READING}.`
  if (home.state === "at_floor") return "Its charge is at its floor, so it keeps it all for backup."
  if (home.state === "reserved") return "Its floor was raised, so it keeps its energy for backup."
  if (home.state === "below_floor") {
    const why = underFloorWords(home.under_floor_why)
    return `Under its floor${why ? ` (${why})` : ""} and got no refill order this tick.`
  }
  return ""
}

/** A charging home the engine reports still under its floor (`under_floor_why`, set on charging homes since #41).
 * Null for any other home. */
export function refillLine(home: Pick<FlowHome, "state" | "under_floor_why">): string | null {
  if (home.state !== "charging" || !home.under_floor_why) return null
  return `Refilling to its backup floor (${underFloorWords(home.under_floor_why) || "under its floor"})`
}

export function notAskedLabel(home: Pick<FlowHome, "state" | "plan_status">): string {
  if (planNotLive(home)) return NO_FRESH_READING
  if (home.state === "below_floor") return "Not asked, under its floor"
  return AT_FLOOR_STATES.includes(home.state) ? "Not asked, at its floor" : "Not asked"
}

/** Everything a lot draws and says at the playhead. */
export function lotLook(home: FlowHome, timeline: OrderTimelineEntry[] | undefined, tSeconds: number, open: boolean): LotLook {
  const unit = lotUnit(timeline)
  const tookOver = splitOrders(timeline).r.some(([at]) => at <= tSeconds) && unit?.key === "own"
  const state = unit ? unitState(unit.timeline, tSeconds) : null
  const active = state && state.s !== "idle" ? state : null
  const charging = unit ? isChargeUnit(unit.timeline) : false
  const ran = active ? active.gave || (active.charging && (active.s === "wait" || active.s === "rlost" || active.s === "ok" || active.s === "nc")) : false
  const flowing = active ? active.s === "wait" || active.s === "ok" : false
  const refilling = charging && refillLine(home) !== null && active !== null && (active.s === "wait" || active.s === "ok")
  const label = refilling
    ? active?.s === "ok" ? "Charging to its floor" : "Charging to its floor, waiting for its report"
    : active ? stateLabel(active, unit ? plannedKw(unit.timeline) : undefined) : notAskedLabel(home)
  const suffix = tookOver ? ", also took over another home's order" : ""
  return {
    state: active,
    glow: active?.gave ? "rgba(127,227,232,0.30)" : CLEAR,
    ring: open ? "var(--rg-ink)" : active ? orderColor(active, charging) : CLEAR,
    batt: ran ? (charging ? "var(--rg-charging)" : "var(--rg-battery-glow)") : BATT_IDLE,
    cable: flowing ? (charging ? "var(--rg-charging)" : "var(--rg-gave-energy)") : CLEAR,
    aria: `${home.id}, ${label}${suffix}`,
    label,
    charging,
    flowing,
    tookOver,
  }
}

/** Keep lens: the battery's charge and floor as fractions of a gauge, or null when not reported. */
export function keepGauge(home: Pick<FlowHome, "soc_pct" | "floor_pct">): { charge: number | null; floor: number | null } {
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
  return {
    charge: ok(home.soc_pct) ? Math.min(1, Math.max(0, home.soc_pct / 100)) : null,
    floor: ok(home.floor_pct) ? Math.min(1, Math.max(0, home.floor_pct / 100)) : null,
  }
}

const TRUST_MARKS: Partial<Record<BatteryState, string>> = { stale: "Stale", dead: "Dead", unconfirmed: "Unconfirmed" }

/** Trust lens: the home's stale, dead or unconfirmed mark, and a mismatch line when one is logged by the playhead. */
export function trustMarks(
  home: Pick<FlowHome, "state">,
  timeline: OrderTimelineEntry[] | undefined,
  tSeconds: number,
  tickMinutes: number | undefined,
): { mark: string | null; mismatch: string | null } {
  const mark = TRUST_MARKS[home.state] ?? null
  // The lot's own order and any reassigned-in order both count; the earliest mismatch by the playhead wins.
  const split = splitOrders(timeline)
  let found: { unit: OrderTimelineEntry[]; entry: OrderTimelineEntry } | null = null
  for (const unit of [split.own, split.r]) {
    const entry = unit.find(([at, kind]) => kind === "mismatch" && at <= tSeconds)
    if (entry && (!found || entry[0] < found.entry[0])) found = { unit, entry }
  }
  if (!found) return { mark, mismatch: null }
  return { mark, mismatch: mismatchText(found.unit, found.entry, tickMinutes).short }
}

/** The kWh the battery really moved: the exec kW over one tick, unsigned. Undefined when not logged. */
function ranKwh(unit: OrderTimelineEntry[], tickMinutes: number | undefined): number | undefined {
  const execKw = unit.find(([, kind]) => kind === "exec")?.[2]
  return isNum(execKw) && isNum(tickMinutes) && tickMinutes > 0 ? Math.abs((execKw * tickMinutes) / 60) : undefined
}

/** Mismatch wording for a lot badge (`short`) and a journey step (`step`). The engine logs `reported_kwh`
 * signed like the order (negative for a charge), so both sides are shown unsigned and worded by direction. */
export function mismatchText(unit: OrderTimelineEntry[], entry: OrderTimelineEntry, tickMinutes: number | undefined): { short: string; step: string } {
  const charging = isChargeUnit(unit)
  const reported = isNum(entry[2]) ? `${Math.abs(entry[2]).toFixed(2)} kWh` : null
  const truthKwh = ranKwh(unit, tickMinutes)
  const truth = truthKwh === undefined ? null : `${truthKwh.toFixed(2)} kWh`
  if (charging) {
    return {
      short: `${reported ? `Reported ${reported} charged` : "Reported charge not logged"}, ${truth ? `took in ${truth}` : "took in not reported"}`,
      step: reported && truth
        ? `Its report said it charged ${reported}, but it took in ${truth}. Booked at the truth.`
        : "Its charge report did not match what the battery did. Booked at the truth.",
    }
  }
  return {
    short: `${reported ? `Reported ${reported}` : "Reported kWh not logged"}, ${truth ? `gave ${truth}` : "gave not reported"}`,
    step: reported && truth
      ? `Its report said ${reported}, but it gave ${truth}. Booked at the truth.`
      : "Its report did not match what the battery did. Booked at the truth.",
  }
}

function firstAt(orders: Record<string, OrderTimelineEntry[]>, match: (timeline: OrderTimelineEntry[]) => number | undefined): string | null {
  let best: { id: string; at: number } | null = null
  for (const id of Object.keys(orders).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const at = match(orders[id])
    if (at === undefined) continue
    if (!best || at < best.at) best = { id, at }
  }
  return best?.id ?? null
}

/** Up to three story lots: the first lost order (the time keyMoments reports), the first lost report, and
 * the first confirmation that followed a retry. Only homes drawn on the board are tagged. */
export function storyHomes(orders: Record<string, OrderTimelineEntry[]>, shownIds: string[]): string[] {
  const shown = new Set(shownIds)
  const zoneOrders = Object.fromEntries(Object.entries(orders).filter(([id]) => shown.has(id)))
  const firstDrop = keyMoments(zoneOrders).firstDrop
  const picks = [
    firstDrop === undefined ? null : firstAt(zoneOrders, (tl) => tl.find(([at, kind]) => kind === "drop" && at === firstDrop)?.[0]),
    firstAt(zoneOrders, (tl) => tl.find(([, kind]) => kind === "rdrop")?.[0]),
    firstAt(zoneOrders, (tl) => {
      const retry = tl.find(([, kind]) => kind === "retry")
      if (!retry) return undefined
      return tl.find(([at, kind]) => kind === "conf" && at >= retry[0])?.[0]
    }),
  ]
  const out: string[] = []
  for (const id of picks) if (id && !out.includes(id)) out.push(id)
  return out.slice(0, 3)
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v)
}

export type ZoneSummary = {
  homes: number
  /** Homes asked to sell (discharge) by the playhead. */
  sellHomes: number | null
  sellKw: number | typeof NOT_REPORTED
  chargeHomes: number | null
  chargeKw: number | typeof NOT_REPORTED
  openLabel: "Still open" | "Not counted"
  openKw: number | typeof NOT_REPORTED
  notAskedAtFloor: number | null
  /** Not asked and under its floor (below_floor) with a live plan: it got no refill order. */
  notAskedUnderFloor: number | null
  /** Not asked because the planner's reading of it was not live (plan_status), whatever its state. */
  notAskedNoReading: number | null
  notAskedOther: number | null
}

/** A strict kW sum: "Not reported" when any unit's planned kW is missing. An empty list is a real 0. */
function strictSum(values: Array<number | undefined>): number | typeof NOT_REPORTED {
  if (values.some((v) => !isNum(v))) return NOT_REPORTED
  return (values as number[]).reduce((total, v) => total + Math.abs(v), 0)
}

/** The zone summary at the playhead. `asked` comes from zoneActivity (homes with a sent order by now). */
export function zoneSummary(
  zone: string,
  homes: FlowHome[],
  orders: Record<string, OrderTimelineEntry[]> | undefined,
  tSeconds: number,
  asked: number | null,
): ZoneSummary {
  const inZone = zoneHomes(homes, zone)
  const openLabel = tSeconds >= 120 ? "Not counted" : "Still open"
  if (!orders || asked === null) {
    return {
      homes: inZone.length, sellHomes: null, sellKw: NOT_REPORTED, chargeHomes: null, chargeKw: NOT_REPORTED, openLabel, openKw: NOT_REPORTED,
      notAskedAtFloor: null, notAskedUnderFloor: null, notAskedNoReading: null, notAskedOther: null,
    }
  }
  const sell: Array<number | undefined> = []
  const charge: Array<number | undefined> = []
  const open: Array<number | undefined> = []
  const chargeIds = new Set<string>()
  const sellIds = new Set<string>()
  let notAskedAtFloor = 0
  let notAskedUnderFloor = 0
  let notAskedNoReading = 0
  let notAskedOther = 0
  for (const home of inZone) {
    const split = splitOrders(orders[home.id])
    let askedHere = false
    for (const timeline of [split.own, split.r]) {
      if (!timeline.some(([at, kind]) => kind === "sent" && at <= tSeconds)) continue
      askedHere = true
      const kw = plannedKw(timeline)
      if (isChargeUnit(timeline)) {
        charge.push(kw)
        chargeIds.add(home.id)
        continue
      }
      sell.push(kw)
      sellIds.add(home.id)
      if (homeOrderState(timeline, tSeconds).s !== "ok") open.push(kw)
    }
    if (!askedHere) {
      if (planNotLive(home)) notAskedNoReading += 1
      else if (AT_FLOOR_STATES.includes(home.state)) notAskedAtFloor += 1
      else if (home.state === "below_floor") notAskedUnderFloor += 1
      else notAskedOther += 1
    }
  }
  return {
    homes: inZone.length,
    // Counted directly: a home with both a sell and a charge unit is still a home asked to sell.
    sellHomes: sellIds.size,
    sellKw: strictSum(sell),
    chargeHomes: chargeIds.size,
    chargeKw: strictSum(charge),
    openLabel,
    openKw: strictSum(open),
    notAskedAtFloor,
    notAskedUnderFloor,
    notAskedNoReading,
    notAskedOther,
  }
}

export type JourneyStep = { at: number; t: string; x: string; later: boolean }

function kwText(value: unknown): string | null {
  return isNum(value) ? `${Math.abs(value).toFixed(2)} kW` : null
}

/** "This order's journey": one step per logged event, greyed while it is still ahead of the playhead. */
export function journeySteps(timeline: OrderTimelineEntry[], tSeconds: number, tickMinutes?: number): JourneyStep[] {
  const charging = isChargeUnit(timeline)
  const steps: JourneyStep[] = []
  let retried = false
  let ran = false
  const push = (at: number, x: string) => steps.push({ at, t: fmtClock(at), x, later: at > tSeconds })
  for (const [at, kind, extra] of [...timeline].sort((a, b) => a[0] - b[0])) {
    if (kind === "sent") {
      const kw = kwText(extra)
      if (charging) push(at, kw ? `Charge order sent: charging ${kw} for this tick.` : "Charge order sent for this tick.")
      else push(at, kw ? `Order sent: ${kw} for this tick.` : "Order sent for this tick.")
    }
    if (kind === "drop") push(at, retried ? "The retry was lost too." : "Lost on the way.")
    if (kind === "retry") {
      push(at, ran ? "Its report had not arrived. Retried once." : "No answer. Retried once.")
      retried = true
    }
    if (kind === "reassigned") push(at, typeof extra === "string" && extra ? `Its order was handed to ${extra}.` : "Its order was handed to another home.")
    if (kind === "reassign_failed") push(at, "No spare home could take it over.")
    if (kind === "exec") {
      const kw = kwText(extra)
      if (charging) push(at, kw ? `Battery charged ${kw}.` : "Battery charged.")
      else push(at, kw ? `Battery gave ${kw}, never going under its floor.` : "Battery gave energy, never going under its floor.")
      ran = true
    }
    if (kind === "rdrop") push(at, "Its report was lost on the way back.")
    if (kind === "dup") push(at, "A duplicate copy arrived and was ignored.")
    if (kind === "timeout") push(at, "No report by the retry deadline.")
    if (kind === "mismatch") push(at, mismatchText(timeline, [at, kind, extra], tickMinutes).step)
    if (kind === "late") push(at, "A late report arrived after the books closed.")
    if (kind === "conf") push(at, charging ? "Charge confirmed." : "Confirmed. Counted as sold.")
  }
  if (!timeline.some(([, kind]) => kind === "conf")) {
    const x = charging
      ? "Books closed. The charge was never confirmed."
      : ran
        ? "Books closed. Energy was given but never confirmed, so it is not counted."
        : "Books closed. Not counted."
    steps.push({ at: 120, t: fmtClock(120), x, later: tSeconds < 120 })
  }
  return steps
}

export type HomeFacts = {
  floor: string
  chargeBefore: string
  chargeAfter: string
}

function pct(v: unknown): string {
  return isNum(v) ? `${v.toFixed(1)}%` : NOT_REPORTED
}

/** Charge before and after this tick (`soc_before_pct` to `soc_pct`) and the floor. "Not reported" when missing. */
export function homeFacts(home: Partial<Pick<FlowHome, "soc_before_pct" | "soc_pct" | "floor_pct">>): HomeFacts {
  return {
    floor: isNum(home.floor_pct) ? `${home.floor_pct.toFixed(0)}%` : NOT_REPORTED,
    chargeBefore: pct(home.soc_before_pct),
    chargeAfter: pct(home.soc_pct),
  }
}

/** The Asked tile: the planned kW, or "Charging X kW" for a charge order. */
export function askedText(timeline: OrderTimelineEntry[], tSeconds = Infinity): string {
  // Nothing is asked before its `sent` (a reassigned-in order arrives at 1:00).
  const sent = timeline.find(([, kind]) => kind === "sent")
  if (sent && sent[0] > tSeconds) return "Not yet"
  const kw = plannedKw(timeline)
  if (kw === undefined) return NOT_REPORTED
  return kw < 0 ? `Charging ${Math.abs(kw).toFixed(2)} kW` : `${kw.toFixed(2)} kW`
}

/** The Counted-as-sold tile at the playhead. A confirmed sale shows the confirmed kW; a charge is never a sale. */
export function countedText(timeline: OrderTimelineEntry[], tSeconds: number): { text: string; confirmed: boolean } {
  if (isChargeUnit(timeline)) return { text: "Charging, not a sale", confirmed: false }
  const conf = timeline.find(([at, kind]) => kind === "conf" && at <= tSeconds)
  if (conf) return { text: isNum(conf[2]) ? `${conf[2].toFixed(2)} kW` : NOT_REPORTED, confirmed: true }
  return { text: tSeconds >= 120 ? "Not counted" : "Not yet", confirmed: false }
}

/** The home that handed its order to `homeId`, from the `reassigned` entry logged on the original home. */
export function reassignedFrom(orders: Record<string, OrderTimelineEntry[]> | undefined, homeId: string): string | null {
  for (const [id, timeline] of Object.entries(orders ?? {})) {
    if (timeline.some(([, kind, extra]) => kind === "reassigned" && extra === homeId)) return id
  }
  return null
}
