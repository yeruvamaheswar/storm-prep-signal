import type { ReactNode } from "react"

type ButtonProps = {
  children: ReactNode
  pressed?: boolean
  armed?: boolean
  onClick: () => void
  label: string
}

export function Button({ children, pressed = false, armed = false, onClick, label }: ButtonProps) {
  const className = pressed && armed ? "button is-pressed is-armed" : pressed ? "button is-pressed" : "button"
  return (
    <button
      type="button"
      className={className}
      aria-pressed={pressed}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
