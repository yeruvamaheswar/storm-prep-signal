# ReserveGate operator wall

## 1. Intent

This is a Texas grid-ops console for one simulated fleet. An operator reads one tick at a time: the labeled target, what the fleet delivered, why the reserve floor moved, which homes can still take work, and the brief written after the decision. It is a working instrument. Paper field, ink type, color only for state.

## 2. Locked tokens

| Role | Value |
|---|---|
| Field | `#F4F1EA` |
| Ink | `#1C1917` |
| Muted | `#6B645B` |
| Line | `#D6D1C8` |
| OK | `#2F6B4F` |
| Reserved | `#B45309` |
| Stale | `#7A746C` |
| Dead | `#9B2C2C` |
| Warn | `#B45309` |
| Target | `#1C1917` |

Do not retune these.

## 3. Type

One family: IBM Plex Sans, for display and body. Weights 400, 500, and 600 only. Hierarchy is weight and size, not a second font.

| Use | Size | Weight |
|---|---|---|
| Masthead | 20px | 600 |
| Metric value | 28px | 500 |
| Body | 15px | 400 |
| Label | 11px | 500 |
| Key | 11px | 600 |

All MW, prices, counts, and percents use tabular figures.

## 4. Space

Base unit 4px. Use only 4, 8, 12, 16, 24, and 40.

## 5. Radius

Controls: 2px. Boards: 0. Never 16px or more.

## 6. Color roles

- Field is the page.
- Ink is text and the target value.
- Muted is labels, units, and secondary lines.
- Line is a 1px hairline. No shadows.
- OK is a live home.
- Reserved and warn mark a raised floor or an on-purpose miss.
- Stale and dead mark homes the controller will not dispatch.
- Target is the asked-for MW, drawn in ink.

## 7. Motion

No bounce, elastic, or hover scale. A control may change its border color immediately. Switching ticks may fade the figures in 120ms.

## 8. Anti-slop (hard fail)

Reject and rewrite if any of these appear:

- Inter, Roboto, Open Sans, Poppins, Space Grotesk, or Geist as the face
- Purple, indigo, violet, cyan-on-navy, `#667eea`, Tailwind indigo-500
- Purple-to-blue or purple-to-cyan gradients, gradient text, glow orbs
- Glassmorphism or decorative backdrop-blur
- A dark page by default
- A centered hero, an eyebrow badge over an H1, or a pulsing Live pill
- Three equal feature cards
- `rounded-2xl` with a large shadow and padded cards on everything
- A colored 3–4px left border on cards
- Bounce or elastic hover
- Emoji as icons
- "Build the future" copy
- Cards nested in cards

## 9. Acceptance

- `npm run dev` in `web/` shows the wall.
- Tokens on screen match this file.
- None of the banned patterns are visible.
- A teammate can point at target, delivered, homes, and the brief without a tour.
- Every MW and $/MWh shows its label.
