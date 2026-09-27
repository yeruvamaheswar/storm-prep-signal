import type { ReactNode } from "react"

/** One label and value in an About-this-data list. */
export function DataRow({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="replay-data-row">
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  )
}
