import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import "@fontsource/ibm-plex-sans/400.css"
import "@fontsource/ibm-plex-sans/500.css"
import "@fontsource/ibm-plex-sans/600.css"
import "../../design/tokens.css"
import "./wall.css"
import { previewIds, previewStates, type PreviewId } from "./preview-data"
import { WallPage } from "./WallPage"

const root = document.getElementById("root")
if (root === null) {
  throw new Error("missing root")
}

function PreviewApp() {
  const [current, setCurrent] = useState<PreviewId>("surplus")
  const [lastCall, setLastCall] = useState("none")
  const state = previewStates[current]

  return (
    <>
      <div className="wall-preview" role="group" aria-label="Preview states">
        <span className="wall-key">Preview</span>
        {previewIds.map((id) => (
          <button
            key={id}
            type="button"
            className={id === current ? "wall-button wall-button-pressed" : "wall-button"}
            aria-pressed={id === current}
            onClick={() => setCurrent(id)}
          >
            {previewStates[id].label}
          </button>
        ))}
        <p className="wall-preview-call">Last call: {lastCall}</p>
      </div>
      <WallPage
        key={state.tick.tick_id}
        zone={state.zone}
        tick={state.tick}
        recentTicks={state.recentTicks}
        homes={state.homes}
        onMode={(mode) => setLastCall(`onMode(${mode})`)}
        onAttention={(choice) => setLastCall(`onAttention(${choice})`)}
        onOpenHome={(homeId) => setLastCall(`onOpenHome(${homeId})`)}
      />
    </>
  )
}

createRoot(root).render(
  <StrictMode>
    <PreviewApp />
  </StrictMode>,
)
