import type { FlowHome } from "../flow/types"
import { NOT_REPORTED } from "./format"
import { keepGauge, type LotLook } from "./zoneModel"

/** Pure numbers for the 3D house (House3D.tsx turns them into meshes). Everything here comes from the
 * home's reported fields and the order state HomePanel already derived with lotLook. Nothing is invented. */

export type CableMode = "selling" | "confirmed" | "charging" | "off"

/** The brief's literal cable colour, used only when `--rg-gave-energy` cannot be read. */
export const CABLE_FALLBACK = "#35C3CE"

/** Cable mode from the lot look at the playhead. Same rule as the flat art's cable (lotLook.cable): energy flows
 * while the order ran and waits for its report, or is confirmed. A lost report, a lost order or a closed
 * unconfirmed order draws no flow. */
export function cableMode(look: Pick<LotLook, "state" | "charging"> | null): CableMode {
  const s = look?.state?.s
  if (s !== "wait" && s !== "ok") return "off"
  if (look?.charging) return "charging"
  return s === "ok" ? "confirmed" : "selling"
}

export type CableLook = {
  /** CSS custom property to read, or null when the cable is off. */
  token: string | null
  /** Literal to use when the token is unreadable. Only the brief's giving-energy colour has one. */
  fallback: string | null
  glow: boolean
}

export function cableLook(mode: CableMode): CableLook {
  if (mode === "selling" || mode === "confirmed") return { token: "--rg-gave-energy", fallback: CABLE_FALLBACK, glow: true }
  if (mode === "charging") return { token: "--rg-charging", fallback: null, glow: true }
  return { token: null, fallback: null, glow: false }
}

/** A token's value via `read` (e.g. getComputedStyle(...).getPropertyValue), else the fallback, else null. */
export function resolveColor(look: Pick<CableLook, "token" | "fallback">, read: (name: string) => string): string | null {
  if (!look.token) return null
  const value = read(look.token).trim()
  return value || look.fallback
}

const MODE_WORDS: Record<CableMode, string> = {
  selling: "Cable glowing: giving energy.",
  confirmed: "Cable glowing: confirmed.",
  charging: "Cable glowing amber: charging.",
  off: "No energy on the cable.",
}

export type HouseModel = {
  cable: CableMode
  /** Battery fill as a fraction of the front face, or null when soc_pct is not reported. */
  fill: number | null
  /** "Not reported" when there is no fill to draw, else null. */
  fillLabel: string | null
  /** Floor line as a fraction of the front face, or null when floor_pct is not reported. */
  floor: number | null
  /** The scene in words, for the canvas's accessible name. */
  label: string
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`
}

export function houseModel(home: Pick<FlowHome, "soc_pct" | "floor_pct"> | null, look: Pick<LotLook, "state" | "charging"> | null): HouseModel {
  const gauge = home ? keepGauge(home) : { charge: null, floor: null }
  const cable = cableMode(look)
  const charge = gauge.charge === null ? "battery charge not reported" : `Battery charge ${pct(gauge.charge)}`
  const floor = gauge.floor === null ? "backup floor not reported" : `backup floor ${pct(gauge.floor)}`
  return {
    cable,
    fill: gauge.charge,
    fillLabel: gauge.charge === null ? NOT_REPORTED : null,
    floor: gauge.floor,
    label: `House, battery and power line. ${charge[0].toUpperCase()}${charge.slice(1)}, ${floor}. ${MODE_WORDS[cable]}`,
  }
}

export type Vec3 = [number, number, number]

/** A cylinder (axis local +Y, height 1) placed to span a to b: scale Y by `length`, rotate with Euler order "YZX". */
export type Segment = { position: Vec3; rotation: Vec3; length: number }

export function segmentBetween(a: Vec3, b: Vec3): Segment {
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const length = Math.hypot(...d)
  const [dx, dy, dz] = d.map((v) => (length ? v / length : 0))
  // Ry(y)·Rz(z) sends +Y to (-sin z cos y, cos z, sin z sin y); solve for the unit direction.
  const h = Math.hypot(dx, dz)
  const rz = Math.atan2(h, dy)
  const ry = h ? Math.atan2(dz, -dx) : 0
  return { position: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], rotation: [0, ry, rz], length }
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function unit(v: Vec3): Vec3 {
  const n = Math.hypot(...v)
  return [v[0] / n, v[1] / n, v[2] / n]
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/** Orthographic fit: from a camera direction (scene towards camera), the look-at target that centres `points`
 * on screen and the zoom (px per world unit) that fits them in width x height with a `margin` fraction spare. */
export function fitView(points: Vec3[], toCamera: Vec3, width: number, height: number, margin = 0.08): { target: Vec3; zoom: number } {
  const forward = unit([-toCamera[0], -toCamera[1], -toCamera[2]])
  const right = unit(cross(forward, [0, 1, 0]))
  const up = cross(right, forward)
  const xs = points.map((p) => dot(p, right))
  const ys = points.map((p) => dot(p, up))
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const zoom = Math.min(width / ((x1 - x0) * (1 + margin)), height / ((y1 - y0) * (1 + margin)))
  return { target: [cx * right[0] + cy * up[0], cx * right[1] + cy * up[1], cx * right[2] + cy * up[2]], zoom }
}

/** A sagging cable from a to b as `count` straight pieces along a quadratic curve dipped by `sag`. */
export function cableSegments(a: Vec3, b: Vec3, sag: number, count: number): Segment[] {
  const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - sag * 2, (a[2] + b[2]) / 2]
  const at = (t: number): Vec3 => {
    const u = 1 - t
    return [0, 1, 2].map((k) => u * u * a[k] + 2 * u * t * mid[k] + t * t * b[k]) as Vec3
  }
  return Array.from({ length: count }, (_, i) => segmentBetween(at(i / count), at((i + 1) / count)))
}
