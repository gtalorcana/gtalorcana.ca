# Lore Counter PWA — Feature Specification

## Overview

A **Lore Counter** Progressive Web App (PWA) built as a tool on the GTA Lorcana website. Matches the existing design system, color palette, fonts, and component patterns.

The tool lets 2 players track their lore score during a game of Disney Lorcana, with player name editing, a per-panel history log, and Bo1/Bo3 match tracking.

---

## CSS/JS Architecture (multi-tool strategy)

```
shared.css          ← existing: nav, footer, theme, starfield (global)
tools.css           ← shared tool styles: .card, .btn, .field, label, input patterns
lore-counter/
  index.html
  lore-counter.js   ← all app logic
  lore-counter.css  ← unique styles: player panels, score display, layout
safe-to-id/
  index.html        ← future: refactor to use tools.css; no changes needed now
```

Each tool page links: `shared.css` → `tools.css` → `tool-name.css`

---

## PWA Setup

- `manifest.json` at repo root:
  - `name`: "GTA Lorcana — Lore Counter"
  - `short_name`: "Lore Counter"
  - `theme_color`: `#d4a843`
  - `display`: `standalone`
  - `orientation`: `portrait` — locks the installed PWA to portrait so the OS won't rotate the display when the phone is flat on a table
  - `start_url`: `/lore-counter/`
  - `scope`: `/lore-counter/`
- Service worker (`sw.js`) scoped to `/lore-counter/` — offline support for this tool only
  - Cache name auto-stamped with a timestamp by a pre-commit git hook (`sw.js` is updated and re-staged automatically)
  - Registered with `updateViaCache: 'none'` so the browser always fetches `sw.js` fresh
  - **Navigation requests (HTML): network-first**, falls back to cache when offline — prevents broken mixed-version loads during SW updates
  - **Static assets (CSS/JS): cache-first** for speed and offline support
  - Activates immediately via `skipWaiting` + `clients.claim`
  - **Auto-update on resume**: `shared.js` calls `reg.update()` on every `visibilitychange` (visible) so the installed PWA checks for a new SW when brought back from background. On `controllerchange`, the page reloads automatically — but only if `body.game-active` is not set, to avoid disrupting an active game.
- Icons: existing `gtalorcana-logo.svg` and `gtalorcana.ca.png` at repo root — no new icon files
- Install banner shown when `beforeinstallprompt` fires, on setup screen only:
  - Permanent — no dismiss button, no localStorage tracking
  - Copy: **"Add to Home Screen"** / "Saves like a regular app — no App Store needed. Opens full screen and works offline."
  - Disappears naturally once the app is installed (browser stops firing `beforeinstallprompt`)

---

## Player Setup Screen

- On first load (no saved state), show a setup screen:
  - Choose match format: **Bo1 or Bo3**
  - Enter a name for each player (default: "Player 1", "Player 2")
  - "Start Game" button
- Always 2 players — 3/4 player option removed (not polished)
- Player names are editable **during the game** (tap name → inline edit)
- Saved state in `localStorage` key `gta-lorcana-counter-state` restores the last game on reload

---

## Layout

### 2-player portrait (primary use case)

Phone sits flat on the table between two players. Player 2 renders in the top cell, rotated 180° so each player reads their own score from their side.

```
┌─────────────────┐
│  ▲ Player 2  ▲  │  ← rotated 180°, history above score
│     [−] 12 [+]  │
├────── pills ────┤  ← match strip + New Game pill centred at divider
│  Player 1       │
│     [−]  8 [+]  │
└─────────────────┘
```

### 2-player landscape (desktop/tablet)

`@media (orientation: landscape)` switches automatically to side-by-side columns, no rotation.

```
┌──────────┬──────────┐
│ Player 1 │ Player 2 │
│    8     │    12    │
│  [−] [+] │  [−] [+] │
└──────────┴──────────┘
```

No manual orientation override. The installed PWA is locked to portrait via the manifest.

---

## Main Counter Screen

Each player panel includes:
- **Per-panel history** — scrollable list of past lore totals (see History section)
- **Player name** — tappable to edit inline
- **Lore score** — large display (`Cinzel Decorative`), animates on change
- **[−1]** button — disabled at 0
- **[+1]** button — equal size to [−1]; rapid taps within 600ms are batched into one history entry
- **Win state** — when a player reaches 20 lore:
  - Panel gets a gold highlight
  - `✦ Player X wins! ✦` banner appears at the **outer edge** of the panel (away from the divider/pills)
  - Game is **not locked** — players can continue adjusting scores (minus still works for fat-finger correction)
  - Win prompt appears for both Bo1 and Bo3 (see Match Format section)
  - Once a winner is set, the other player reaching 20 does **not** trigger a second win state or prompt

All tap targets: minimum **48×48px** (72×72px on mobile, 96×96px on desktop)

### Game screen viewport

`#game-screen` is `position: fixed` with `top/left/right/bottom: 0` — pinned to all four edges, guaranteed full-screen coverage regardless of iOS viewport unit quirks. Safe area insets (`env(safe-area-inset-*)`) are applied as padding so content clears the notch/Dynamic Island. Background is `var(--bg)` so the safe area strips blend with the panels.

A `#game-stars` div (`position: absolute; inset: 0; z-index: 0`) lives inside `#game-screen` and is populated with the same twinkling star animation as the page-level starfield. Stars are visible in the 1px panel divider gap and the safe area strips; panels remain solid.

### Game pills

`#game-pills` is `position: absolute` inside `#game-screen`, centred at the panel divider using `top: calc(50% + (env(safe-area-inset-top) - env(safe-area-inset-bottom)) / 2)` to account for asymmetric safe area insets. Text selection disabled (`user-select: none`).

Centred at the panel divider in portrait:

- **Match strip** (Bo3 only) — `Game 2 · 1–0` shown above the pill button
- **New Game** pill — two-step confirm (tap → "Confirm?" → tap again within 4s); returns to setup screen
- **Next Game** pill (Bo3 mid-match, after "Not yet") — re-opens the win prompt
- **New Match** pill (Bo1 or Bo3 match decided, after "Close"/"Not yet") — two-step confirm, resets match and returns to setup

---

## Bo1 / Bo3 Match Format

- Selector on setup screen
- Both formats trigger a win prompt when a player first crosses 20 lore:

### Bo1
- Prompt: `✦ Player X wins! ✦` / `Match complete · 1–0`
- **Close** — dismisses prompt; pill becomes **New Match** (two-step confirm → setup)

### Bo3
- Match score strip at centre divider: `Game 2 · 1–0`
- Prompt shows game winner and current match score
- **Start Game N** — increments match score, resets lore to 0, carries player names
- **Not yet** — dismisses prompt without advancing (handles fat-finger); pill becomes **Next Game** (re-opens prompt)
- When match is decided (2 wins): prompt shows `Match complete · 2–0` with **Close** only; pill becomes **New Match**

Non-blocking win banner still shows on the panel regardless of prompt state.

---

## History

- Rapid taps within 600ms are batched — score updates immediately, history commits after inactivity
- Every committed change logged: `{ playerIndex, name, delta, result, seq }`
- Up to 50 entries retained; oldest pruned automatically
- Displayed **per-panel**, inline below the score buttons — no drawer

### Visual style (paper-and-pencil metaphor)
- Entries listed oldest-to-bottom, newest at the bottom
- **New entry**: slides up from below with a fade-in animation
- **Old entries**: gain `text-decoration: line-through` + fade to `opacity: .5` via CSS transition (like pencil strikethrough)
- Container uses a `::before` flex spacer so early entries anchor to the bottom; once entries overflow, normal upward scroll works
- Top edge has a gradient fade (`transparent → opaque over 12%`) hinting at scrollable history above
- Height: `15svh` (falls back to `6.5rem`); font: `clamp(.75rem, 2svh, 1rem)` — scales with screen size for consistent row count (~5 rows)
- Scrollbar hidden

---

## Design & Styling

- Load order: `shared.css` → `tools.css` → `lore-counter.css`
- Fonts:
  - `Cinzel Decorative` — score display
  - `Cinzel` — labels, button text, history entries, pill buttons
  - `Lora` — player name inputs, body text, install banner description
- CSS variables: `--gold`, `--surface`, `--surface2`, `--border`, `--text`, `--text-muted`, `--heading`, `--bg`, `--bg2`, `--transition`
- Starfield `<div id="stars"></div>` + `shared.js` included
- Theme toggle follows existing pattern (`data-theme` on `<html>`, `gta-lorcana-theme` in localStorage)
- Game mode hides nav and footer (`body.game-active`)
- Text selection disabled on `#game-screen` (`user-select: none`) to prevent accidental highlight on long-press
- **Installed PWA (standalone) adjustments** — detected via `window.navigator.standalone` in `shared.js`, which adds a `.standalone` class to `<html>`:
  - Nav `padding-top` increased to `3.5rem` to clear the notch/Dynamic Island (`env(safe-area-inset-top)` is unreliable on older iOS)
  - Page `main` `padding-top` increased to `8.5rem` to match the taller nav
  - `← Home` back link hidden (no browser back in standalone)
  - Nav logo pointer disabled (navigating away has no way back)
- Responsive: mobile portrait first; desktop breakpoint at 768px (larger buttons, score, pills)

---

## Technical Notes

- **Plain HTML/CSS/JS only** — no framework, no build step, no TypeScript
- `localStorage` key: `gta-lorcana-counter-state`
- Pre-commit hook auto-stamps `sw.js` cache name with a timestamp on every commit
- Place tool at `/lore-counter/index.html`

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
.git/hooks/pre-commit ← auto-bumps sw.js cache version on commit
```

---

## Out of Scope

- Manual orientation override / rotate button
- Undo (just tap minus)
- History drawer (replaced by per-panel inline history)
- Turn tracker (Lorcana turns aren't sequential like chess)
- Quick-add buttons (+2/+3/+4) — rapid tapping + is sufficient
- Multiplayer sync across devices
- User accounts or cloud save
- Sound effects
- Card lookup or deck building
- 3–4 player layout polish
