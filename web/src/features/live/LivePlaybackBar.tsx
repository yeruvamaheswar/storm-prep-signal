type Props = {
  /** "Last tick ran at HH:MM CT. Next tick in m:ss." or its honest fallback (liveModel.tickTiming). */
  timing: string
  note: string
  canReplay: boolean
  onReplay: () => void
}

/** Live's own bar (Replay's PlaybackBar drives a scenario worker). One action: replay the newest tick's orders. */
export function LivePlaybackBar({ timing, note, canReplay, onReplay }: Props) {
  return (
    <section className="replay-panel live-playback" aria-label="Playback">
      <div className="live-playback-text">
        <span className="live-playback-timing">{timing}</span>
        <span className="live-playback-note">{note}</span>
      </div>
      <button type="button" className="replay-pill live-replay" disabled={!canReplay} onClick={onReplay}>Replay this tick</button>
    </section>
  )
}
