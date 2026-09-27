import { useFrame, useThree } from "@react-three/fiber"
import { useLayoutEffect, useMemo, useRef } from "react"
import { cableSegments, fitView, type HouseModel, type Vec3 } from "./house3dModel"

/** Clay scene colours: the flat HouseArt's values, as named constants. State colours come in as props. */
const CLAY = {
  wallFront: "#F7F6F2",
  roof: "#848A86",
  seam: "#9AA09C",
  lawn: "#3F7A5F",
  stone: "#B3B7AF",
  sidewalk: "#D9DBD5",
  door: "#2B302D",
  window: "#EFB866",
  lamp: "#FFD9A0",
  battery: "#E6E8E3",
  gauge: "#3A413D",
  floorLine: "#17201C",
  pole: "#5E645F",
  cableOff: "#4A504C",
} as const

/** Where the camera sits, as a direction from the scene. A classic isometric angle. */
export const TO_CAMERA: Vec3 = [1, 0.82, 1]

// Layout in world units. y is up; the lawn top is y = 0.
const HOUSE = { x: 0, z: -0.4, w: 2.8, d: 2.2, h: 1.7 }
const ROOF = { rise: 0.95, overhang: 0.22, thick: 0.09 }
const GABLE_R = HOUSE.d / Math.sqrt(3)
// Battery on the house's right side and the pole behind it, so the cable clears the roof and the pole top
// stays clear of the status chip in the top-left corner.
const BATTERY = { x: 2.05, z: 0.95, w: 0.62, h: 1.0, d: 0.46 }
const GAUGE = { w: 0.4, h: 0.74 }
const POLE = { x: 2.75, z: -1.9, h: 3.7 }
const POLE_TOP: Vec3 = [POLE.x, POLE.h - 0.35, POLE.z]
const BATTERY_TOP: Vec3 = [BATTERY.x, BATTERY.h + 0.02, BATTERY.z]
const CABLE_PIECES = 18
const CABLE_RADIUS = 0.035

/** The extent the camera fits: the board corners, the roof ridge and the pole top. */
const FIT_POINTS: Vec3[] = [
  [-3.4, -0.6, -3.4], [3.4, -0.6, -3.4], [3.4, -0.6, 3.4], [-3.4, -0.6, 3.4],
  [-1.6, HOUSE.h + ROOF.rise, HOUSE.z], [1.6, HOUSE.h + ROOF.rise, HOUSE.z], [POLE.x, POLE.h, POLE.z],
]

type Props = {
  model: HouseModel
  /** Cable glow colour, or null for an unlit cable (off, or its token was unreadable). */
  cableColor: string | null
  fillColor: string
  /** False under prefers-reduced-motion: the cable stays lit but steady. */
  animate: boolean
}

/** The 3D house, battery, pole and cable. Pure meshes from `model`; the cable pulse is the only motion. */
export function HouseScene({ model, cableColor, fillColor, animate }: Props) {
  const { camera, size, invalidate } = useThree()
  // `three` has no type declarations in this repo (no @types/three), so its objects are untyped here.
  const materials = useRef<any[]>([])
  const segments = useMemo(() => cableSegments(POLE_TOP, BATTERY_TOP, 0.55, CABLE_PIECES), [])
  const lit = cableColor !== null
  // Selling and confirmed energy runs battery to pole; a charge runs pole to battery.
  const direction = model.cable === "charging" ? -1 : 1

  useLayoutEffect(() => {
    if (!size.width || !size.height) return
    const { target, zoom } = fitView(FIT_POINTS, TO_CAMERA, size.width, size.height)
    const len = Math.hypot(...TO_CAMERA)
    camera.position.set(target[0] + (TO_CAMERA[0] / len) * 20, target[1] + (TO_CAMERA[1] / len) * 20, target[2] + (TO_CAMERA[2] / len) * 20)
    camera.zoom = zoom
    camera.lookAt(target[0], target[1], target[2])
    camera.updateProjectionMatrix()
    invalidate()
  }, [camera, size.width, size.height, invalidate])

  useFrame(({ clock }) => {
    if (!lit) return
    const t = clock.getElapsedTime()
    materials.current.forEach((material, i) => {
      if (!material) return
      // A soft band that travels along the cable; steady when motion is reduced.
      const wave = animate ? Math.max(0, Math.sin(t * 3.2 + direction * (i - CABLE_PIECES) * 0.55)) : 0.5
      material.emissiveIntensity = 0.45 + 0.9 * wave * wave
    })
  })

  const wallTop = HOUSE.h
  const slope = Math.atan2(ROOF.rise, HOUSE.d / 2)
  const slopeLen = Math.hypot(ROOF.rise, HOUSE.d / 2) + ROOF.overhang
  const roofW = HOUSE.w + ROOF.overhang * 2
  const gaugeBottom = (BATTERY.h - GAUGE.h) / 2
  const face = BATTERY.z + BATTERY.d / 2 + 0.004
  const seams = [-0.42, -0.21, 0, 0.21, 0.42].map((k) => k * roofW)

  return (
    <>
      <ambientLight intensity={1.35} />
      {/* Soft key light from the top-left of the frame. */}
      <directionalLight position={[-4, 9, 6]} intensity={1.9} castShadow shadow-mapSize={[1024, 1024]} shadow-radius={6}
        shadow-camera-left={-6} shadow-camera-right={6} shadow-camera-top={6} shadow-camera-bottom={-6} />
      <hemisphereLight args={["#ffffff", "#9aa39b", 0.5]} />

      {/* Stone base, lawn slab, sidewalk and front path. */}
      <mesh position={[0, -0.42, 0]} receiveShadow>
        <boxGeometry args={[6.9, 0.36, 6.9]} />
        <meshStandardMaterial color={CLAY.stone} roughness={1} />
      </mesh>
      <mesh position={[0, -0.12, 0]} receiveShadow>
        <boxGeometry args={[6.5, 0.24, 6.5]} />
        <meshStandardMaterial color={CLAY.lawn} roughness={1} />
      </mesh>
      <mesh position={[0, 0.015, 2.85]} receiveShadow>
        <boxGeometry args={[6.5, 0.03, 0.7]} />
        <meshStandardMaterial color={CLAY.sidewalk} roughness={1} />
      </mesh>
      <mesh position={[0.1, 0.012, 1.6]} receiveShadow>
        <boxGeometry args={[0.55, 0.024, 1.8]} />
        <meshStandardMaterial color={CLAY.sidewalk} roughness={1} />
      </mesh>

      {/* House walls, gable ends and standing-seam roof. */}
      <group position={[HOUSE.x, 0, HOUSE.z]}>
        <mesh position={[0, wallTop / 2, 0]} castShadow receiveShadow>
          <boxGeometry args={[HOUSE.w, wallTop, HOUSE.d]} />
          <meshStandardMaterial color={CLAY.wallFront} roughness={0.95} />
        </mesh>
        {/* Gable: a three-sided prism along x, apex up, squashed to the roof rise. */}
        {/* Cylinder radius r = d / sqrt(3) gives a base as wide as the house; its apex sits r above the centre
            and its base r / 2 below, so scaling the apex axis by rise / 1.5r gives the roof rise. */}
        <group position={[0, wallTop + ROOF.rise / 3, 0]} rotation={[0, 0, Math.PI / 2]}>
          <mesh rotation={[0, Math.PI / 2, 0]} scale={[1, 1, ROOF.rise / (1.5 * GABLE_R)]} castShadow>
            <cylinderGeometry args={[GABLE_R, GABLE_R, HOUSE.w, 3]} />
            <meshStandardMaterial color={CLAY.wallFront} roughness={0.95} flatShading />
          </mesh>
        </group>
        <mesh position={[0, wallTop + ROOF.rise + ROOF.thick * 0.8, 0]} castShadow>
          <boxGeometry args={[roofW, ROOF.thick, 0.16]} />
          <meshStandardMaterial color={CLAY.seam} roughness={0.6} metalness={0.2} />
        </mesh>
        {[1, -1].map((side) => (
          <group
            key={side}
            position={[
              0,
              wallTop + ROOF.rise / 2 - (ROOF.overhang / 2) * Math.sin(slope) + (ROOF.thick / 2) * Math.cos(slope),
              side * (HOUSE.d / 4 + (ROOF.overhang / 2) * Math.cos(slope) + (ROOF.thick / 2) * Math.sin(slope)),
            ]}
            rotation={[side * slope, 0, 0]}
          >
            <mesh castShadow receiveShadow position={[0, 0, 0]}>
              <boxGeometry args={[roofW, ROOF.thick, slopeLen]} />
              <meshStandardMaterial color={CLAY.roof} roughness={0.7} metalness={0.15} />
            </mesh>
            {seams.map((x) => (
              <mesh key={x} position={[x, ROOF.thick / 2 + 0.02, 0]} castShadow>
                <boxGeometry args={[0.035, 0.04, slopeLen]} />
                <meshStandardMaterial color={CLAY.seam} roughness={0.6} metalness={0.2} />
              </mesh>
            ))}
          </group>
        ))}
        {/* Door and wall lamp on the front (+z) wall, two warm windows. */}
        <mesh position={[0.1, 0.5, HOUSE.d / 2 + 0.02]}>
          <boxGeometry args={[0.5, 1.0, 0.04]} />
          <meshStandardMaterial color={CLAY.door} roughness={0.8} />
        </mesh>
        <mesh position={[0.52, 0.95, HOUSE.d / 2 + 0.05]}>
          <boxGeometry args={[0.1, 0.16, 0.08]} />
          <meshStandardMaterial color={CLAY.lamp} emissive={CLAY.lamp} emissiveIntensity={0.9} />
        </mesh>
        <mesh position={[-0.8, 0.95, HOUSE.d / 2 + 0.02]}>
          <boxGeometry args={[0.62, 0.52, 0.04]} />
          <meshStandardMaterial color={CLAY.window} emissive={CLAY.window} emissiveIntensity={0.55} />
        </mesh>
        <mesh position={[HOUSE.w / 2 + 0.02, 0.95, -0.2]}>
          <boxGeometry args={[0.04, 0.52, 0.72]} />
          <meshStandardMaterial color={CLAY.window} emissive={CLAY.window} emissiveIntensity={0.55} />
        </mesh>
      </group>

      {/* Battery with its gauge: fill from soc_pct, a line at floor_pct. */}
      <mesh position={[BATTERY.x, BATTERY.h / 2, BATTERY.z]} castShadow receiveShadow>
        <boxGeometry args={[BATTERY.w, BATTERY.h, BATTERY.d]} />
        <meshStandardMaterial color={CLAY.battery} roughness={0.85} />
      </mesh>
      <mesh position={[BATTERY.x, BATTERY.h / 2, face]}>
        <planeGeometry args={[GAUGE.w, GAUGE.h]} />
        <meshStandardMaterial color={CLAY.gauge} roughness={0.9} />
      </mesh>
      {model.fill !== null && model.fill > 0 ? (
        <mesh position={[BATTERY.x, gaugeBottom + (GAUGE.h * model.fill) / 2, face + 0.003]}>
          <planeGeometry args={[GAUGE.w - 0.06, Math.max(0.005, GAUGE.h * model.fill - 0.02)]} />
          {/* Lit only when the battery ran this tick; an idle battery shows its level in the idle colour. */}
          <meshStandardMaterial color={fillColor} emissive={model.fillLook.glow ? fillColor : "#000000"} emissiveIntensity={model.fillLook.glow ? 0.35 : 0} roughness={0.6} />
        </mesh>
      ) : null}
      {model.floor !== null ? (
        <mesh position={[BATTERY.x, gaugeBottom + GAUGE.h * model.floor, face + 0.006]}>
          <boxGeometry args={[GAUGE.w + 0.06, 0.028, 0.006]} />
          <meshStandardMaterial color={CLAY.floorLine} roughness={0.8} />
        </mesh>
      ) : null}

      {/* Pole, crossarm and the line wires leaving the lot. */}
      <mesh position={[POLE.x, POLE.h / 2, POLE.z]} castShadow>
        <cylinderGeometry args={[0.06, 0.075, POLE.h, 8]} />
        <meshStandardMaterial color={CLAY.pole} roughness={0.9} />
      </mesh>
      <mesh position={[POLE.x, POLE.h - 0.2, POLE.z]} castShadow>
        <boxGeometry args={[0.08, 0.08, 0.9]} />
        <meshStandardMaterial color={CLAY.pole} roughness={0.9} />
      </mesh>
      {[-0.38, 0.38].flatMap((dz) =>
        cableSegments([POLE.x, POLE.h - 0.16, POLE.z + dz], [POLE.x + 0.55, POLE.h - 0.05, -3.4 + dz * 0.3], 0.08, 4).map((seg, i) => (
          <mesh key={`${dz}-${i}`} position={seg.position} rotation={[...seg.rotation, "YZX"]} scale={[1, seg.length, 1]}>
            <cylinderGeometry args={[0.014, 0.014, 1, 5]} />
            <meshStandardMaterial color={CLAY.pole} roughness={0.9} />
          </mesh>
        )),
      )}

      {/* The service cable from pole to battery: lit by the order state, dark otherwise. */}
      {segments.map((seg, i) => (
        <mesh key={i} position={seg.position} rotation={[...seg.rotation, "YZX"]} scale={[1, seg.length + 0.01, 1]} castShadow>
          <cylinderGeometry args={[CABLE_RADIUS, CABLE_RADIUS, 1, 6]} />
          <meshStandardMaterial
            ref={(m: unknown) => { materials.current[i] = m }}
            color={cableColor ?? CLAY.cableOff}
            emissive={cableColor ?? "#000000"}
            emissiveIntensity={lit ? 0.9 : 0}
            roughness={0.5}
            toneMapped={false}
          />
        </mesh>
      ))}
    </>
  )
}
