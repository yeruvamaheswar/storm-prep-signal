import { useEffect, useRef } from "react"
import type { FlowRequest } from "../flow/api"
import { seekBy, ticksPerHour } from "./dayModel"
import { nudgeSpeed, SPEED_STOPS, type SpeedStop } from "./tickClock"

/** A speed request just sent, and the speed the session reported when it was sent. */
export type SentSpeed = { x: number; from: number | null; atMs: number }

/** What the shortcuts need from the session. `status` is null when no session is reported. */
export type ReplayKeyContext = {
  status: string | null
  speed: number | null
  speeds: readonly number[] | null | undefined
  canStep: boolean
  /** The current view's stops ([ and ] move within them). Default: the Watch orders stops. */
  stops?: readonly SpeedStop[]
  /** The last speed sent (by a key or the slider), read at key time so two quick presses do not send the same speed. */
  sent?: { current: SentSpeed | null }
  /** For the seek keys (Task 16B): where the session is, and whether a seek can be sent now (dayModel.canSeek). */
  tickIndex?: number | null
  tickCount?: number | null
  tickMinutes?: number | null
  canSeek?: boolean
}

type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey"> & {
  target: EventTarget | null
  repeat?: boolean
  shiftKey?: boolean
}

/** A sent speed counts until the session reports a different speed, or this long if it never does (same as the slider). */
const SENT_SPEED_MS = 3000

/** Inputs that take no typed text: the speed slider, checkboxes, radios and buttons. */
const NON_TEXT_INPUTS = ["range", "checkbox", "radio", "button", "submit", "reset", "image", "color", "file"]
/** Inputs that Space toggles or presses by itself. */
const SPACE_INPUTS = ["checkbox", "radio", "button", "submit", "reset", "image", "color", "file"]

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.includes(target.type)
  return ["TEXTAREA", "SELECT"].includes(target.tagName)
}

/** Space activates a focused button, link or toggle by itself; handling it here too would toggle twice. */
function activatesOnSpace(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement) return SPACE_INPUTS.includes(target.type)
  return target instanceof HTMLElement && ["BUTTON", "A", "SUMMARY"].includes(target.tagName)
}

/** The speed to nudge from: the one just sent while the session still reports the speed it had then. */
function nudgeFrom(reported: number | null, sent: SentSpeed | null | undefined, nowMs: number): number | null {
  if (sent && sent.from === reported && nowMs - sent.atMs < SENT_SPEED_MS) return sent.x
  return reported
}

/** Records a speed request as it is sent; other requests leave the record alone. */
export function rememberSpeed(sent: { current: SentSpeed | null }, request: FlowRequest, reported: number | null, nowMs: number): void {
  if (request.kind === "speed") sent.current = { x: request.body.x, from: reported, atMs: nowMs }
}

const SEEK_STATUSES = ["playing", "paused", "finished"] as const

/** A seek `ticks` from where the session is, or null when a seek cannot be sent (or would not move). While playing it
 * goes as a delta the worker resolves against its live tick (dayModel.seekBy). */
function seekKey(ctx: ReplayKeyContext, ticks: number): FlowRequest | null {
  if (!ctx.canSeek || typeof ctx.tickIndex !== "number" || typeof ctx.tickCount !== "number") return null
  const status = SEEK_STATUSES.find((s) => s === ctx.status)
  if (!status) return null
  return seekBy({ status, tick_index: ctx.tickIndex, tick_count: ctx.tickCount, tick_minutes: ctx.tickMinutes ?? 5 }, ticks)
}

/** Space = play or pause, [ = one stop slower, ] = one stop faster, . = next tick while paused (else forward one tick),
 * , = back one tick, Shift+, and Shift+. = one hour back or forward. */
export function replayKeyRequest(event: KeyLike, ctx: ReplayKeyContext, nowMs = Date.now()): FlowRequest | null {
  if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return null
  const active = ctx.status !== null && ctx.status !== "idle" && ctx.status !== "error"
  switch (event.key) {
    case " ":
    case "Spacebar":
      if (!active || activatesOnSpace(event.target)) return null
      return { kind: "play", body: { playing: ctx.status !== "playing" } }
    case "[":
    case "]": {
      // Holding the key down would race through every stop.
      if (event.repeat) return null
      const from = nudgeFrom(ctx.speed, ctx.sent?.current, nowMs)
      if (from === null) return null
      const x = nudgeSpeed(from, ctx.speeds, event.key === "[" ? -1 : 1, ctx.stops ?? SPEED_STOPS)
      return x === null ? null : { kind: "speed", body: { x } }
    }
    case ",":
    case ".":
    case "<":
    case ">": {
      const forward = event.key === "." || event.key === ">"
      const hour = event.shiftKey === true || event.key === "<" || event.key === ">"
      // While paused, . stays Next tick (Task 11), as before.
      if (forward && !hour && ctx.canStep) return { kind: "step", body: {} }
      // Holding the key would queue a seek per repeat; each seek re-runs the engine.
      if (event.repeat) return null
      const ticks = hour ? ticksPerHour(ctx.tickMinutes ?? 5) : 1
      return seekKey(ctx, forward ? ticks : -ticks)
    }
    default:
      return null
  }
}

/** Listens on the window while the Replay page is mounted. The latest context is read on each key. */
export function useReplayKeys(ctx: ReplayKeyContext, onRequest: (request: FlowRequest) => void): void {
  const latest = useRef({ ctx, onRequest })
  useEffect(() => {
    latest.current = { ctx, onRequest }
  })
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const request = replayKeyRequest(event, latest.current.ctx)
      if (!request) return
      event.preventDefault()
      latest.current.onRequest(request)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
}
