type DotTone = "ok" | "stale" | "dead"

type StatusDotProps = {
  tone: DotTone
}

export function StatusDot({ tone }: StatusDotProps) {
  return <span className={`status-dot tone-${tone}`} />
}
