type Tone = "ink" | "ok" | "reserved" | "dead"

type MetricProps = {
  value: string
  unit: string
  caption?: string
  tone?: Tone
}

export function Metric({ value, unit, caption, tone = "ink" }: MetricProps) {
  return (
    <div className="metric">
      <div className={`metric-value tone-${tone}`}>
        {value}
        {unit === "" ? null : <span className="metric-unit">{unit}</span>}
      </div>
      {caption ? <div className="metric-caption">{caption}</div> : null}
    </div>
  )
}
