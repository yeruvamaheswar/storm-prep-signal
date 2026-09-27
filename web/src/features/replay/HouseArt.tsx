type Props = {
  /** Battery top colour (a CSS colour or `var(--rg-*)`). */
  batt: string
  /** Service cable colour; transparent while no energy flows. */
  cable: string
  width?: number
  height?: number
  label?: string
}

/** The flat house, battery and power line from the approved Home mockup. Task 6 uses it as the WebGL fallback. */
export function HouseArt({ batt, cable, width = 372, height = 250, label = "House, battery and power line" }: Props) {
  return (
    <svg className="zone-house-art" width={width} height={height} viewBox="-66 -74 132 96" role="img" aria-label={label}>
      <path d="M-48,0 L0,26 L0,32 L-48,6 Z" fill="#B3B7AF" />
      <path d="M0,26 L48,0 L48,6 L0,32 Z" fill="#A3A79F" />
      <path d="M0,-26 L48,0 L0,26 L-48,0 Z" style={{ fill: "var(--rg-clay-lawn)" }} />
      <path d="M-31,4 L-24,8 L-24,-3 L-31,-7 Z" fill="#E6E8E3" />
      <path d="M-24,8 L-17,4 L-17,-7 L-24,-3 Z" fill="#D3D6CF" />
      <path d="M-31,-7 L-24,-11 L-17,-7 L-24,-3 Z" style={{ fill: batt }} />
      <path d="M-16,-2 L6,10 L6,-12 L-16,-24 Z" fill="#F7F6F2" />
      <path d="M6,10 L28,-2 L28,-24 L6,-12 Z" fill="#E4E3DD" />
      <path d="M-6,3 L-2,5 L-2,-6 L-6,-8 Z" fill="#2B302D" />
      <path d="M12.6,-1.3 L21.4,-6.1 L21.4,-13.8 L12.6,-9 Z" fill="#EFB866" />
      <path d="M-18,-23 L6,-11 L6,-42 Z" fill="#848A86" />
      <path d="M6,-11 L30,-23 L6,-42 Z" fill="#6F7571" />
      <line x1="36" y1="-8" x2="36" y2="-46" stroke="#5E645F" strokeWidth="1.6" />
      <line x1="31" y1="-43" x2="41" y2="-47" stroke="#5E645F" strokeWidth="1.6" />
      <path d="M41,-47 L66,-58" stroke="#5E645F" strokeWidth="0.8" />
      <path d="M36,-43 Q14,-36 -24,-9" fill="none" style={{ stroke: cable }} strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
