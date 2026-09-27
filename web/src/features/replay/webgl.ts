/** True when `make()` gives a canvas that can open a WebGL2 or WebGL context. Never throws. */
export function probeWebGL(make: () => HTMLCanvasElement): boolean {
  try {
    const canvas = make()
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"))
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
