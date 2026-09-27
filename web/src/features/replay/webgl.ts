type ProbeContext = { getExtension?: (name: string) => { loseContext?: () => void } | null } | null

/** True when `make()` gives a canvas that can open a WebGL2 or WebGL context. Never throws. The probe's context is
 * released at once (WEBGL_lose_context), so it does not count against the browser's live-context limit. */
export function probeWebGL(make: () => HTMLCanvasElement): boolean {
  try {
    const canvas = make()
    const gl = (canvas.getContext("webgl2") || canvas.getContext("webgl")) as ProbeContext
    if (!gl) return false
    try {
      gl.getExtension?.("WEBGL_lose_context")?.loseContext?.()
    } catch {
      // Releasing is best effort; the probe already answered.
    }
    return true
  } catch {
    return false
  }
}

let cached: boolean | null = null

/** Whether this browser can draw the 3D house. Probed once per page: every probe opens a real GL context. */
export function hasWebGL(): boolean {
  if (cached !== null) return cached
  // No WebGL constructor (server render, jsdom) means no WebGL; skip the probe so jsdom logs nothing.
  if (typeof window === "undefined" || typeof document === "undefined" || !("WebGLRenderingContext" in window)) return false
  cached = probeWebGL(() => document.createElement("canvas"))
  return cached
}
