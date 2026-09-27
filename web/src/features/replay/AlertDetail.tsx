import type { ActiveAlert } from "../flow/types"
import { fmtScenarioTime } from "../flow/flowMath"
import { DataRow } from "./DataRow"
import { NOT_REPORTED } from "./format"

function orMissing(text: string | undefined | null): string {
  return text && text.trim() ? text : NOT_REPORTED
}

function time(ts: string | undefined): string {
  return ts ? fmtScenarioTime(ts) : NOT_REPORTED
}

/** A sent archived NWS alert, and the JEV shadow reading recorded for it. JEV never dispatches. */
export function AlertDetail({ alert }: { alert: ActiveAlert }) {
  const jev = alert.jev
  return (
    <div className="replay-alert">
      <b>{alert.event ?? alert.id}</b>
      <p>{alert.headline ?? "No headline reported"}</p>
      <dl>
        <DataRow k="Area" v={orMissing(alert.areaDesc)} />
        <DataRow k="Counties (FIPS)" v={orMissing((alert.counties ?? []).join(", "))} />
        <DataRow k="Mapped to zone" v={orMissing(alert.zones.join(", "))} />
        <DataRow k="Onset" v={time(alert.onset)} />
        <DataRow k="Expires" v={time(alert.expires)} />
        {/* The worker records no tick when the alert arrives after the tape's last frame. */}
        <DataRow k="Sent at tick" v={alert.sent_at_tick ?? "After the last tick"} />
        <DataRow k="Source" v={alert.source_url
          ? <a href={alert.source_url} target="_blank" rel="noreferrer">{alert.source_label ?? "Archived NWS alert"}</a>
          : NOT_REPORTED} />
      </dl>
      <div className="replay-jev">
        <p className="replay-jev-title">JEV shadow reading</p>
        {jev ? (
          <dl>
            <DataRow k="Question" v={jev.question} />
            <DataRow k="P(threat)" v={`${jev.probability.toFixed(2)} (${jev.answer})`} />
            <DataRow k="Model" v={`${jev.model} · ${jev.latency_ms} ms`} />
            <DataRow k="Called" v={jev.called_at} />
            <DataRow k="Input" v={jev.input_label} />
          </dl>
        ) : <p className="replay-note">No recorded JEV reading for this alert.</p>}
        <p className="replay-note">Rules decide the floor. JEV never dispatches; its reading is shown next to the rule.</p>
      </div>
    </div>
  )
}
