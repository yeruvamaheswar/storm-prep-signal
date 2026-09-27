import { useState } from "react"
import { apiBaseUrl } from "../../api/health"
import { compareWithArchive, type VerifyResult } from "./flowMath"
import type { SessionState } from "./types"

/** Re-reads Supabase through GET /v1/scenario/verify at this tick's clock and compares it with the tape. */
export function VerifyArchive({ state }: { state: SessionState }) {
  const [result, setResult] = useState<VerifyResult | null>(null)
  const [busy, setBusy] = useState(false)
  const event = state.scenario?.event
  const provenance = state.provenance
  if (!event || !provenance) return null

  async function check() {
    if (!event || !provenance) return
    setBusy(true)
    try {
      const url = `${apiBaseUrl()}/v1/scenario/verify?event=${encodeURIComponent(event)}&clock=${encodeURIComponent(provenance.ts)}`
      const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000) })
      setResult(compareWithArchive(provenance, await res.json()))
    } catch (err) {
      setResult({ ok: false, lines: [`Verify unreachable: ${err instanceof Error ? err.message : "error"}`] })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flow-verify">
      <button type="button" onClick={() => void check()} disabled={busy}>
        {busy ? "Checking Supabase" : `Check tick ${provenance.tick} against Supabase`}
      </button>
      {result ? (
        <ul className={result.ok ? "flow-verify-ok" : "flow-verify-bad"}>
          {result.lines.map((line) => <li key={line}>{line}</li>)}
        </ul>
      ) : null}
    </div>
  )
}
