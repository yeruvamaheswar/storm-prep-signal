import type { ReactNode } from "react"
import { Key } from "../atoms/Key"

type StripItemProps = {
  name: string
  children: ReactNode
}

export function StripItem({ name, children }: StripItemProps) {
  return (
    <div className="strip-item">
      <Key>{name}</Key>
      {children}
    </div>
  )
}
