# Safe to ID? Tool — Build Spec

## Overview

Build a web tool at `gtalorcana.ca/safe-to-id` that helps competitive Lorcana players determine if they can safely Intentional Draw (ID) during a Swiss tournament.

A static HTML form page calls a Cloudflare Worker that fetches live data from the Ravensburger Play Hub (RPH) API and runs the math.

---

## Context

- This is an addition to the existing `gtalorcana.ca` website
- The Cloudflare Worker is a **new separate Worker** deployment — do NOT modify the existing `gta-lorcana-sync` worker
- Both the worker and static HTML page live in the same repo (`gtalorcana.ca`)
- Use event ID `213150` (8 players) and `341947` (73 players) as test events
- **Scope: single-phase Swiss events only** (locals, regionals, CCQs). Multi-phase events like Disney Lorcana Challenges (DLCs) are not supported — see the DLC section below for details.

---

## Known RPH Data Quirks

### 1. Always use `points`, not `match_points` or `total_match_points`
The `match_points` and `total_match_points` fields in standings reflect **cumulative season totals** and may be ahead of the round being queried. Always use the `points` field as the authoritative value for all ID math calculations.

### 2. `number_of_rounds` may be wrong
`tournament_phases[0].number_of_rounds` is set by the organizer and may not match actual rounds played. Use `rounds.length` from the rounds array as the reliable source. Expose `total_swiss_rounds` as an editable field in the UI so users can correct it if needed.

### 3. `game_win_percentage` is always null
RPH does not persist GW% — it must be calculated from raw match data. Only Full mode does this calculation.

---

## Part 1: Cloudflare Worker

**File:** `worker/safe-to-id/index.js`
**Config:** `worker/safe-to-id/wrangler.toml`

### wrangler.toml

```toml
name = "gta-lorcana-safe-to-id"
main = "index.js"
compatibility_date = "2025-09-27"

[observability]
[observability.logs]
enabled = true
invocation_logs = true

[env.production]
routes = [
  { pattern = "api.gtalorcana.ca/*", zone_name = "gtalorcana.ca" },
]
```

> **Note:** The worker is hosted at `api.gtalorcana.ca` to avoid Cloudflare Pages intercepting requests.
> The `api` subdomain requires an `AAAA` DNS record pointing to `100::` (proxied) in Cloudflare DNS.

### CORS

Allow requests from `gtalorcana.ca`, `www.gtalorcana.ca`, and `localhost` for local dev.

### Error handling

All errors return JSON: `{"error": "...message..."}` with appropriate HTTP status:
- Invalid event ID → 400
- Event not found → 404
- No completed rounds yet → 400 with `"No completed rounds yet — nothing to analyze"`
- RPH API failure → 502

---

### Route 1: `GET /safe-to-id/event?id={event_id}`

Fetches event metadata from RPH. Used to auto-populate the form.

**RPH call:**
```
GET https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2/events/?id={event_id}
```

**Logic:**
- `total_swiss_rounds` = `rounds.length` from the Swiss phase rounds array (NOT `number_of_rounds`)
- `current_round` = round number of the last round that is NOT `COMPLETE`, or `rounds.length` if all complete
- `players` = fetch from last completed round's standings endpoint, use `user_event_status.best_identifier` as display name

**Return:**
```json
{
  "event_id": 341947,
  "event_name": "Lorcana $2500 Mystery Wheel Tournament",
  "player_count": 73,
  "total_swiss_rounds": 6,
  "current_round": 6,
  "rounds": [
    {"id": 519302, "round_number": 1, "status": "COMPLETE"},
    {"id": 519306, "round_number": 5, "status": "COMPLETE"},
    {"id": 519307, "round_number": 6, "status": "COMPLETE"}
  ],
  "players": [
    {"id": 37381, "name": "ryanfan"},
    {"id": 8752, "name": "ETB Kris"}
  ]
}
```

---

### Route 2: `POST /safe-to-id/analyze`

Runs the ID safety analysis.

**Request body:**
```json
{
  "event_id": 341947,
  "total_swiss_rounds": 6,
  "top_cut": 8,
  "player_id": 37381,
  "depth": "medium",
  "override_round_id": 519306
}
```

- `depth`: `"simple"` | `"medium"` | `"full"`
- `override_round_id`: optional — forces a specific round's standings (for testing only)
- Worker re-fetches event data internally to determine round IDs — client does not pass `current_round`

---

### RPH API Endpoints Used

**Event metadata:**
```
GET https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2/events/?id={event_id}
```

**Standings for a round:**
```
GET https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2/tournament-rounds/{round_id}/standings
```
Returns per player: `rank`, `record`, `points` (use this), `match_points` (ignore), `opponent_match_win_percentage`, `opponent_game_win_percentage`

**Match history for a round (Full mode only):**
```
GET https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2/tournament-rounds/{round_id}/matches
```
Returns per match: `games_won_by_winner`, `games_won_by_loser`, `winning_player`, `match_is_bye`, `match_is_intentional_draw`, `match_is_unintentional_draw`, `players: [id1, id2]`

---

### Math Logic

**Shared setup (all depths):**
```
rounds_remaining = max(0, total_swiss_rounds - current_round)
points_if_id_one = my_current_points + 1    // draw = 1pt
points_if_id_two = my_current_points + 2    // two draws
```

Always calculate verdict for BOTH "ID this round" and "ID this AND next round."
If `rounds_remaining <= 1`, set `id_two_rounds: null` and include:
`"id_two_rounds_note": "Only 1 round remaining — double ID not applicable."`

If `player_count <= top_cut`, set `all_players_advance: true` and all verdicts to `"safe"`.

**Simple:**
- Exclude the target player from all counts
- `can_catch` = other players whose `(current_points + 3 × rounds_remaining) >= points_if_id`
- `already_above` = other players currently above `points_if_id`
- `danger_count = can_catch - already_above`
- Verdict:
    - `danger_count < top_cut` → `"safe"`
    - `danger_count == top_cut` → `"risky"`
    - `danger_count > top_cut` → `"unsafe"`
- `danger_players` entries have `tiebreaker_vs_you: "unknown"` in Simple mode
- Omit `your_tiebreakers` and `caveat` from response

**Medium** (all of Simple, plus):
- Use `opponent_match_win_percentage` and `opponent_game_win_percentage` from RPH standings
- `your_tiebreakers.gw_pct` is `null` in Medium mode
- Build `danger_players` list from `id_one_round` can_catch players, sorted by max possible points DESC then OMW% DESC
- Compare tiebreakers: `"wins"` | `"loses"` | `"too_close"` (within 0.01 difference)
- Include `caveat: "Tiebreakers will shift as the current round completes."`

**Full** (all of Medium, plus):
- Fetch match history for all completed rounds in parallel (`Promise.all`)
- Calculate GW% per player:
  ```
  For each completed match:
    - winning player: games_won += games_won_by_winner
    - losing player:  games_won += games_won_by_loser
    - both players:   games_played += games_won_by_winner + games_won_by_loser
  Byes (match_is_bye == true): count as 2-0 win (games_won += 2, games_played += 2)
  Draws (intentional or unintentional): skip — no game wins attributed
  gw_pct = max(0.33, games_won / games_played)
  ```
- Tiebreaker order: OMW% → GW% → OGW%
- `your_tiebreakers.gw_pct` is populated in Full mode

---

### Response Format

```json
{
  "player_name": "ryanfan",
  "current_record": "4-1-1",
  "current_points": 10,
  "rounds_remaining": 1,
  "top_cut": 8,
  "depth": "medium",
  "all_players_advance": false,
  "id_one_round": {
    "points_if_id": 11,
    "danger_count": 22,
    "verdict": "unsafe"
  },
  "id_two_rounds": null,
  "id_two_rounds_note": "Only 1 round remaining — double ID not applicable.",
  "your_tiebreakers": {
    "omw_pct": 0.48,
    "gw_pct": null,
    "ogw_pct": 0.52
  },
  "danger_players": [
    {
      "name": "ETB Kris",
      "current_points": 12,
      "max_possible_points": 15,
      "omw_pct": 0.69,
      "gw_pct": null,
      "ogw_pct": 0.63,
      "tiebreaker_vs_you": "loses"
    }
  ],
  "caveat": "Tiebreakers will shift as the current round completes."
}
```

**Field rules by depth:**

| Field | Simple | Medium | Full |
|-------|--------|--------|------|
| `your_tiebreakers` | omitted | included, `gw_pct: null` | included, `gw_pct` populated |
| `caveat` | omitted | included | included |
| `danger_players[].gw_pct` | omitted | omitted | included |
| `danger_players[].tiebreaker_vs_you` | `"unknown"` | `"wins"`/`"loses"`/`"too_close"` | `"wins"`/`"loses"`/`"too_close"` |

---

## Part 2: Static HTML Page

**File:** `safe-to-id/index.html`

Single self-contained HTML file with inline CSS and JS. No external dependencies except the Worker API. Mobile-first. Dark theme with gold accents matching the GTA Lorcana site aesthetic.

### Worker URL

```js
const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const WORKER_BASE = isLocal ? 'http://localhost:8787' : 'https://api.gtalorcana.ca';
```

### Form Fields

| Field | Type | Behaviour |
|-------|------|-----------|
| Event ID | Text input | User types, then clicks [Fetch] |
| Event name | Display only | Auto-filled after fetch |
| Players | Display only | Auto-filled after fetch |
| Round | Display only | Auto-filled (e.g. "Round 6 of 6") |
| Top Cut | Number input | Default 8, editable |
| Total Rounds | Number input | Pre-filled from RPH, **editable** — user may need to correct |
| You are | Dropdown | Populated from standings after fetch, sorted alphabetically |
| Analysis Depth | Radio | Simple / Medium / Full — default Full |
| Can I ID? | Button | Disabled until fetch completes |

### Result Card

```
┌─────────────────────────────────┐
│  ryanfan  •  4-1-1  •  10pts    │
│                                 │
│  ID this round:                 │
│  ❌ UNSAFE                      │
│  22 players can catch you.      │
│  Too many players can pass you. │
│                                 │
│  ID this AND next round:        │
│  Only 1 round remaining —       │
│  double ID not applicable.      │
│                                 │
│  ── Your Tiebreakers ──         │
│  OMW%  48.0%                    │
│  OGW%  52.0%                    │
│                                 │
│  ── Danger Players ──           │
│  ETB Kris  12pts→15pts  😌      │
│  🦈Dale    12pts→15pts  😌      │
│                                 │
│  [       Check Again      ]     │
└─────────────────────────────────┘
```

**Verdict colours:**
- ✅ Safe → `#22c55e`
- ⚠️ Risky → `#f59e0b`
- ❌ Unsafe → `#ef4444`

**Danger player indicators:**
- 😰 they beat you on tiebreakers
- 😌 you beat them on tiebreakers
- 😬 too close to call (within 0.01)
- ❓ Simple mode (unknown)

**[Check Again]** clears results, focuses Event ID field.

### Mobile Requirements
- Font size minimum 16px on all inputs (prevents iOS zoom)
- Tap targets minimum 44px
- Result card scrolls into view automatically after submit
- Max width 480px, centered on desktop

---

## File Structure

```
gtalorcana.ca/ (single repo)
  safe-to-id/
    index.html
  worker/
    safe-to-id/
      index.js
      wrangler.toml
  .github/
    workflows/
      safe-to-id-deploy.yml
```

---

## Deployment

### GitHub Actions — `safe-to-id-deploy.yml`

Triggers on push to `main` when `worker/safe-to-id/**` files change.

```yaml
- uses: cloudflare/wrangler-action@v3
  with:
    apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    workingDirectory: worker/safe-to-id
    environment: production
```

### Cloudflare DNS

`AAAA` record for `api` subdomain:
- Name: `api`
- IPv6: `100::`
- Proxy: Proxied (orange cloud)

---

## Known Limitation: Disney Lorcana Challenge (DLC) Events

DLC events (e.g., Milwaukee, event `237107`) use a multi-phase Swiss structure that differs from standard single-phase tournaments:

| Phase | Players | Rounds | Advancement |
|-------|---------|--------|-------------|
| Phase 1 (Day 1) | ~2000 | 8 | Fixed 18-point threshold (not a ranking cut) |
| Phase 2 (Day 2) | ~276 survivors | 4 | Top 32 by ranking |
| Top 32 | 32 | — | Single elimination to finals |

Points carry over between phases. Draw rates at these events are much lower (~0.7%) than local events (~5%).

**The current probabilistic model does not handle multi-phase events.** It assumes all N players play all rounds, which overestimates danger after intermediate cuts (predicted 40pts needed for top 8 vs actual 36pts).

**Future approach:** Each phase could be modeled independently with the correct N. Phase 1 survivor count can be estimated as `N × probReach(18, 8)` — this predicted 280 vs 277 actual for Milwaukee (with 1% draw rate). Phase 2 is a standard ranking cut and would work with the existing `computeScenario` logic given the right inputs.

**Additional RPH quirk:** For completed DLC events, RPH sets `registration_status: "ELIMINATED"` on *all* players — including Day 2 survivors. This makes it impossible to distinguish Phase 1 casualties from active Day 2 players using status alone. A DLC implementation would need to either use the point threshold (18+) or check Phase 2 round participation to identify active players.

**Not yet implemented** — the tool currently works for single-phase Swiss events only.

---

## Build Order

1. Worker `/safe-to-id/event` route
2. Worker `/safe-to-id/analyze` — Simple depth
3. Worker `/safe-to-id/analyze` — Medium depth
4. Worker `/safe-to-id/analyze` — Full depth
5. HTML page
6. Run all test cases from `TEST_CASES.md`
