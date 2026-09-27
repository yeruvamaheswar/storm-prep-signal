/** Pathnames the one Vite app owns. No router package. */

function owns(pathname: string, page: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/"
  return path === `/${page}` || path.startsWith(`/${page}/`) || path === `/${page}.html`
}

export function isFleetPath(pathname: string): boolean {
  return owns(pathname, "fleet") && !isFleetTablePath(pathname)
}

export function isFleetTablePath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/"
  return path === "/fleet/table" || path === "/fleet/table.html"
}

export function isFlowPath(pathname: string): boolean {
  return owns(pathname, "flow")
}

export function isLivePath(pathname: string): boolean {
  return owns(pathname, "live")
}

export function isReplayPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/"
  return path === "/" || path === "/index.html" || owns(pathname, "replay")
}

export function isWallPath(pathname: string): boolean {
  return owns(pathname, "wall")
}
