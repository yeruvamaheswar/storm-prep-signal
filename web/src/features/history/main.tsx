import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import "@fontsource/ibm-plex-sans/400.css"
import "@fontsource/ibm-plex-sans/500.css"
import "@fontsource/ibm-plex-sans/600.css"
import "../../design/tokens.css"
import { LogPage } from "./LogPage"
import { PlaybackPage } from "./PlaybackPage"
import {
  playbackOff,
  playbackRunning,
  previewTicks,
  previewTapes,
} from "./preview-data"
import type { Playback } from "./types"

function HistoryPreview() {
  const [playback, setPlayback] = useState<Playback | null>(playbackOff)
  const [selectedTickId, setSelectedTickId] = useState<string | null>(null)
  const showingRunning = playback !== null

  return (
    <>
      <div className="history-preview-bar">
        <p className="history-key">Preview only</p>
        <button
          type="button"
          className="history-button"
          onClick={() => setPlayback(showingRunning ? playbackOff : playbackRunning)}
        >
          {showingRunning ? "Show playback off" : "Show playback running"}
        </button>
      </div>
      <PlaybackPage
        tapes={previewTapes}
        playback={playback}
        onStart={(tapeId) =>
          setPlayback({
            tape_id: tapeId,
            tick_index: playbackRunning.tick_index,
            tick_count: playbackRunning.tick_count,
          })
        }
        onStop={() => setPlayback(playbackOff)}
      />
      <LogPage
        ticks={previewTicks}
        selectedTickId={selectedTickId}
        onSelect={setSelectedTickId}
      />
    </>
  )
}

const root = document.getElementById("root")
if (root === null) {
  throw new Error("missing root")
}

createRoot(root).render(
  <StrictMode>
    <HistoryPreview />
  </StrictMode>,
)
