# ID Check Worker

Cloudflare Worker that powers `gtalorcana.ca/id-check`. Fetches live standings from the Ravensburger Play Hub (RPH) API and calculates whether a player can safely Intentional Draw (ID) in a Swiss tournament.

**Base URL:** `https://api.gtalorcana.ca`

---

## Routes

### `GET /id-check/event?id={event_id}`

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

### `POST /id-check/analyze`

Runs the ID safety analysis for a player.

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

| Field | Required | Description |
|-------|----------|-------------|
| `event_id` | yes | RPH event ID |
| `total_swiss_rounds` | yes | Total Swiss rounds (user-editable in the UI to correct RPH data) |
| `top_cut` | yes | Number of players advancing to top cut |
| `player_id` | yes | RPH player ID |
| `depth` | yes | `"simple"` \| `"medium"` \| `"full"` |
| `override_round_id` | no | Force a specific round's standings — for testing only |

**Response:**
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

If `player_count <= top_cut`, all verdicts are forced to `"safe"` and `all_players_advance: true` is set regardless of depth.

---

## Depth Levels

### Simple
- Verdict only — no tiebreaker data
- `danger_players[].tiebreaker_vs_you` is always `"unknown"`
- `your_tiebreakers` and `caveat` are omitted

### Medium
- Adds `your_tiebreakers` (OMW% and OGW% from RPH standings; `gw_pct: null`)
- Compares tiebreakers: `"wins"` | `"loses"` | `"too_close"` (within 0.01)
- Tiebreaker order: OMW% → OGW%
- Adds `caveat: "Tiebreakers will shift as the current round completes."`

### Full
- Everything in Medium, plus GW% calculated from raw match history
- Fetches all completed rounds' match data in parallel
- `your_tiebreakers.gw_pct` is populated
- `danger_players[].gw_pct` is included
- Tiebreaker order: OMW% → GW% → OGW%

**GW% calculation:**
- Win: `games_won += games_won_by_winner`, lose: `games_won += games_won_by_loser`
- Bye: counts as 2-0 win (`games_won += 2`, `games_played += 2`)
- Draw (intentional or unintentional): skipped — no game wins attributed
- `gw_pct = max(0.33, games_won / games_played)`

---

## RPH Data Quirks

- **Always use `points`**, not `match_points` or `total_match_points` — those are cumulative season totals and may be inflated
- **`number_of_rounds` may be wrong** — use `rounds.length` instead
- **`game_win_percentage` is always null** in RPH standings — must be calculated from match data (Full mode only)
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
cd worker/id-check
npx wrangler dev --port 8787
```

Test cases are in [`docs/id-check/id-check-test-cases.md`](../../docs/id-check/id-check-test-cases.md). Use `override_round_id` to pin standings to a specific round without needing the event to be live.
