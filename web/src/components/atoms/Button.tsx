import type { ReactNode } from "react"

type ButtonProps = {
  children: ReactNode
  pressed?: boolean
  armed?: boolean
  disabled?: boolean
  onClick: () => void
  label: string
}

export function Button({
  children,
  pressed = false,
  armed = false,
  disabled = false,
  onClick,
  label,
}: ButtonProps) {
  const on = pressed && !disabled
  const className = on && armed ? "button is-pressed is-armed" : on ? "button is-pressed" : "button"
  return (
    <button
      type="button"
      className={className}
      aria-pressed={on}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
