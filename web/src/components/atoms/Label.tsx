import type { ReactNode } from "react"

type LabelProps = {
  children: ReactNode
}

export function Label({ children }: LabelProps) {
  return <span className="label">{children}</span>
}
