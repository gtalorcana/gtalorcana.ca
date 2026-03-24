# Lore Counter PWA — Feature Specification

## Overview

Build a **Lore Counter** Progressive Web App (PWA) as a new tool on this GTA Lorcana website. It should feel like a native part of the site — matching the existing design system, color palette, fonts, and component patterns already in use.

The tool lets 2–4 players track their lore score during a game of Disney Lorcana, with player name editing, undo support, and a history log of score changes.

---

## CSS/JS Architecture (multi-tool strategy)

This tool establishes a sustainable pattern for future tools on the site:

```
shared.css          ← existing: nav, footer, theme, starfield (global)
tools.css           ← NEW: .card, .btn, .field, label, input patterns
                           shared across all tool pages
lore-counter/
  index.html
  lore-counter.js   ← all app logic (separate file — will be substantial)
  lore-counter.css  ← only truly unique styles (player panels, score display, layout)
safe-to-id/
  index.html        ← future: refactor to use tools.css; no changes needed now
```

Each tool page links: `shared.css` → `tools.css` → `tool-name.css`

`tools.css` is created for this feature. Safe-to-id is left as-is for now (refactor later).

---

## Requirements

### PWA Setup

- Add a `manifest.json` at the repo root with:
  - `name`: "GTA Lorcana — Lore Counter"
  - `short_name`: "Lore Counter"
  - `theme_color`: `#d4a843` (matches `--gold`)
  - `display`: `standalone`
  - `start_url`: `/lore-counter/`
  - `scope`: `/lore-counter/` (isolated — only this tool goes offline)
- Register a service worker (`sw.js`) scoped to `/lore-counter/` — offline support for this tool only
- Add the correct `<meta>` tags and manifest link to `lore-counter/index.html` only
- Include PWA install prompt handling: show an "Add to Home Screen" banner when `beforeinstallprompt` fires
- Icons: use existing `gtalorcana-logo.svg` and `gtalorcana.ca.png` already at the repo root — no new icon files needed

---

### Player Setup Screen

- On first load (no saved state), show a setup screen:
  - Choose number of players: **2, 3, or 4**
  - Enter a name for each player (default: "Player 1", "Player 2", etc.)
  - "Start Game" button
- Player names are editable **during the game** (tap name → inline edit)
- Saved state in `localStorage` key `gta-lorcana-counter-state` restores the last game on reload

---

### Layout & Orientation

#### 2-player layout (priority)

**Portrait (default):** Phone sits flat on the table between two players. Top panel is rotated 180° so each player reads their own score from their side.

```
┌─────────────────┐
│  ▲ Player 2  ▲  │  ← rotated 180°
│     [−] 12 [+]  │
│   [+2] [+3] [+4]│
├─────────────────┤
│  Player 1       │
│     [−]  8 [+]  │
│   [+2] [+3] [+4]│
└─────────────────┘
```

**Landscape:** Side-by-side, no rotation needed.

```
┌──────────┬──────────┐
│ Player 1 │ Player 2 │
│    8     │    12    │
│[−][+][+2]│[−][+][+2]│
└──────────┴──────────┘
```

**Auto-switching:** `@media (orientation: landscape)` handles the switch automatically.

**Rotate button:** A small toggle in the UI (e.g. top-right corner) lets users manually override the orientation — sets `data-orientation="portrait|landscape"` on the container, which takes precedence over the media query. Useful if the device is lying flat or gyroscope is locked.

#### 3–4 player layout (nice-to-have)

- Portrait: stacked panels or 2×2 grid (no per-panel rotation — too complex)
- Landscape: 3-across or 2×2 grid (recommended; show a subtle "Rotate for best experience" hint in portrait)
- Not a priority for v1 — implement if time allows; spec the 2-player experience first

---

### Main Counter Screen

Each player panel includes:
- **Player name** — tappable to edit inline
- **Lore score** — large, prominent font
- **[−1]** button — cannot go below 0
- **[+1]** button — primary action, largest tap target
- No quick-add buttons — rapid tapping `+` is sufficient; simpler UI preferred
- **Win state** — when a player reaches 20 lore:
  - Panel gets a gold highlight
  - Small "🏆 Player X wins!" banner appears (non-blocking — no modal)
  - Game is **not locked** — intentional, to handle fat-finger double-taps
  - Players can continue adjusting scores freely after the win indicator appears

All tap targets: minimum **48×48px**

---

### History / Change Log

- Every lore change logged: player name, Δ amount, resulting score (entries are in order — no timestamp needed)
- Accessible via a **slide-up drawer** (tap a "History" pill/button at the bottom of the screen)
- Shows last ~50 entries; oldest are pruned automatically
- **Reset button** inside the drawer uses a two-step confirm:
  - Tap "New Game" → button transforms into `[Confirm Reset]` + `[Cancel]`
  - Auto-cancels back to normal after ~4 seconds if untouched
  - This prevents accidental resets; no modal or alert needed
- "Clear History" (separate from reset) can also live here with the same two-step pattern

---

### Undo

- **Undo last action** — reverts the most recent lore change (single level)
- Small, accessible button (not prominent — shouldn't compete with scoring buttons)

---

## Design & Styling

- Link `shared.css` → `tools.css` → `lore-counter.css` in that order
- Fonts (same Google Fonts `<link>` tags as all other pages):
  - `Cinzel Decorative` — page title
  - `Cinzel` — labels, button text, history entries
  - `Lora` — player name inputs, body text
- CSS variables to use: `--gold`, `--surface`, `--surface2`, `--border`, `--text`, `--text-muted`, `--heading`, `--glow`, `--bg`, `--transition`
- Include starfield `<div id="stars"></div>` and pull in `shared.js`
- Theme toggle follows existing pattern (`data-theme` on `<html>`, `gta-lorcana-theme` in localStorage)
- Score number transitions: fade or subtle scale on change
- Responsive: mobile portrait first, usable on tablet/desktop

---

## Technical Notes

- **Plain HTML/CSS/JS only** — no framework, no build step, no TypeScript
- `localStorage` key: `gta-lorcana-counter-state`
- Service worker scoped to `/lore-counter/` — caches HTML, CSS, JS, fonts if feasible
- Place tool at `/lore-counter/index.html` (consistent with `safe-to-id/index.html`)

---

## File Structure

```
/lore-counter/
  index.html
  lore-counter.js
  lore-counter.css

manifest.json         ← repo root
sw.js                 ← repo root, scoped to /lore-counter/
tools.css             ← repo root, shared tool styles
```

---

## Out of Scope (v1)

- Multiplayer sync across devices
- User accounts or cloud save
- Sound effects
- Card lookup or deck building
- 3–4 player layout polish (nice-to-have, not required for launch)
