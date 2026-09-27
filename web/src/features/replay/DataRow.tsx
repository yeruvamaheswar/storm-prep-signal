import type { ReactNode } from "react"

/** One label and value in an About-this-data list. `sub` indents it under the row above (a county under its zone). */
export function DataRow({ k, v, sub = false }: { k: string; v: ReactNode; sub?: boolean }) {
  return (
    <div className={sub ? "replay-data-row is-sub" : "replay-data-row"}>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  )
}
