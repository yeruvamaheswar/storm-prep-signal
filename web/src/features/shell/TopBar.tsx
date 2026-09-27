import type { ReactNode } from "react"
import "./shell.css"

type ShellPage = "replay" | "live" | "fleet"

type TopBarProps = {
  current: ShellPage
  rightSlot?: ReactNode
}

const navItems: Array<{ page: ShellPage; label: string; href: string }> = [
  { page: "replay", label: "Replay", href: "/" },
  { page: "live", label: "Live", href: "/live" },
  { page: "fleet", label: "Fleet", href: "/fleet" },
]

function BrandMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
      <rect x="3" y="9" width="20" height="14" rx="3" fill="none" stroke="var(--rg-ink)" strokeWidth="2" />
      <path d="M8 9 L13 3 L18 9" fill="none" stroke="var(--rg-ink)" strokeWidth="2" strokeLinejoin="round" />
      <path
        d="M12 12 L10 16.5 H14 L12 21"
        fill="none"
        stroke="var(--rg-order-way)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function TopBar({ current, rightSlot }: TopBarProps) {
  return (
    <header className="rg-bar">
      <a className="rg-brand" href="/">
        <BrandMark />
        ReserveGate
      </a>
      <nav className="rg-nav" aria-label="Main">
        {navItems.map((item) => (
          <a
            key={item.page}
            href={item.href}
            className={item.page === current ? "on" : undefined}
            aria-current={item.page === current ? "page" : undefined}
          >
            {item.label}
          </a>
        ))}
      </nav>
      {rightSlot === undefined ? null : <div className="rg-top-slot">{rightSlot}</div>}
    </header>
  )
}
