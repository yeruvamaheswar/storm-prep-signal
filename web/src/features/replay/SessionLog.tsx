import type { SessionState } from "../flow/types"

type Props = { log: SessionState["log"] }

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** The worker stamps each line in UTC ("2026-09-27T05:25:48+00:00"). Read from the string, so no timezone shift. */
function logClock(at: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|\+00:00)$/.exec(at)
  if (!match) return at
  return `${MONTHS[Number(match[1]) - 1]} ${Number(match[2])} ${match[3]} UTC`
}

/** The worker's own log, newest first: every request it applied or refused, and why. */
export function SessionLog({ log }: Props) {
  if (!log.length) return <p className="replay-note">Nothing logged yet.</p>
  return (
    <ol className="replay-log" aria-label="Session log, newest first">
      {log.slice().reverse().map((line, index) => (
        <li key={`${line.at}-${index}`}>
          <time dateTime={line.at}>{logClock(line.at)}</time>
          <span>{line.text}</span>
        </li>
      ))}
    </ol>
  )
}
