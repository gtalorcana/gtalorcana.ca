# Lore Counter PWA — Feature Specification

## Overview

A **Lore Counter** Progressive Web App (PWA) built as a tool on the GTA Lorcana website. Matches the existing design system, color palette, fonts, and component patterns.

The tool lets 2–4 players track their lore score during a game of Disney Lorcana, with player name editing, undo support, a history log, and Bo1/Bo3 match tracking.

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
  - Registered with `updateViaCache: 'none'` so the browser always fetches `sw.js` fresh from the network
  - Cache-first strategy; activates immediately via `skipWaiting` + `clients.claim`
- Icons: existing `gtalorcana-logo.svg` and `gtalorcana.ca.png` at repo root — no new icon files
- Install prompt: "Add to Home Screen" banner shown when `beforeinstallprompt` fires
  - Suppressed during gameplay; shown on setup screen only
  - 7-day dismissal via `localStorage` key `gta-lorcana-install-dismissed`

---

## Player Setup Screen

- On first load (no saved state), show a setup screen:
  - Choose number of players: **2, 3, or 4**
  - Choose match format: **Bo1 or Bo3** (2-player only; hidden for 3–4 players)
  - Enter a name for each player (default: "Player 1", "Player 2", etc.)
  - "Start Game" button
- Player names are editable **during the game** (tap name → inline edit)
- Saved state in `localStorage` key `gta-lorcana-counter-state` restores the last game on reload

---

## Layout

### 2-player (portrait — primary use case)

Phone sits flat on the table between two players. Top panel rotated 180° so each player reads their own score from their side. No manual orientation controls — this is always the layout on a portrait-oriented device.

```
┌─────────────────┐
│  ▲ Player 2  ▲  │  ← rotated 180°
│     [−] 12 [+]  │
├────── pills ────┤  ← New Game · History (centred at divider)
│  Player 1       │
│     [−]  8 [+]  │
└─────────────────┘
```

### 2-player (landscape — desktop/tablet)

`@media (orientation: landscape)` switches automatically to side-by-side columns, no rotation.

```
┌──────────┬──────────┐
│ Player 1 │ Player 2 │
│    8     │    12    │
│  [−] [+] │  [−] [+] │
└──────────┴──────────┘
```

There is no manual orientation override. The installed PWA is locked to portrait via the manifest; in-browser, users should lock their device rotation if needed.

### 3–4 player layout

- Portrait: stacked panels (3-row or 2×2 grid); no per-panel rotation
- Landscape: 3-across or 2×2 grid
- Not polished for v1 — functional but not a priority

---

## Main Counter Screen

Each player panel includes:
- **Player name** — tappable to edit inline
- **Lore score** — large display (`Cinzel Decorative`), animates on change
- **[−1]** button — disabled at 0
- **[+1]** button — equal size to [−1]; rapid tapping logs separate increments
- **Win state** — when a player reaches 20 lore:
  - Panel gets a gold highlight
  - `✦ Player X wins! ✦` banner appears (non-blocking)
  - Game is **not locked** — players can continue adjusting scores
  - In Bo3: win prompt appears (see below)

All tap targets: minimum **48×48px** (72×72px on mobile, 96×96px on desktop)

### Game pills (fixed overlay)

Two pill buttons centred at the panel divider in portrait, bottom-centre in landscape:

- **New Game** — two-step confirm (tap → "Confirm?" → tap again within 4s); returns to setup screen
- **History** — opens the history drawer

---

## Bo1 / Bo3 Match Format

- Selector on setup screen (2-player only)
- **Bo1**: single game, no match tracking
- **Bo3**:
  - Match score strip shown at top of game screen: `Game 2 · 1–0`
  - When a player first crosses 20 lore, a win prompt appears:
    - Shows game winner and current match score
    - **"Start Game N"** — increments match score, resets lore to 0, carries player names
    - **"Not yet"** — dismisses prompt without advancing (handles fat-finger double-taps); undo still works
    - If match is decided (2 wins), prompt shows "Match complete" with no next-game button
  - Non-blocking win banner still shows on the panel regardless

---

## History / Change Log

- Every lore change logged: sequence number, player name, Δ amount, resulting score
- Slide-up drawer opened via "History" pill
- Shows last 50 entries; oldest pruned automatically
- Inside the drawer:
  - **Undo** — reverts the most recent lore change (single level); disabled when nothing to undo
  - **Clear History** — two-step confirm (4s auto-revert); clears log only, game continues
  - **New Game** — two-step confirm (4s auto-revert); resets everything and returns to setup

---

## Design & Styling

- Load order: `shared.css` → `tools.css` → `lore-counter.css`
- Fonts:
  - `Cinzel Decorative` — score display
  - `Cinzel` — labels, button text, history entries, pill buttons
  - `Lora` — player name inputs, body text
- CSS variables: `--gold`, `--surface`, `--surface2`, `--border`, `--text`, `--text-muted`, `--heading`, `--bg`, `--bg2`, `--transition`
- Starfield `<div id="stars"></div>` + `shared.js` included
- Theme toggle follows existing pattern (`data-theme` on `<html>`, `gta-lorcana-theme` in localStorage)
- Game mode hides nav and footer (`body.game-active`)
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

- Manual orientation override / rotate button (removed — overengineering)
- Turn tracker (Lorcana turns aren't sequential like chess)
- Quick-add buttons (+2/+3/+4) — rapid tapping + is sufficient
- Multiplayer sync across devices
- User accounts or cloud save
- Sound effects
- Card lookup or deck building
- 3–4 player layout polish
