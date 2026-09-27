/** Phone portrait band shared with CSS `@media (max-width: 720px)`. */

export const PHONE_MQ = "(max-width: 720px)"

/** Desktop UI clock (playhead / "N min ago"). Phone uses a slower beat to cut re-renders. */
export const CLOCK_MS_DESKTOP = 250
export const CLOCK_MS_PHONE = 1000

/** Scenario state poll. Phone can lag a beat; local playhead still uses the clock. */
export const SCENARIO_POLL_MS_DESKTOP = 500
export const SCENARIO_POLL_MS_PHONE = 1000

export function isPhonePortrait(
  matchMediaFn?: (query: string) => { matches: boolean },
): boolean {
  const matchMedia = matchMediaFn
    ?? (typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? (query: string) => window.matchMedia(query)
      : undefined)
  return typeof matchMedia === "function" && matchMedia(PHONE_MQ).matches
}

export function clockMs(phone = isPhonePortrait()): number {
  return phone ? CLOCK_MS_PHONE : CLOCK_MS_DESKTOP
}

export function scenarioPollMs(phone = isPhonePortrait()): number {
  return phone ? SCENARIO_POLL_MS_PHONE : SCENARIO_POLL_MS_DESKTOP
}
