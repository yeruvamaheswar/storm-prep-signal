export const SESSION_SPEEDS = [2.4, 4.8, 12, 15, 30, 60, 150, 300, 600] as const
export type SessionSpeed = (typeof SESSION_SPEEDS)[number]

/** Seconds of order activity each tick replays: the order window runs 0:00 to 2:05. */
const WINDOW_T = 125
/** Where the playhead rests while paused: books close at 2:00. */
export const HOLD_T = 120

export type ReplayClockInput = {
  playing: boolean
  nowMs: number
  tickArrivedAtMs: number
  stepSeconds: number
  scrubberT: number
}

export function stepSeconds(tickMinutes: number, speed: number): number {
  return (tickMinutes * 60) / speed
}

function clampT(t: number): number {
  return Math.min(WINDOW_T, Math.max(0, t))
}

export function replayTickSeconds(input: ReplayClockInput): number {
  if (!input.playing) return clampT(input.scrubberT)
  if (!(input.stepSeconds > 0)) return 0
  const elapsedSeconds = Math.max(0, (input.nowMs - input.tickArrivedAtMs) / 1000)
  return clampT((elapsedSeconds / input.stepSeconds) * WINDOW_T)
}

export function fmtClock(tSeconds: number): string {
  const whole = Math.max(0, Math.floor(tSeconds))
  const minutes = Math.floor(whole / 60)
  const seconds = whole % 60
  return `${minutes}:${String(seconds).padStart(2, "0")}`
}

// --- speed stops for the Replay slider ---

type StopName = "ratio" | "Time-lapse" | null

export type SpeedStop = { x: number; name: StopName; about: boolean }

/** Slowest first. The seconds in each label come from tick_minutes, never from this table. */
export const SPEED_STOPS: SpeedStop[] = [
  { x: 2.4, name: "ratio", about: true },
  { x: 4.8, name: "ratio", about: true },
  { x: 12, name: "ratio", about: true },
  { x: 30, name: null, about: true },
  { x: 60, name: null, about: true },
  { x: 300, name: "Time-lapse", about: false },
]

function trimNumber(value: number): string {
  return String(Math.round(value * 10) / 10)
}

/** The pace a viewer feels at this speed, for example "5× · about 25 s per tick" for 12 at 5-minute ticks. */
export function speedLabel(x: number, tickMinutes: number): string {
  const stop = SPEED_STOPS.find((candidate) => candidate.x === x) ?? { x, name: null, about: true }
  const seconds = stepSeconds(tickMinutes, x)
  // Real time plays the 125 s order window at true speed.
  const ratio = x / stepSeconds(tickMinutes, WINDOW_T)
  let name: string | null = stop.name === "ratio" ? `${trimNumber(ratio)}×` : stop.name
  if (stop.name === "ratio" && Math.abs(ratio - 1) < 1e-9) name = "Real time"
  const amount = seconds >= 60 ? `${Math.round(seconds / 60)} min` : seconds < 1 ? `${trimNumber(seconds)} s` : `${Math.round(seconds)} s`
  const pace = `${stop.about ? "about " : ""}${amount} per tick`
  return name ? `${name} · ${pace}` : pace
}

/** The stops this session offers, slowest first. */
export function availableStops(speeds: readonly number[] | undefined | null): SpeedStop[] {
  if (!speeds) return []
  return SPEED_STOPS.filter((stop) => speeds.includes(stop.x))
}

/** One offered stop slower (-1) or faster (+1) than `speed`, or null at the end. */
export function nudgeSpeed(speed: number, speeds: readonly number[] | undefined | null, direction: -1 | 1): number | null {
  const stops = availableStops(speeds).map((stop) => stop.x)
  const next = direction < 0 ? stops.filter((x) => x < speed).pop() : stops.find((x) => x > speed)
  return next ?? null
}

// --- the playhead inside one tick ---

/**
 * Where the playhead is anchored. "play" runs the window while the session plays; "step" runs it once after a
 * Next tick and then holds at 2:00; "frozen" rests where a pause caught it; "hold" rests at 2:00. A speed change,
 * a pause and a resume all re-anchor at the current position, so the playhead never jumps backwards or skips.
 */
export type Playhead = {
  tickIndex: number | null
  atMs: number
  fromT: number
  stepSeconds: number
  mode: "play" | "step" | "frozen" | "hold"
}

export type PlayheadObservation = { tickIndex: number; playing: boolean; stepSeconds: number; nowMs: number }

export function initialPlayhead(nowMs: number): Playhead {
  return { tickIndex: null, atMs: nowMs, fromT: 0, stepSeconds: 0, mode: "hold" }
}

function runningT(p: Playhead, nowMs: number): number {
  if (p.mode === "hold") return HOLD_T
  if (p.mode === "frozen" || !(p.stepSeconds > 0)) return p.fromT
  const elapsedSeconds = Math.max(0, (nowMs - p.atMs) / 1000)
  const cap = p.mode === "step" ? HOLD_T : WINDOW_T
  return Math.min(cap, Math.max(0, p.fromT + (elapsedSeconds / p.stepSeconds) * WINDOW_T))
}

/** The playhead now. Pause and play are read from the playhead's mode (set by `advancePlayhead`), so `_playing` is unused. */
export function playheadSeconds(p: Playhead, nowMs: number, _playing?: boolean): number {
  if (p.mode === "step" && !(p.stepSeconds > 0)) return HOLD_T
  return runningT(p, nowMs)
}

export function advancePlayhead(p: Playhead, obs: PlayheadObservation): Playhead {
  if (obs.tickIndex !== p.tickIndex) {
    const forward = p.tickIndex !== null && obs.tickIndex > p.tickIndex && !obs.playing
    // A tick that played just before a pause freezes at its start, as the worker keeps its whole step.
    const pausedAfterPlay = forward && p.mode === "play"
    // Any other forward move while paused is Next tick (two quick presses can land in one poll).
    const mode = obs.playing ? "play" : pausedAfterPlay ? "frozen" : forward ? "step" : "hold"
    return { tickIndex: obs.tickIndex, atMs: obs.nowMs, fromT: 0, stepSeconds: obs.stepSeconds, mode }
  }
  if (p.mode === "play" && !obs.playing) {
    // Pause freezes the playhead where it is.
    return { ...p, atMs: obs.nowMs, fromT: runningT(p, obs.nowMs), stepSeconds: obs.stepSeconds, mode: "frozen" }
  }
  if (obs.playing && (p.mode === "frozen" || p.mode === "step")) {
    // Play resumes from where the playhead rests; the paused time is not played.
    return { ...p, atMs: obs.nowMs, fromT: runningT(p, obs.nowMs), stepSeconds: obs.stepSeconds, mode: "play" }
  }
  if (obs.stepSeconds !== p.stepSeconds) {
    return { ...p, atMs: obs.nowMs, fromT: runningT(p, obs.nowMs), stepSeconds: obs.stepSeconds }
  }
  return p
}
