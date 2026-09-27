/** Pathnames the one Vite app owns. No router package. */

function owns(pathname: string, page: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/"
  return path === `/${page}` || path.startsWith(`/${page}/`) || path === `/${page}.html`
}

export function isFleetPath(pathname: string): boolean {
  return owns(pathname, "fleet")
}

export function isFlowPath(pathname: string): boolean {
  return owns(pathname, "flow")
}
