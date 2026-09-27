import { CHARGE_STROKE, WORLD, type OrderPathView } from "./zoneModel"

type Props = { paths: OrderPathView[] }

/** Order paths from the substation to each lot. Dash flow is CSS only (zone.css) and stops under reduced motion. */
export function OrderPaths({ paths }: Props) {
  return (
    <svg className="zone-layer" width={WORLD.w} height={WORLD.h} viewBox={`${WORLD.x} ${WORLD.y} ${WORLD.w} ${WORLD.h}`} aria-hidden="true">
      {paths.map((path) => (
        <path key={`${path.homeId}-${path.key}`} className={`zp ${path.cls}`} d={path.d} data-home={path.homeId} data-key={path.key}
          style={path.cls.includes("p-charge") ? { stroke: CHARGE_STROKE } : undefined} />
      ))}
      {paths.map((path) => path.marker ? (
        <circle key={`m-${path.homeId}-${path.key}`} className="zone-loss" cx={path.marker[0]} cy={path.marker[1]} r="7" />
      ) : null)}
    </svg>
  )
}
