import { Canvas } from "@react-three/fiber"
import { useEffect, useMemo, useState } from "react"
import { cableLook, resolveColor, type CableMode, type HouseModel } from "./house3dModel"
import { HouseScene, TO_CAMERA } from "./HouseScene"
import "./house3d.css"

type Props = { model: HouseModel }

const MODES: CableMode[] = ["selling", "confirmed", "charging", "off"]
/** Every token lotLook.batt can name (see house3dModel.fillLook). */
const BATT_TOKENS = ["--rg-batt-idle", "--rg-battery-glow", "--rg-charging"]
/** No literal for the fill in the brief; a neutral clay tone if the battery token cannot be read. */
const FILL_NEUTRAL = "#B9BFBA"

function reducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/** The 3D house for the Replay home panel. Loaded only through React.lazy so three.js stays in its own chunk. */
export default function House3D({ model }: Props) {
  const [still, setStill] = useState(reducedMotion)
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    const onChange = () => setStill(query.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])

  // three.js cannot read CSS variables, so read the state tokens once.
  const colors = useMemo(() => {
    const style = getComputedStyle(document.documentElement)
    const read = (name: string) => style.getPropertyValue(name)
    const cable = Object.fromEntries(MODES.map((mode) => [mode, resolveColor(cableLook(mode), read)])) as Record<CableMode, string | null>
    const batt = Object.fromEntries(BATT_TOKENS.map((token) => [token, read(token).trim()])) as Record<string, string>
    return { cable, batt }
  }, [])

  const cableColor = colors.cable[model.cable]
  const fillColor = colors.batt[model.fillLook.token] || FILL_NEUTRAL
  const animate = cableColor !== null && !still
  const len = Math.hypot(...TO_CAMERA)

  return (
    <div className="house3d" role="img" aria-label={model.label}>
      <Canvas
        orthographic
        shadows="percentage"
        flat
        dpr={[1, 2]}
        frameloop={animate ? "always" : "demand"}
        camera={{ position: [(TO_CAMERA[0] / len) * 20, (TO_CAMERA[1] / len) * 20, (TO_CAMERA[2] / len) * 20], zoom: 30, near: 0.1, far: 100 }}
        gl={{ antialias: true, alpha: true }}
        aria-hidden="true"
      >
        <HouseScene model={model} cableColor={cableColor} fillColor={fillColor} animate={animate} />
      </Canvas>
      {model.fillLabel ? <p className="house3d-note">Battery charge: {model.fillLabel}</p> : null}
    </div>
  )
}
