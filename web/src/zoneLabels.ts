import { MW_PER_HOME } from "./components/organisms/fleetCells"
import { clusterOf, type HomeNode } from "./components/organisms/homeNodes"

export type PlanePoint = { readonly x: number; readonly y: number }

export type PlaneRect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

export type LabelCandidate = PlanePoint & { readonly inside: boolean }

/** Uppercase 11px label, plus the field chip padding. */
export function labelSize(text: string): { w: number; h: number } {
  return { w: Math.ceil(text.length * 7.4) + 8, h: 18 }
}

export function rectCentered(point: PlanePoint, width: number, height: number): PlaneRect {
  return { x: point.x - width / 2, y: point.y - height / 2, w: width, h: height }
}

function pointHitsRect(point: PlanePoint, rect: PlaneRect): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h
}

function clearance(rect: PlaneRect, point: PlanePoint): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.w))
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.h))
  return Math.hypot(dx, dy)
}

function rectsOverlap(a: PlaneRect, b: PlaneRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

function inFrame(point: PlanePoint, frame: PlaneRect | undefined): boolean {
  if (frame === undefined) {
    return true
  }
  return point.x >= frame.x && point.y >= frame.y && point.x <= frame.x + frame.w && point.y <= frame.y + frame.h
}

/**
 * Pick the candidate whose label box stays farthest from the dots.
 * A clear spot inside the zone beats a clear spot in the gulf.
 * A spot that covers a dot loses to both.
 */
export function pickLabelAnchor(
  candidates: readonly LabelCandidate[],
  width: number,
  height: number,
  obstacles: readonly PlanePoint[],
  blocked: readonly PlaneRect[],
  frame?: PlaneRect,
): LabelCandidate | null {
  let best: LabelCandidate | null = null
  let bestScore = Number.NEGATIVE_INFINITY
  for (const candidate of candidates) {
    const box = rectCentered(candidate, width, height)
    const hits = obstacles.reduce((sum, point) => sum + (pointHitsRect(point, box) ? 1 : 0), 0)
    const gap = obstacles.length === 0 ? 1_000 : Math.min(...obstacles.map((point) => clearance(box, point)))
    const overlap = blocked.reduce((sum, rect) => sum + (rectsOverlap(box, rect) ? 1 : 0), 0)
    // A label that nearly touches the dots should step into open water instead of staying inside.
    const cramped = gap < 14
    const outside = candidate.inside ? 0 : cramped ? 0 : 500
    const tight = cramped ? 1_500 : 0
    const offMap = inFrame(candidate, frame) ? 0 : 80_000
    const score = gap - hits * 10_000 - overlap * 50_000 - outside - tight - offMap
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return best
}

/** Nudge copies of each sample by about one label, so a crowded zone can step into open water. */
export function haloCandidates(
  points: readonly LabelCandidate[],
  width: number,
  height: number,
  spawn: (x: number, y: number) => LabelCandidate,
): LabelCandidate[] {
  const step = height + 8
  const shifts = [
    [0, 0],
    [0, step],
    [0, step * 2],
    [0, step * 3],
    [0, -step],
    [width * 0.75, 0],
    [-width * 0.75, 0],
  ] as const
  const seen = new Set<string>()
  const out: LabelCandidate[] = []
  for (const point of points) {
    for (const [dx, dy] of shifts) {
      const x = point.x + dx
      const y = point.y + dy
      const key = `${Math.round(x)}:${Math.round(y)}`
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      out.push(dx === 0 && dy === 0 ? point : spawn(x, y))
    }
  }
  return out
}

export function clusterGroups(nodes: readonly HomeNode[]): HomeNode[][] {
  const groups = new Map<string, HomeNode[]>()
  for (const node of nodes) {
    const key = clusterOf(node)
    const list = groups.get(key)
    if (list === undefined) {
      groups.set(key, [node])
    } else {
      list.push(node)
    }
  }
  return [...groups.values()]
}

export function clusterCounts(nodes: readonly HomeNode[], zoneMw: number | null): {
  homes: number
  reserved: number
  discharging: number
  supplyingMw: number
  zoneMw: number | null
} {
  const reserved = nodes.filter((node) => node.status === "reserved").length
  const discharging = nodes.filter((node) => node.status === "discharging").length
  return {
    homes: nodes.length,
    reserved,
    discharging,
    supplyingMw: discharging * MW_PER_HOME,
    zoneMw,
  }
}
