/** Pathnames the one Vite app owns. No router package. */

export function isFleetPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/"
  return path === "/fleet" || path.startsWith("/fleet/") || path === "/fleet.html"
}
