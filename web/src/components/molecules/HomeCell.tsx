import type { HomeState } from "../organisms/fleetCells"

type HomeCellProps = {
  state: HomeState
  /** Legend swatches repeat the word next to them, so the mark itself stays quiet. */
  decorative?: boolean
}

export function HomeCell({ state, decorative = false }: HomeCellProps) {
  return (
    <span
      className={`home-cell tone-${state}`}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : state}
      aria-hidden={decorative ? true : undefined}
    >
      <span className="home-fill" />
      <span className="home-mark" />
    </span>
  )
}
