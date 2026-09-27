import type { SessionState } from "../flow/types"

type Props = { log: SessionState["log"] }

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** A worker UTC stamp ("2026-09-27T05:25:48+00:00") as "Sep 27 05:25:48 UTC". Read from the string, so no
 * timezone shift; anything else shows as sent. */
export function utcClock(at: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|\+00:00)$/.exec(at)
  if (!match) return at
  return `${MONTHS[Number(match[1]) - 1]} ${Number(match[2])} ${match[3]} UTC`
}

/** The worker's own log, newest first: every request it applied or refused, and why.
 * The worker keeps only its last 12 lines (scenario.py LOG_LINES) and stamps them with its wall clock. */
export function SessionLog({ log }: Props) {
  if (!log.length) return <p className="replay-note">Nothing logged yet.</p>
  return (
    <>
      <p className="replay-note">The worker keeps its last 12 lines. Times are its wall clock in UTC, not scenario time.</p>
      <ol className="replay-log" aria-label="Session log, newest first">
        {log.slice().reverse().map((line, index) => (
          <li key={`${line.at}-${index}`}>
            <time dateTime={line.at}>{utcClock(line.at)}</time>
            <span>{line.text}</span>
          </li>
        ))}
      </ol>
    </>
  )
}
