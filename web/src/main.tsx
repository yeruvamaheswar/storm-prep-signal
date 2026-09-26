import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "@fontsource/ibm-plex-sans/400.css"
import "@fontsource/ibm-plex-sans/500.css"
import "@fontsource/ibm-plex-sans/600.css"
import "./design/tokens.css"
import "./index.css"
import { App } from "./pages/App"

const root = document.getElementById("root")
if (root === null) {
  throw new Error("missing root")
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
