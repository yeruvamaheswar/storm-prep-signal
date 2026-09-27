import { useEffect, useRef } from "react"
import type { FlowRequest } from "../flow/api"
import { nudgeSpeed } from "./tickClock"

/** What the shortcuts need from the session. `status` is null when no session is reported. */
export type ReplayKeyContext = {
  status: string | null
  speed: number | null
  speeds: readonly number[] | null | undefined
  canStep: boolean
}

type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey"> & { target: EventTarget | null }

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
}

/** Space activates a focused button or link by itself; handling it here too would toggle twice. */
function activatesOnSpace(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && ["BUTTON", "A", "SUMMARY"].includes(target.tagName)
}

/** Space = play or pause, [ = one stop slower, ] = one stop faster, . = next tick while paused. */
export function replayKeyRequest(event: KeyLike, ctx: ReplayKeyContext): FlowRequest | null {
  if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return null
  const active = ctx.status !== null && ctx.status !== "idle" && ctx.status !== "error"
  switch (event.key) {
    case " ":
    case "Spacebar":
      if (!active || activatesOnSpace(event.target)) return null
      return { kind: "play", body: { playing: ctx.status !== "playing" } }
    case "[":
    case "]": {
      if (ctx.speed === null) return null
      const x = nudgeSpeed(ctx.speed, ctx.speeds, event.key === "[" ? -1 : 1)
      return x === null ? null : { kind: "speed", body: { x } }
    }
    case ".":
      return ctx.canStep ? { kind: "step", body: {} } : null
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
