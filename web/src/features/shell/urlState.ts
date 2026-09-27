export type ShellUrlState = {
  scenario: string | null
  zone: string | null
  home: string | null
  tick: number | null
}

type UrlStateTarget = {
  history: Pick<History, "pushState" | "replaceState">
  location: Pick<Location, "pathname" | "search">
}

const params = ["scenario", "zone", "home", "tick"] as const

export function readUrlState(search = window.location.search): ShellUrlState {
  const query = new URLSearchParams(search)
  const tickRaw = query.get("tick")
  const tick = tickRaw === null || tickRaw.trim() === "" ? null : Number(tickRaw)
  return {
    scenario: query.get("scenario"),
    zone: query.get("zone"),
    home: query.get("home"),
    tick: Number.isFinite(tick) ? tick : null,
  }
}

export function hrefForUrlState(pathname: string, state: ShellUrlState): string {
  const query = new URLSearchParams()
  for (const key of params) {
    const value = state[key]
    if (value !== null && value !== "") {
      query.set(key, String(value))
    }
  }
  const search = query.toString()
  return search === "" ? pathname : `${pathname}?${search}`
}

export function writeUrlState(
  next: ShellUrlState,
  options: { target?: UrlStateTarget; push?: boolean } = {},
): string {
  const target = options.target ?? window
  const href = hrefForUrlState(target.location.pathname, next)
  if (options.push === true) {
    target.history.pushState(next, "", href)
  } else {
    target.history.replaceState(next, "", href)
  }
  return href
}

export function zoomToZone(zone: string, target?: UrlStateTarget): string {
  const base = readUrlState(target?.location.search)
  if (base.zone === zone && base.home === null) {
    return hrefForUrlState(target?.location.pathname ?? window.location.pathname, base)
  }
  return writeUrlState({ ...base, zone, home: null }, { target, push: true })
}

export function zoomToHome(home: string, target?: UrlStateTarget): string {
  const base = readUrlState(target?.location.search)
  if (base.home === home) {
    return hrefForUrlState(target?.location.pathname ?? window.location.pathname, base)
  }
  return writeUrlState({ ...base, home }, { target, push: true })
}

export function subscribeUrlState(onChange: (state: ShellUrlState) => void, target = window): () => void {
  const handler = () => onChange(readUrlState(target.location.search))
  target.addEventListener("popstate", handler)
  return () => target.removeEventListener("popstate", handler)
}
