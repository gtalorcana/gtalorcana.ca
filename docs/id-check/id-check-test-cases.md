# ID Check Tool — Test Cases

## Test Environment

All tests call `POST https://api.gtalorcana.ca/id-check/analyze` directly.
No GUI time travel needed — use `override_round_id` to pin a specific round's standings.

---

## Known Data Issues (RPH quirks)

### 1. `points` vs `match_points` vs `total_match_points`
The `match_points` and `total_match_points` fields in RPH standings reflect **cumulative season totals** and may be ahead of the actual round being queried. Always use the `points` field as the authoritative value for all ID math calculations.

### 2. `number_of_rounds` may be wrong
The `tournament_phases[0].number_of_rounds` field is set by the organizer and may not match the actual number of rounds played. Use the length of the `rounds` array as the reliable source, and expose `total_swiss_rounds` as an editable field in the UI so users can correct it.

### 3. Round 5 standings show round 6 records
In event `341947`, the standings endpoint for round 5 (`519306`) returns `record` fields that already reflect 6 rounds of play. This is an RPH data quirk — ignore the `record` field for math, use `points` only.

---

## Test Events

| Event ID | Name | Players | Swiss Rounds | Top Cut |
|----------|------|---------|-------------|---------|
| `213150` | Saturday Fabled - Set Championship | 8 | 3 | 8 |
| `341947` | Lorcana $2500 Mystery Wheel Tournament | 73 | 6 | 8 |

---

## Event 341947 — Simulation Setup

**Simulated state:** End of round 5, about to play round 6 (the final round)
**Override round:** `519306` (round 5 standings)
**Ground truth:** Round 6 standings (`519307`) — used to verify predictions

**Key round 5 standings (points field):**

| Rank | Player | Player ID | Points | Record (display) |
|------|--------|-----------|--------|-----------------|
| 1 | Levacryan | 13608 | 13 | 4-0-2 |
| 2 | RayLax | 21741 | 13 | 4-0-2 |
| 3 | HABIBI | 8809 | 13 | 4-0-2 |
| 4 | kbear23 | 6534 | 13 | 4-0-2 |
| 5 | Brave_Sloth | 20329 | 13 | 4-1-1 |
| 6 | ETB Kris | 8752 | 12 | 5-1-0 |
| 7 | 🦈Dale | 37373 | 12 | 5-1-0 |
| 8 | TeddyWestside | 37198 | 12 | 4-2-0 |
| 9 | BlazinAzn 🦈 | 37502 | 12 | 5-1-0 |
| 10 | Jeremy_A | 19196 | 12 | 4-2-0 |
| 11 | TheOps | 10952 | 12 | 4-2-0 |
| 12 | Lazaro | 41620 | 12 | 5-1-0 |
| 13 | Legendaryfocus | 35990 | 10 | 3-2-1 |
| 14 | lilsuzieq | 8947 | 10 | 4-1-1 |
| 15 | ryanfan | 37381 | 10 | 4-1-1 |

`rounds_remaining = 6 - 5 = 1`

---

## Test Cases

---

### TC-1: Levacryan — Risky to ID (rank 1, 13pts)

```json
POST /id-check/analyze
{
  "event_id": 341947,
  "total_swiss_rounds": 6,
  "top_cut": 8,
  "player_id": 13608,
  "depth": "medium",
  "override_round_id": 519306
}
```

**Manual math:**
- Points if ID: `13 + 1 = 14`
- Players who can reach 14+ (need `points + 3 >= 14`, i.e. `points >= 11`):
    - Ranks 1-12 all have 12-13pts → all can reach 14+ by winning
    - That's 11 other players who can reach 14+
- `danger_count = 11`, `top_cut = 8`
- `11 > 8` → ❌ **Unsafe**

Wait — Levacryan actually drew round 6 and finished rank 5 with 14pts, making top 8. But the math says Unsafe. This is correct — ID was genuinely risky/unsafe mathematically, they got lucky that enough people above them also drew or lost.

**Expected response:**
```json
{
  "id_one_round": {
    "points_if_id": 14,
    "danger_count": 11,
    "verdict": "unsafe"
  }
}
```

**Ground truth validation:** Levacryan finished rank 5 (made top 8 by drawing) — confirms this was a dangerous ID that worked out.

---

### TC-2: ETB Kris — Unsafe to ID (rank 6, 12pts)

```json
POST /id-check/analyze
{
  "event_id": 341947,
  "total_swiss_rounds": 6,
  "top_cut": 8,
  "player_id": 8752,
  "depth": "medium",
  "override_round_id": 519306
}
```

**Manual math:**
- Points if ID: `12 + 1 = 13`
- Players who can reach 13+ (`points >= 10`): ranks 1-15 = 14 other players
- `danger_count = 14 > 8` → ❌ **Unsafe**

**Expected response:**
```json
{
  "id_one_round": {
    "points_if_id": 13,
    "danger_count": 14,
    "verdict": "unsafe"
  }
}
```

**Ground truth validation:** ETB Kris won round 6 and finished rank 1 with 15pts ✅ confirms they needed to win.

---

### TC-3: ryanfan — Unsafe to ID (rank 15, 10pts)

```json
POST /id-check/analyze
{
  "event_id": 341947,
  "total_swiss_rounds": 6,
  "top_cut": 8,
  "player_id": 37381,
  "depth": "medium",
  "override_round_id": 519306
}
```

**Manual math:**
- Points if ID: `10 + 1 = 11`
- Players who can reach 11+ (`points >= 8`): essentially everyone in top 30+
- `danger_count >> 8` → ❌ **Unsafe**

**Expected response:**
```json
{
  "id_one_round": {
    "points_if_id": 11,
    "verdict": "unsafe"
  }
}
```

**Ground truth validation:** ryanfan won round 6 (reached 13pts) but still finished rank 11 — missed top 8 even after winning ✅ confirms ID would have been disastrous.

---

### TC-4: Simple mode — no tiebreakers in response

```json
POST /id-check/analyze
{
  "event_id": 341947,
  "total_swiss_rounds": 6,
  "top_cut": 8,
  "player_id": 37381,
  "depth": "simple",
  "override_round_id": 519306
}
```

**Expected:**
- `your_tiebreakers` field is absent from response
- `caveat` field is absent from response
- All `danger_players` entries have `tiebreaker_vs_you: "unknown"`
- Verdict matches TC-3 (same player, same round)

---

### TC-5: All players advance edge case (event 213150)

```json
POST /id-check/analyze
{
  "event_id": 213150,
  "total_swiss_rounds": 3,
  "top_cut": 8,
  "player_id": 49139,
  "depth": "simple"
}
```

Player: Dottie (0-3-0, 0pts)
8 players total, top 8 cut — everyone makes it regardless of results.

**Expected:**
```json
{
  "id_one_round": {
    "verdict": "safe"
  },
  "all_players_advance": true,
  "caveat": "Top cut equals or exceeds player count — all players advance."
}
```

---

### TC-6: Double ID — only 1 round remaining

```json
POST /id-check/analyze
{
  "event_id": 341947,
  "total_swiss_rounds": 6,
  "top_cut": 8,
  "player_id": 13608,
  "depth": "medium",
  "override_round_id": 519306
}
```

`rounds_remaining = 1`, so double ID is not possible.

**Expected:**
```json
{
  "rounds_remaining": 1,
  "id_two_rounds": null,
  "id_two_rounds_note": "Only 1 round remaining — double ID not applicable."
}
```

---

### TC-7: Full mode — GW% calculated from match data

```json
POST /id-check/analyze
{
  "event_id": 341947,
  "total_swiss_rounds": 6,
  "top_cut": 8,
  "player_id": 13608,
  "depth": "full",
  "override_round_id": 519306
}
```

**Expected:**
- `your_tiebreakers.gw_pct` is a number (not null)
- All `danger_players` have `gw_pct` populated
- OMW% values are close to (within 0.02 of) the RPH-provided `opponent_match_win_percentage` values
- Tiebreaker comparisons (`tiebreaker_vs_you`) are present for all danger players

---

## Validation Summary

| TC | Player | Expected Verdict | Ground Truth |
|----|--------|-----------------|--------------|
| 1 | Levacryan | ❌ Unsafe | Made top 8 by drawing — risky ID that worked |
| 2 | ETB Kris | ❌ Unsafe | Won round 6, finished rank 1 |
| 3 | ryanfan | ❌ Unsafe | Won round 6, still missed top 8 at rank 11 |
| 4 | ryanfan (Simple) | ❌ Unsafe | Same as TC-3, no tiebreakers |
| 5 | Dottie | ✅ Safe (all advance) | 8-player top-8 event |
| 6 | Levacryan | `id_two_rounds: null` | 1 round remaining |
| 7 | Levacryan (Full) | ❌ Unsafe + GW% populated | GW% calculated from matches |