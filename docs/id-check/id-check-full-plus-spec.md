# ID Check Tool — Full Mode Simulation Spec

## Overview

Full mode computes GW% tiebreakers from raw match history, then — when current
round pairings are available — simulates bubble match outcomes to give a
probability-style answer:

> "You make top 8 in 48 of 64 scenarios. Best case: rank 4. Worst case: rank 11."

When pairings are not yet posted, Full mode still returns tiebreaker data without
the simulation section.

---

## Depth Options

The tool has two user-facing depth modes:

| Depth | What it does |
|-------|-------------|
| Simple | Danger count only — how many players can mathematically catch you. No tiebreaker data. |
| Full | Computes OMW% → GW% → OGW% tiebreakers from raw match history, then simulates bubble match outcomes using current pairings (if available). Non-bubble results are estimated. |

Medium was removed — it skipped GW% (not provided by RPH directly), making its
tiebreaker comparisons unreliable when OMW% values were close. Full is strictly
more accurate.

---

## When Simulation is Available

Simulation requires current round pairings from RPH. These are available once the
organizer generates them — typically 5–10 minutes after the previous round ends,
before players sit down to play.

```
Round N ends
  → Organizer submits results → RPH generates round N+1 pairings
  → [simulation becomes available]
  → Players sit down and start playing round N+1
  → [this is the window players want to check]
```

If pairings are not yet posted, the response returns `pairings_available: false`
with tiebreaker data but no `full_plus` block. This is a 200 — not an error.

---

## Known Limitations

The simulation is an approximation, not a perfect prediction. Two sources of error:

**1. Non-bubble match assumption**
Matches where neither player is a bubble player are assumed to produce a win for
the higher-ranked player (by current points). In reality:
- Top players may intentionally draw (ID) to lock in their spot
- Upsets happen

This is the largest source of inaccuracy. It affects OMW% propagation throughout
the field, which can shift tiebreaker ordering among players who are all on the
same point total. In a real test (event 199148, round 8→9), ryanfan finished 5th
while the simulation predicted a best case of 6th — a one-spot difference caused
by non-bubble results not going chalk.

**2. Draws excluded from bubble match enumeration**
Each bubble match is simulated as win or loss only (2 outcomes, not 3).
Including draws would require 3^N combinations instead of 2^N:
- 3^7 = 2,187 (manageable)
- 3^12 = 531,441 (130× more work than 2^12)

Draws among bubble players are rare — those players are fighting to win.
The complexity cost is not worth the marginal accuracy gain.

**Practical implication:** The cut/no-cut verdict is reliable. Exact rank
prediction within a tightly clustered points tier is not.

---

## Algorithm

### Step 1 — Compute tiebreakers (always)

Fetch raw match data for all completed rounds. Compute GW% for every player:
- Track games won / games played per player
- Floor at 0.33

Use OMW% and OGW% from RPH standings directly. Build match history
(wins, played, opponents) for use in simulation.

### Step 2 — Detect pairing availability

Fetch current round matches endpoint. If empty → return with
`pairings_available: false`, skip simulation.

### Step 3 — Identify bubble players

```
bubble_players = players where:
  current_points + 3 >= target_points_if_id   // can catch target if they win
```

Exclude target player.

### Step 4 — Classify current round matches

For each match in current round pairings:
- **Target player's match** — treated as ID (+1 point each, draw, no win credited)
- **Bye** — player gets +3 points
- **Bubble match** — at least one player is a bubble player → enumerate
- **Non-bubble match** — higher points player assumed to win → pre-compute result

### Step 5 — Choose simulation strategy

```
N = number of bubble matches

N ≤ 12  →  Exhaustive enumeration (2^N combinations, max 4,096)
N > 12  →  Monte Carlo (1,000 random samples, ~3.5% margin of error)
```

### Step 6 — Simulate each scenario

For each combination of bubble match outcomes:

1. Apply all current round point deltas (target ID, byes, non-bubble winners,
   bubble winners)
2. Recompute OMW% for every player using updated win/match records:
   - Include completed round opponents + current round opponent
   - Floor at 0.33
3. Re-rank all players: points DESC → OMW% DESC → GW% DESC → OGW% DESC
4. Record target player's rank

GW% and OGW% are not recalculated per scenario (only OMW% changes meaningfully
within a single round).

### Step 7 — Aggregate

Track `makes_cut`, `best_rank`, `worst_rank`. In exhaustive mode, also record
`best_scenario` and `worst_scenario` (the specific match outcomes that produced
those ranks) for the "Root for" display.

---

## Response Format

Full mode returns tiebreaker data in all cases, plus `full_plus` when pairings
are available:

```json
{
  "depth": "full",
  "pairings_available": true,
  "your_tiebreakers": {
    "omw_pct": 0.645,
    "gw_pct": 0.6,
    "ogw_pct": 0.633
  },
  "danger_players": [...],
  "full_plus": {
    "simulation_mode": "exhaustive",
    "total_scenarios": 64,
    "makes_cut_scenarios": 48,
    "makes_cut_pct": 75.0,
    "margin_of_error_pct": 0,
    "best_rank": 4,
    "worst_rank": 11,
    "bubble_matches": 6,
    "best_scenario": [
      {"winner": "ETB Kris", "loser": "🦈Dale"},
      {"winner": "TeddyWestside", "loser": "BlazinAzn 🦈"}
    ],
    "worst_scenario": [...]
  }
}
```

When pairings are not available, `full_plus` is absent and
`pairings_available: false`.

Monte Carlo mode omits `best_scenario` / `worst_scenario` — they represent a
sampled extreme, not the true best/worst.

---

## Caching

| Data | Cache key | TTL |
|------|-----------|-----|
| Completed round matches | `matches:{round_id}` | 300s |
| Current round pairings | `matches:current:{round_id}` | 30s |

30s TTL on current pairings is short enough to pick up newly generated pairings
quickly while still reducing RPH load during concurrent requests.

Cache is bypassed entirely when `override_round_id` or
`override_current_pairings_round_id` is set (testing mode).

---

## Test Parameters

`override_round_id` and `override_current_pairings_round_id` allow testing with
historical data by specifying which round's standings and pairings to use.

**Validated test case — event 199148, round 8→9:**

```json
POST /id-check/analyze
{
  "event_id": 199148,
  "total_swiss_rounds": 9,
  "top_cut": 32,
  "player_id": 37381,
  "depth": "full",
  "override_round_id": 249175,
  "override_current_pairings_round_id": 249176
}
```

**Actual result:** ryanfan finished 5th (22pts, 7-1-1). Simulation predicted
best case rank 6, worst case rank 7 — off by one spot due to non-bubble results
not going chalk. Cut verdict was correct: 64/64 scenarios (100%) made top 32.

---

## UI

### Depth selector

```
Analysis Depth:
● Simple
○ Full
```

Selecting each option shows a contextual note:
- **Simple:** "Shows how many players can catch you. No tiebreaker data."
- **Full:** "Computes OMW% → GW% → OGW% tiebreakers from raw match history, then
  simulates bubble match outcomes using current pairings (if available).
  Non-bubble results are estimated."

### Result card — simulation section

Shown only for Full mode. When pairings not yet available, displays:
*"Pairings not yet posted — simulation unavailable. Check back once the organizer
generates round pairings."*

When available, shows scenario count, cut probability, best/worst rank, and a
"Root for" list (exhaustive mode only).
