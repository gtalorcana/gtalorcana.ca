# ID Check Tool — Full+ Mode Spec

## Overview

Full+ mode extends Full mode by enumerating all possible outcomes for bubble matches
in the current round, giving the player a probability-style answer:

> "You make top 8 in 48 of 64 scenarios. Best case: rank 4. Worst case: rank 11."

This is only available after pairings have been generated for the current round.

---

## Prerequisites

- Complete and validate all test cases in `TEST_CASES.md`
- Complete caching from `CACHE_SPEC.md`
- Full+ builds on top of Full mode — all Full mode logic still applies

---

## When Full+ is Available

Full+ requires current round pairings from RPH. The current round pairings are
available from the matches endpoint once the organizer generates them — typically
5-10 minutes after the previous round ends, before players sit down to play.

```
Round N ends
  → Organizer submits results → RPH generates round N+1 pairings
  → [Full+ becomes available]
  → Players sit down and start playing round N+1
  → [This is the window players want to check]
```

---

## Detecting Pairing Availability

In the worker, after fetching event data:

```js
// Find the current in-progress round (status != COMPLETE)
// or the round after the last completed round
const currentRoundId = getCurrentRoundId(eventData);

// Attempt to fetch pairings for current round
const currentPairings = await fetchRphMatches(currentRoundId);
const pairingsAvailable = currentPairings && currentPairings.matches?.length > 0;
```

If `pairingsAvailable` is false and depth is `"full+"`, return:
```json
{
  "error": "pairings_not_available",
  "message": "Pairings for this round haven't been generated yet. Try Full mode, or check back once pairings are posted.",
  "fallback_depth": "full"
}
```

HTTP status: 400

---

## Algorithm

### Step 1 — Run Full mode as baseline

Get current standings, tiebreakers, and danger player list exactly as Full mode does.
This gives us the starting state before simulating round outcomes.

### Step 2 — Identify bubble players

Bubble players are those whose outcome in the current round could affect whether
the target player makes top cut.

```
bubble_threshold_high = points needed to definitely make top cut by winning
bubble_threshold_low  = points needed to potentially catch target player by winning

bubble_players = players where:
  current_points + 3 >= target_points_if_id   // can catch target if they win
  AND current_points + 3 <= bubble_threshold_high  // not already locked in
```

Typically 6-14 players on the bubble. Exclude target player.

### Step 3 — Identify bubble matches

From current round pairings, find matches where at least one player is a bubble player:

```js
const bubbleMatches = currentPairings.matches.filter(match =>
  match.players.some(pid => bubblePlayers.has(pid))
);
```

Each bubble match has exactly 3 possible outcomes: player1 wins, player2 wins, draw.
For simplicity, only enumerate win/loss (not draw) unless `match_is_intentional_draw`
is already set — draws are rare and complicate the tree significantly.

### Step 4 — Choose simulation strategy based on bubble size

```
N = bubbleMatches.length

if N <= 12:
  → Exhaustive enumeration (2^N combinations, max 4096)
  → Exact results, fast

else:
  → Monte Carlo simulation (1000 random samples)
  → ~3-5% margin of error, acceptable for go/no-go decisions
```

The threshold of 12 is chosen because:
- 2^12 = 4096 combinations — fast enough (~200ms)
- 2^13 = 8192 — starts pushing 500ms+
- Large tournaments (2000+ players, 12 rounds) regularly have 100+ bubble matches

**Exhaustive mode (N ≤ 12):**

```
outcomes = 2^N combinations (each match: player1 wins or player2 wins)
```

For each combination:
1. Apply win/loss results to all bubble players' point totals
2. Recalculate OMW% for all affected players
   - OMW% = average of all opponents' match win rates
   - Only opponents from completed rounds + this round's result
3. Recalculate GW% and OGW% similarly
4. Re-rank all players by: points DESC → OMW% DESC → GW% DESC → OGW% DESC
5. Record target player's rank in this scenario

**Monte Carlo mode (N > 12):**

```js
const MONTE_CARLO_SAMPLES = 1000;

for (let i = 0; i < MONTE_CARLO_SAMPLES; i++) {
  // Randomly assign winner for each bubble match
  const outcome = bubbleMatches.map(match => ({
    match_id: match.id,
    winner: Math.random() < 0.5 ? match.players[0] : match.players[1]
  }));

  const rank = simulateAndRank(outcome);
  // record rank as in exhaustive mode
}
```

Report results as estimated probabilities with a margin of error note:

```json
{
  "simulation_mode": "monte_carlo",
  "samples": 1000,
  "margin_of_error_pct": 3.5,
  "makes_cut_pct": 68.5
}
```

### Step 5 — Aggregate results

```js
const scenarios = {
  total: exhaustive ? 2**N : MONTE_CARLO_SAMPLES,
  makes_cut: 0,
  best_rank: Infinity,
  worst_rank: 0,
  best_scenario: null,
  worst_scenario: null,
  simulation_mode: N <= 12 ? "exhaustive" : "monte_carlo",
  margin_of_error_pct: N <= 12 ? 0 : 3.5,
};

for (const outcome of allOutcomes) {
  const rank = simulateAndRank(outcome);
  if (rank <= top_cut) scenarios.makes_cut++;
  if (rank < scenarios.best_rank) { scenarios.best_rank = rank; scenarios.best_scenario = outcome; }
  if (rank > scenarios.worst_rank) { scenarios.worst_rank = rank; scenarios.worst_scenario = outcome; }
}
```

Note: `best_scenario` and `worst_scenario` are only meaningful in exhaustive mode.
In Monte Carlo mode, omit them — they represent a sampled extreme, not the true best/worst.

### Step 6 — Non-bubble match assumption

For matches where neither player is a bubble player, assume the higher-ranked
player (by current points) wins. This is a reasonable approximation and keeps
the combination space manageable.

---

## OMW% Recalculation

This is the most complex part. OMW% for a player is:

```
OMW% = average of each opponent's match win rate
match win rate for opponent X = X's wins / X's total matches played
minimum floor: 0.33
```

When simulating an outcome where player A beats player B in round N:
- A gets +1 win, +1 match played
- B gets +1 loss, +1 match played
- Everyone who previously played A or B has their OMW% shift slightly

For performance, only recalculate OMW% for players whose opponents were in
bubble matches. Other players' OMW% stays as fetched from RPH.

---

## Response Format

Full+ returns everything Full mode returns, plus:

**Exhaustive mode (small tournaments, N ≤ 12 bubble matches):**
```json
{
  "depth": "full+",
  "pairings_available": true,
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
      {"match_id": 12345, "winner": "ETB Kris", "loser": "🦈Dale"},
      {"match_id": 12346, "winner": "TeddyWestside", "loser": "BlazinAzn 🦈"}
    ],
    "worst_scenario": [
      {"match_id": 12345, "winner": "🦈Dale", "loser": "ETB Kris"},
      {"match_id": 12346, "winner": "BlazinAzn 🦈", "loser": "TeddyWestside"}
    ]
  }
}
```

**Monte Carlo mode (large tournaments, N > 12 bubble matches):**
```json
{
  "depth": "full+",
  "pairings_available": true,
  "full_plus": {
    "simulation_mode": "monte_carlo",
    "total_scenarios": 1000,
    "makes_cut_scenarios": 685,
    "makes_cut_pct": 68.5,
    "margin_of_error_pct": 3.5,
    "best_rank": 18,
    "worst_rank": 45,
    "bubble_matches": 127,
    "best_scenario": null,
    "worst_scenario": null
  }
}
```

---

## UI Changes

### Depth selector

```
Analysis Depth:
○ Simple
○ Medium
○ Full
○ Full+ (requires pairings — available once round starts)
```

Show a small info tooltip or note under Full+:
*"Simulates all possible round outcomes for bubble players. Most accurate — only
available after pairings are posted."*

### Result card additions (Full+ only)

**Exhaustive mode (exact results):**
```
┌─────────────────────────────────┐
│  ryanfan  •  4-1-1  •  10pts    │
│                                 │
│  ID this round:                 │
│  ❌ UNSAFE                      │
│  22 players can catch you.      │
│                                 │
│  ── Full+ Simulation ──         │
│  Checked all 64 scenarios       │
│  48 of 64 ✅ you make top 8    │
│  Best case:  rank 4             │
│  Worst case: rank 11            │
│                                 │
│  Root for:                      │
│  ETB Kris to beat 🦈Dale        │
│  TeddyWestside to beat BlazinAzn│
│                                 │
│  [       Check Again      ]     │
└─────────────────────────────────┘
```

**Monte Carlo mode (estimated results):**
```
┌─────────────────────────────────┐
│  ryanfan  •  9-2-1  •  28pts    │
│                                 │
│  ID this round:                 │
│  ⚠️ RISKY                       │
│  34 players can catch you.      │
│                                 │
│  ── Full+ Simulation ──         │
│  Sampled 1,000 of ~10^38 cases  │
│  685 of 1000 ✅ you make top 32 │
│  (~68.5% ± 3.5%)                │
│  Best case:  rank 18            │
│  Worst case: rank 45            │
│                                 │
│  127 bubble matches —           │
│  too many to check exhaustively │
│                                 │
│  [       Check Again      ]     │
└─────────────────────────────────┘
```

### Pairings not available

If Full+ selected but pairings not ready:

```
┌─────────────────────────────────┐
│  ⏳ Pairings not yet available  │
│                                 │
│  Round 7 pairings haven't been  │
│  posted yet. Check back once    │
│  the organizer generates them,  │
│  or use Full mode now.          │
│                                 │
│  [  Use Full mode instead  ]    │
└─────────────────────────────────┘
```

---

## Performance Budget

| Scenario | Bubble matches | Strategy | Expected time |
|----------|---------------|----------|--------------|
| Small local (8-32 players) | 2-6 | Exhaustive | < 200ms |
| Mid-size regional (64-128 players) | 6-12 | Exhaustive | < 500ms |
| Large regional (128-512 players) | 12-30 | Monte Carlo | 1-2s |
| National (2000+ players) | 100-150 | Monte Carlo | 2-4s |

Target: show a loading spinner for any Full+ request — response time is variable.
For Monte Carlo mode, display margin of error in the result card.

---

## Caching for Full+

Current round pairings change once per round (when organizer generates them) then
stay fixed. Cache with 30 second TTL — short enough to pick up newly generated
pairings quickly, long enough to avoid hammering RPH.

```js
const currentPairings = await fetchWithCache(
  `matches:current:${currentRoundId}`,
  () => fetchRphMatches(currentRoundId),
  30,  // 30 second TTL for current round
  ctx
);
```

Completed round match history stays cached at 300 seconds as per `CACHE_SPEC.md`.

---

## Build Order

1. Add `"full+"` as valid depth value to `/id-check/analyze`
2. Implement pairing availability detection
3. Implement bubble player identification
4. Implement outcome enumeration and OMW% recalculation
5. Implement response aggregation
6. Update HTML page — add Full+ radio option and result card section
7. Test with event `341947` simulating round 5 going into round 6:
   - Use `override_round_id: 519306` for standings
   - Use round 6 matches (`519307`) as simulated "current round pairings"
   - Verify best/worst case ranks are plausible given actual round 6 results

---

## Test Case for Full+

```json
POST /id-check/analyze
{
  "event_id": 341947,
  "total_swiss_rounds": 6,
  "top_cut": 8,
  "player_id": 37381,
  "depth": "full+",
  "override_round_id": 519306,
  "override_current_pairings_round_id": 519307
}
```

Add `override_current_pairings_round_id` as a test-only parameter that forces
the worker to use a specific round's matches as the "current round pairings."

**Expected:**
- `pairings_available: true`
- `full_plus.total_scenarios` = 2^N where N = number of bubble matches in round 6
- `full_plus.makes_cut_scenarios` < `full_plus.total_scenarios` (ryanfan is on bubble)
- `full_plus.worst_rank` > 8 (ryanfan missed top 8 in reality)
- Response time < 1000ms