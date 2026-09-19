# Safe to ID Worker

Cloudflare Worker that powers `gtalorcana.ca/safe-to-id`. Fetches live standings from the Ravensburger Play Hub (RPH) API and calculates whether a player can safely Intentional Draw (ID) in a Swiss tournament.

**Base URL:** `https://api.gtalorcana.ca`

---

## Routes

### `GET /safe-to-id/event?id={event_id}`

Fetches event metadata to auto-populate the form.

**Response:**
```json
{
  "event_id": 341947,
  "event_name": "Lorcana $2500 Mystery Wheel Tournament",
  "player_count": 73,
  "total_swiss_rounds": 6,
  "current_round": 6,
  "rounds": [
    { "id": 519302, "round_number": 1, "status": "COMPLETE" }
  ],
  "players": [
    { "id": 37381, "name": "ryanfan" }
  ]
}
```

**Notes:**
- `total_swiss_rounds` is derived from `rounds.length`, not the organizer-set `number_of_rounds` field (which may be wrong)
- `current_round` is the first non-COMPLETE round, or the last round if all are complete
- Players are sourced from the last completed round's standings, sorted alphabetically

---

### `POST /safe-to-id/analyze`

Runs the ID safety analysis for a player.

**Request body:**
```json
{
  "event_id": 341947,
  "total_swiss_rounds": 6,
  "top_cut": 8,
  "player_id": 37381,
  "depth": "full",
  "override_round_id": 519306
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `event_id` | yes | RPH event ID |
| `total_swiss_rounds` | yes | Total Swiss rounds (user-editable in the UI to correct RPH data) |
| `top_cut` | yes | Number of players advancing to top cut |
| `player_id` | yes | RPH player ID |
| `depth` | yes | `"simple"` \| `"full"` |
| `override_round_id` | no | Force a specific round's standings — for testing only |

**Response:**
```json
{
  "player_name": "ryanfan",
  "current_record": "4-1-1",
  "current_points": 10,
  "rounds_remaining": 1,
  "top_cut": 8,
  "depth": "full",
  "all_players_advance": false,
  "id_one_round": {
    "points_if_id": 11,
    "danger_count": 20,
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
      "ogw_pct": 0.63,
      "tiebreaker_vs_you": "loses"
    }
  ],
  "caveat": "Tiebreakers will shift as the current round completes."
}
```

---

## Math

```
rounds_remaining  = max(0, total_swiss_rounds - current_round)
points_if_id_one  = current_points + 1   // one draw
points_if_id_two  = current_points + 2   // two draws

can_catch   = other players where (points + rounds_remaining × 3) >= points_if_id
already_above = other players where points > points_if_id
danger_count  = can_catch - already_above

danger_count < top_cut  → "safe"
danger_count == top_cut → "risky"
danger_count > top_cut  → "unsafe"
```

`id_two_rounds` is `null` with an explanatory note when `rounds_remaining <= 1`.

**Bye edge case:** When the target player has a bye, they can't ID — the bye is an automatic win (+3). Both the danger-count path and the simulation use the player's actual bye points (no +1 added). The UI label changes from "ID this/next round" to "Make top cut?" when `rounds_remaining` is 0.

If `player_count <= top_cut`, all verdicts are forced to `"safe"` and `all_players_advance: true` is set regardless of depth.

---

## Depth Levels

### Simple
- Verdict only — no tiebreaker data
- `danger_players[].tiebreaker_vs_you` is always `"unknown"`
- `your_tiebreakers` and `caveat` are omitted

### Full
Medium mode was removed — skipping GW% made tiebreaker comparisons unreliable.

- Adds `your_tiebreakers` (OMW% and OGW% from RPH standings) plus GW% calculated from raw match history
- Compares tiebreakers: `"wins"` | `"loses"` | `"too_close"` (within 0.01)
- Adds `caveat: "Tiebreakers will shift as the current round completes."`
- Fetches all completed rounds' match data in parallel
- `your_tiebreakers.gw_pct` is populated
- `danger_players[].gw_pct` is included
- Tiebreaker order: OMW% → GW% → OGW%

**GW% calculation:** RPH scores GW% as game points / (3 × games), so a drawn game is worth 1/3 of a win.

- Win: `games_won += games_won_by_winner`, lose: `games_won += games_won_by_loser`
- Bye: counts as 2-0 win (`games_won += 2`, `games_played += 2`) — RPH leaves a bye's game fields null
- Every match: `games_won += games_drawn / 3`, `games_played += games_drawn`. An intentional draw is recorded as 0-0-3
- `gw_pct = max(0.33, games_won / games_played)`

The simulation recomputes GW% and OGW% per scenario. An unreported win's game score is unknown, so each scenario is ranked with both 2-0 and 2-1 and the target's worse rank is kept.

---

## RPH Data Quirks

- **Always use `points`**, not `match_points` or `total_match_points` — those are cumulative season totals and may be inflated
- **`number_of_rounds` may be wrong** — use `rounds.length` instead
- **`game_win_percentage` is always null** in RPH standings — must be calculated from match data (Full mode only)
- **`/tournament-rounds/{id}/matches` returns 401** — use `/matches/paginated/?page={n}&page_size=100` and follow `next_page_number`
- **Round N standings may show round N+1 records** — ignore the `record` field for math, use `points` only

---

## Error Responses

All errors return `{"error": "...message..."}`.

| Status | Condition |
|--------|-----------|
| 400 | Missing/invalid params, no completed rounds, override_round_id not found |
| 404 | Event not found, player not in standings |
| 502 | RPH API failure |

---

## Local Development

```bash
cd worker/safe-to-id
npx wrangler dev --port 8787
```

Test cases are in [`docs/safe-to-id/safe-to-id-test-cases.md`](../../docs/safe-to-id/safe-to-id-test-cases.md). Use `override_round_id` to pin standings to a specific round without needing the event to be live.

---

## Snapshots

An event's live state is gone once it moves on, so capture it while the event is running:

```bash
# every raw RPH response + the worker's output for every player, per top cut
node worker/safe-to-id/tools/snapshot.mjs <event_id> 4 8
```

Each run writes `fixtures/event-<id>/<timestamp>/` holding `rph/`, `worker/` and a `manifest.json` summary. Re-run as rounds progress; every run gets its own folder.

To check a prediction against what actually happened:

```bash
node worker/safe-to-id/tools/compare.mjs <predictions.json> "<outcome label>" <snapshot dir> <round id>
```

It prints predicted vs actual rank, points, OMW%, GW% and OGW% per player. `fixtures/event-755724/` is a worked example: three snapshots across round 4 plus `cross-check-round4.txt`.
