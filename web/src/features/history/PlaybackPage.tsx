import type { PlaybackPageProps } from "./types"
import "./history.css"

export function PlaybackPage({ tapes, playback, onStart, onStop }: PlaybackPageProps) {
  const running = playback !== null

  return (
    <section className="history-page" aria-labelledby="history-playback-title">
      <header className="history-mast">
        <h1 id="history-playback-title">Playback</h1>
        {running ? (
          <p className="history-status">
            <span className="history-mark">PLAYBACK</span>
            <span className="history-tape-id">{playback.tape_id}</span>
            <span className="history-meta">
              <span className="history-key">Position</span>
              <span className="history-num">
                {playback.tick_index} of {playback.tick_count}
              </span>
            </span>
          </p>
        ) : (
          <p className="history-status">
            <span className="history-mark">LIVE</span>
          </p>
        )}
      </header>
      <p className="history-copy">
        Live data is not a tape. Stopping does not promise the fleet is selling. If the live
        feeds are bad, the server enters reserve on its own.
      </p>
      <ul className="history-tapes">
        {tapes.map((tape) => (
          <li key={tape.tape_id} className="history-tape">
            <div className="history-tape-main">
              <h2 className="history-tape-title">{tape.title}</h2>
              <p className="history-line">
                <span className="history-key">Ticks</span>
                <span className="history-num">{tape.ticks}</span>
              </p>
              <p className="history-line">
                <span className="history-key">Labeled</span>
                <span>{tape.labeled}</span>
              </p>
            </div>
            <button
              type="button"
              className="history-button"
              disabled={running}
              aria-label={`Start ${tape.title}`}
              onClick={() => onStart(tape.tape_id)}
            >
              Start
            </button>
          </li>
        ))}
      </ul>
      {running ? (
        <button type="button" className="history-button" onClick={onStop}>
          Stop
        </button>
      ) : null}
    </section>
  )
}
