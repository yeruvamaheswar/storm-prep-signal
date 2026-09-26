import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin, type ViteDevServer } from "vite"

const geoFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../geo/ercot-load-zones.json")

function serveZones(server: ViteDevServer) {
  server.middlewares.use((req, res, next) => {
    const url = req.url?.split("?")[0]
    if (url !== "/geo/ercot-load-zones.json" || !fs.existsSync(geoFile)) {
      next()
      return
    }
    res.setHeader("Content-Type", "application/json")
    fs.createReadStream(geoFile).pipe(res)
  })
}

/** Serves repo-root geo/ercot-load-zones.json when that file exists. */
function ercotZones(): Plugin {
  return {
    name: "ercot-load-zones",
    configureServer: serveZones,
    configurePreviewServer: serveZones,
    generateBundle() {
      if (!fs.existsSync(geoFile)) {
        return
      }
      this.emitFile({
        type: "asset",
        fileName: "geo/ercot-load-zones.json",
        source: fs.readFileSync(geoFile),
      })
    },
  }
}

// Extra HTML files dropped at this root (wall.html, fleet.html, history.html) are served
// at their own URL. Do not list them: the dev server already returns a root HTML file
// when it exists, and leaves every other path for index.html.
// Same-origin calls to the local FastAPI server, so dev needs no CORS setup.
const apiTarget = process.env.API_PROXY_TARGET ?? "http://localhost:8000"
const apiProxy = { "/health": apiTarget, "/v1": apiTarget }

export default defineConfig({
  plugins: [react(), ercotZones()],
  server: { port: 5173, proxy: apiProxy },
  preview: { proxy: apiProxy },
})
