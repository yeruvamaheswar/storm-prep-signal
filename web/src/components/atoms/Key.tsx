import type { ReactNode } from "react"

type KeyProps = {
  children: ReactNode
}

export function Key({ children }: KeyProps) {
  return <span className="key">{children}</span>
}
