import { useEffect, useRef } from "react"

/** Moves focus into a drawer when it opens and closes it on Escape. The page returns focus to the opener. */
export function useDrawerFocus<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    ref.current?.focus()
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      event.preventDefault()
      closeRef.current()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  return ref
}
