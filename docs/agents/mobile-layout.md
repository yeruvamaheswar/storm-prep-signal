# Mobile layout (phone portrait)

**Decision.** Phone portrait support is CSS (and tiny gated JS) under `max-width: 720px` only. Desktop layouts stay unchanged. No PWA, no native shell, no landscape redesign.

## Open it when

You are changing phone layout, safe-area padding, Replay rails on small screens, or the fleet table card stack.

## Hard rules

1. Put new geometry only inside `@media (max-width: 720px)` (or the existing 640px fleet-grid band). Do not edit default desktop rules to “fix” mobile.
2. Leaflet pan/pinch on Replay/Live maps is enabled only when `matchMedia('(max-width: 720px)')` matches at mount ([`MapStage.tsx`](../../web/src/features/replay/MapStage.tsx)).
3. Prefer `100dvh` and `env(safe-area-inset-*)` for sticky bars and bottom sheets (notch / home indicator).
4. Keep [`DESIGN.md`](../../DESIGN.md) tokens and anti-slop. Replay keeps its dark map chrome.

## Breakpoints

| Band | Use |
|---|---|
| `max-width: 720px` | Shared phone portrait (shell, Replay, Live, wall, fleet table, flow) |
| `max-width: 640px` | Fleet grid banks → 1 column (existing); tiles → 3 columns on phone |
| `900` / `960` / `1180` | Existing tablet rules; do not retune for desktop |

## Per-route notes

| Route | Phone behavior |
|---|---|
| Shell TopBar | Wrap / horizontal scroll nav; safe-area top |
| `/` Replay, `/live` | Side rails stack as overlays; full-width playback; drawers as sheets; zone home fluid width; map touch on |
| `/wall` | Stress/ack/legend 1-col; feeds panel capped to viewport; tighter padding |
| `/fleet` | County tiles 3-wide; detail bottom sheet (existing) |
| `/fleet/table` | Rows become labeled stacked cards (`data-label`); all columns kept |
| `/flow` | Controls wrap; 44px min tap height on buttons |

## Out of scope

Landscape, iPad redesign, PWA / Add to Home Screen, native apps, push, Face ID, haptics, `apple-mobile-web-app-*` fullscreen, per-iPhone pixel chasing, system dark mode for paper pages, adding Wall/Flow to TopBar.

## Filled checks

- ~375×812 portrait: no page-level horizontal scroll; every desktop control reachable.
- ≥1280px: Replay dual rails + inset playback, wall `1fr 280px`, fleet table columns, flow two-column body match pre-change.
