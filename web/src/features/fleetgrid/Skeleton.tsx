import { GRID_ZONES } from "./fleetModel"

/** Placeholder banks while the first load for a source is in flight. Never says "No homes". */
export function Skeleton() {
  return (
    <div className="fg-banks" aria-busy="true" aria-label="Loading homes">
      {GRID_ZONES.map((zone) => (
        <section key={zone} className="fg-bank is-skeleton" aria-hidden="true">
          <div className="fg-bank-head"><h2>{zone}</h2><span className="fg-skel-line" /></div>
          <div className="fg-dist">
            {Array.from({ length: 25 }, (_, k) => <span key={k} className="fg-skel-cell" />)}
          </div>
        </section>
      ))}
    </div>
  )
}
