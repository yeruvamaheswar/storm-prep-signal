import { useEffect, useState } from "react"

/** A sent speed shows as chosen until the session reports it, or this long if it never does. */
export const PENDING_SPEED_MS = 3000

/** The speed a control shows: one just sent, kept only while the session still reports the speed it had when it was
 * sent; otherwise the reported speed. Shared by the Watch orders slider and the Day view pace presets. */
export function usePendingSpeed(reported: number | null | undefined): { shown: number | null; mark: (x: number) => void } {
  const [pending, setPending] = useState<{ x: number; from: number | null | undefined } | null>(null)

  useEffect(() => {
    if (pending === null) return
    const timer = setTimeout(() => setPending(null), PENDING_SPEED_MS)
    return () => clearTimeout(timer)
  }, [pending])

  const shown = (pending && pending.from === reported ? pending.x : reported) ?? null
  return { shown, mark: (x) => setPending({ x, from: reported }) }
}
