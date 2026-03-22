# ID Check Tool — Full Mode Simulation Spec (Updated)

## Overview

Full mode computes GW% tiebreakers from raw match history, then — when current
round pairings are available — simulates all match outcomes to give a
probability-style answer:

> "You make top 8 in 48 of 64 scenarios. Best case: rank 4. Worst case: rank 11."

When pairings are not yet posted, Full mode still returns tiebreaker data without
the simulation section.

---

## Depth Options

| Depth | What it does |
|-------|-------------|
| Simple | Danger count only — how many players can mathematically catch you. No tiebreaker data. |
| Full | Computes OMW% → GW% → OGW% from raw match history. When current round pairings are available, simulates all match outcomes weighted by ID probability. Partial results mid-round reduce the combination space in real time. |

Medium mode was removed — it skipped GW% (not provided by RPH directly), making
tiebreaker comparisons unreliable when OMW% values were close. Full is strictly
more accurate.

---

## RPH Status Values (Confirmed from Live Data)

**Round status:**
- `"COMPLETE"` — round fully done, standings generated
- `"IN_PROGRESS"` — round currently being played
- `"UPCOMING"` — round not yet started, pairings not generated

**Match status within an in-progress round:**
- `"COMPLETE"` — result reported
- `"IN_PROGRESS"` — match not yet reported

**A match is known (result final) when:**
```js
match.status === "COMPLETE"
  || match.match_is_intentional_draw === true
  || match.match_is_unintentional_draw === true
```

**A match is unknown (needs simulation) when:**
```js
match.status === "IN_PROGRESS"
  && match.winning_player === null
  && match.match_is_intentional_draw === false
  && match.match_is_unintentional_draw === false
```

**Pairings are available for a round when:**
- Round status is `"IN_PROGRESS"` AND matches endpoint returns at least one match

**Pairings are NOT available when:**
- Round status is `"UPCOMING"` — matches endpoint returns empty or 404
- This is the signal to return `pairings_available: false`

---

## How Draws Affect Tiebreakers

Both intentional and unintentional draws are treated **identically** in all
tiebreaker calculations:

**Match points:** +1 to each player (same as each other, different from win/loss)

**GW%:** Both draw types are excluded — no game wins attributed to either player.
`games_won_by_winner` and `games_won_by_loser` are null for draws.

**OMW%:** A draw gives +1 match played, +0 wins. This slightly lowers the drawing
player's match win rate compared to a win, which slightly lowers the OMW% of
everyone who played them. Same effect regardless of intentional vs unintentional.

**OGW%:** Same indirect effect as OMW%.

**Practical implication:** Treat `match_is_intentional_draw` and
`match_is_unintentional_draw` identically in math. The distinction is only useful
for:
- UI display ("Table 3 intentionally drew" vs "Table 3 drew on time")
- Calibrating historical ID rate defaults from real data

---

## Simulation — When Pairings Are Available

### Step 1 — Partition current round matches

```js
const knownMatches   = matches.filter(isKnown);   // result already reported
const unknownMatches = matches.filter(isUnknown);  // still in progress
```

Apply known match results as facts. Only simulate unknown matches.

`N = unknownMatches.length` — shrinks as the round progresses, improving accuracy
in real time as results trickle in.

### Step 2 — Classify unknown matches by ID probability

Assign each unknown match an ID probability based on both players' situations:

```
Both players locked (points guarantee top cut regardless of result):
  idProbability = 0.90

Both players locked but seeding matters:
  idProbability = 0.40   // worth playing for a better seed/bracket position

One player locked, one on bubble:
  idProbability = 0.10   // locked player may agree as a favour

Both players on bubble:
  idProbability = 0.03   // unintentional draws only — both need to win

Neither player near cut:
  idProbability = 0.02   // unintentional draws only
```

"Locked" = current points + 3 > projected cut line regardless of other results.
"On bubble" = current points + 3 >= target_points_if_id AND not locked.

These defaults are editable via Advanced Settings in the UI.

**For each unknown match, the 3 possible outcomes sum to 100%:**
```
ID probability:        idProbability
Player 1 wins:         (1 - idProbability) × 0.5
Player 2 wins:         (1 - idProbability) × 0.5
```

Wins are weighted equally (50/50) — no skill weighting applied.

### Step 3 — Choose simulation strategy

```
N = unknownMatches.length

N ≤ 12  →  Exhaustive enumeration (3^N combinations, max ~531k)
N > 12  →  Monte Carlo (1,000 weighted random samples)
```

**Why 3^N not 2^N for exhaustive:**
Each match has 3 outcomes (win/loss/draw). Excluding draws would
undercount realistic scenarios, especially at top tables where IDs are common.
3^12 = 531,441 combinations — acceptable performance (~300ms).

**Exhaustive with probability weighting:**
Even in exhaustive mode, each combination is weighted by the product of its
outcome probabilities when computing `makes_cut_pct`. This gives accurate
probability estimates rather than treating all combinations as equally likely.

```js
for (const combination of allCombinations) {
  const weight = combination.reduce((w, outcome) =>
    w * getProbability(outcome), 1.0);
  const rank = simulateAndRank(combination);
  weightedMakesCut += rank <= top_cut ? weight : 0;
  totalWeight += weight;
}
makes_cut_pct = (weightedMakesCut / totalWeight) * 100;
```

**Monte Carlo with probability weighting:**
Sample outcomes proportionally to their probability:

```js
for (let i = 0; i < 1000; i++) {
  const combination = unknownMatches.map(match => {
    const roll = Math.random();
    const idProb = getIdProbability(match);
    if (roll < idProb) return { type: 'draw', ...match };
    if (roll < idProb + (1 - idProb) * 0.5) return { type: 'win', winner: match.players[0], ...match };
    return { type: 'win', winner: match.players[1], ...match };
  });
  const rank = simulateAndRank(combination);
  if (rank <= top_cut) makes_cut++;
}
```

### Step 4 — Apply known match results

Before simulating, apply all known match results to the starting state:
- `winning_player` set → apply win/loss
- `match_is_intentional_draw || match_is_unintentional_draw` → apply draw

### Step 5 — Simulate each scenario

For each combination of unknown match outcomes:

1. Apply all point deltas:
    - Win: winner +3 points, loser +0
    - Draw (intentional or unintentional): both players +1 point
    - Target player's own match: treated as ID (+1 point each)
    - Bye: player gets +3 points

2. Recompute OMW% for every player:
    - Use updated win/match records including this round
    - Floor at 0.33
    - Only OMW% changes meaningfully within a single round

3. GW% and OGW% are not recalculated per scenario — too expensive and
   the within-round shift is small. Use values computed in Step 1.

4. Re-rank all players: points DESC → OMW% DESC → GW% DESC → OGW% DESC

5. Record target player's rank

### Step 6 — Aggregate results

```js
{
  total_scenarios,       // 3^N for exhaustive, 1000 for Monte Carlo
  makes_cut_scenarios,   // count of scenarios where rank <= top_cut
  makes_cut_pct,         // weighted percentage (exhaustive) or sampled (MC)
  best_rank,
  worst_rank,
  best_scenario,         // exhaustive only — null in Monte Carlo
  worst_scenario,        // exhaustive only — null in Monte Carlo
  simulation_mode,       // "exhaustive" or "monte_carlo"
  margin_of_error_pct,   // 0 for exhaustive, ~3.5 for Monte Carlo
  known_results,         // count of matches already reported this round
  unknown_results,       // count of matches still in progress (N)
}
```

---

## GW% Calculation (Full mode, always)

Fetch raw match data for all completed rounds. For each player:

```
For each completed match:
  - If winning_player == player_id:
      games_won   += games_won_by_winner
      games_played += games_won_by_winner + games_won_by_loser
  - Else if losing:
      games_won   += games_won_by_loser
      games_played += games_won_by_winner + games_won_by_loser
  - If match_is_bye:
      games_won   += 2
      games_played += 2
  - If match_is_intentional_draw OR match_is_unintentional_draw:
      skip — no game wins attributed (games_drawn is null for draws)

gw_pct = max(0.33, games_won / games_played)
```

---

## Response Format

```json
{
  "depth": "full",
  "pairings_available": true,
  "your_tiebreakers": {
    "omw_pct": 0.645,
    "gw_pct": 0.60,
    "ogw_pct": 0.633
  },
  "danger_players": [...],
  "simulation": {
    "simulation_mode": "exhaustive",
    "total_scenarios": 729,
    "makes_cut_scenarios": 584,
    "makes_cut_pct": 75.2,
    "margin_of_error_pct": 0,
    "best_rank": 4,
    "worst_rank": 11,
    "known_results": 5,
    "unknown_results": 6,
    "best_scenario": [
      {"type": "win", "winner": "ETB Kris", "loser": "🦈Dale"},
      {"type": "draw", "players": ["Levacryan", "RayLax"]}
    ],
    "worst_scenario": [...]
  }
}
```

When pairings not available: `"pairings_available": false`, `"simulation"` absent.

**Monte Carlo response omits `best_scenario` / `worst_scenario`** — sampled
extremes are not the true best/worst.

---

## Performance Budget

| Tournament size | Players | Unknown matches (N) | Strategy | Est. time |
|----------------|---------|--------------------|---------|-----------| 
| Local | 8-32 | 2-8 | Exhaustive 3^N | < 200ms |
| Regional | 64-128 | 8-12 | Exhaustive 3^N | < 500ms |
| Large regional | 256-512 | 13-30 | Monte Carlo | 1-2s |
| National | 2000+ | 50-150 | Monte Carlo | 2-4s |

Note: N shrinks as the round progresses — a large tournament mid-round may
fall back into exhaustive territory naturally.

Always show a loading spinner for Full mode. Response time is variable.

---

## Caching

| Data | Cache key | TTL |
|------|-----------|-----|
| Completed round matches | `matches:{round_id}` | 300s |
| Current round matches | `matches:current:{round_id}` | 30s |

30s TTL on current round matches balances freshness (picking up newly reported
results) with RPH load reduction during concurrent requests.

Cache is bypassed entirely when `override_round_id` or
`override_current_pairings_round_id` is set (testing mode).

---

## UI

### Depth selector

```
Analysis Depth:
● Simple
○ Full
```

Contextual notes:
- **Simple:** "Shows how many players can catch you. No tiebreaker data."
- **Full:** "Computes exact tiebreakers from match history. Simulates all current
  round outcomes when pairings are available. Updates as results come in."

### Advanced Settings (collapsed by default)

```
⚙️ Advanced Settings ▼

  Top table ID rate      [90%]   Both players locked, seeding doesn't matter
  Seeding matters        [ ]     Check if bracket seeding affects this event
  Bubble ID rate         [3% ]   Unintentional draws only — bubble players fight to win
  Monte Carlo samples    [1000]  Larger = more accurate but slower
```

When "Seeding matters" is checked, top table ID rate drops to 40%.

### Simulation result card

**While round is in progress:**
```
┌─────────────────────────────────┐
│  ── Simulation ──               │
│  6 of 11 matches complete       │
│  ████████░░░░░░ 55%             │
│                                 │
│  729 scenarios checked          │
│  75.2% you make top 8           │
│  Best case:  rank 4             │
│  Worst case: rank 11            │
│                                 │
│  Root for:                      │
│  ETB Kris to beat 🦈Dale        │
│  Levacryan & RayLax to draw     │
│                                 │
│  ⏱ Results from 45s ago         │
│  [ 🔄 Refresh ]                 │
└─────────────────────────────────┘
```

**When pairings not yet available:**
```
┌─────────────────────────────────┐
│  ── Simulation ──               │
│  ⏳ Pairings not yet posted     │
│                                 │
│  Check back once the organizer  │
│  generates round pairings.      │
│  Tiebreaker data shown above    │
│  is still valid.                │
└─────────────────────────────────┘
```

**Monte Carlo mode — add margin of error note:**
```
│  ~68.5% you make top 32         │
│  (±3.5% — 1,000 samples,        │
│   127 matches still in play)    │
```

### Refresh behaviour

Manual refresh only — no auto-refresh. Show staleness indicator:
- < 30s: no indicator
- 30s-2min: "⏱ Results from Xs ago"
- > 2min: "⏱ Results from Xm ago — consider refreshing"

Cache TTL of 30s means refreshing more often than that returns the same result
anyway — no need to throttle in the UI.

---

## Test Parameters

`override_round_id` pins standings to a specific completed round.
`override_current_pairings_round_id` pins current pairings to a specific round's
matches — allowing simulation testing with historical data.

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

Actual result: ryanfan finished 5th (22pts, 7-1-1). Previous simulation predicted
best case rank 6 — one-spot difference caused by non-bubble results not going chalk.
Cut verdict was correct: 100% of scenarios made top 32.

**Test validation result (run 2026-03-22 after full simulation rewrite):**

```json
{
  "simulation_mode": "exhaustive",
  "total_scenarios": 1,
  "makes_cut_scenarios": 1,
  "makes_cut_pct": 100,
  "best_rank": 6,
  "worst_rank": 6,
  "known_results": 84,
  "unknown_results": 0
}
```

**Finding:** Since round 9 is fully complete in historical data, all 84 matches are
classified as known results. `unknown_results: 0` → single deterministic scenario →
rank 6 predicted vs actual rank 5.

**Why still rank 6 (not 5):** GW% is computed from completed rounds only (rounds 1–8),
not updated with round 9 game results per scenario. ryanfan is tied at 22pts
post-round with FPG_Dragonjonz (GW% 0.933) and Level9001🦈 (GW% 0.824), both
beating ryanfan's 0.70 on GW%. In the actual final standings, RPH computed GW%
with round 9 games included, shifting the ordering enough to place ryanfan 5th.
This is the known GW% limitation — within-round game results are not tracked
per scenario because it is too expensive.

**Conclusion:** The 1-spot drift is a GW% staleness artifact, not a logic bug.
The new simulation's improvements (ID probability weighting, 3-outcome draws,
all matches simulated) are only observable during a live round with unknown matches
in progress. This historical test cannot demonstrate them — both old and new code
produce rank 6 deterministically when `unknown_results: 0`.

---

## Root For — Filtering

`best_scenario` from exhaustive mode contains ALL unknown matches (up to 12 at the
threshold), but most of those matches don't directly affect whether the target player
makes cut. Showing 12 "root for" items is noisy and confusing.

**Rule:** Only show matches where at least one player is classified as `bubble`
(i.e. `pts + 3 >= targetPointsAfterID`). These are the matches whose outcome can
directly move a player past the target.

**What to exclude:**
- Both players `locked` (they're already safe — their result doesn't threaten the target)
- Both players `other` (they can't reach the target's points tier regardless)
- Matches where the beneficial outcome is "root for X to beat Y so Y's opponents'
  OMW% drops slightly" — this is a second-order tiebreaker effect and too indirect
  to be actionable

**Implementation:** In `scenarioToNames` (or the caller), filter the outcome list
before returning `best_scenario`:

```js
const bubbleOutcomes = outcomes.filter(({ p1, p2 }) =>
  classifyPlayer(p1) === 'bubble' || classifyPlayer(p2) === 'bubble'
);
```

`classifyPlayer` must be in scope — move the filter to inside `computeFullPlus`
where `classifyPlayer` is defined, before calling `scenarioToNames`.

**Edge case:** If no bubble players appear in unknown matches (all bubble matches
were already decided), `best_scenario` returns `[]` and "Root for" section is
hidden — this is correct behaviour.

---

## Build Order

1. ✅ Update match classification to use confirmed RPH status values
2. ✅ Implement 3-outcome simulation (win/loss/draw) replacing 2-outcome
3. ✅ Implement ID probability weighting per match
4. ✅ Update exhaustive threshold from 2^12 to 3^12
5. ✅ Update Monte Carlo to sample from 3 weighted outcomes
6. ✅ Add Advanced Settings to UI (ID rate sliders, seeding checkbox)
7. ✅ Update result card to show known/unknown match counts and progress bar
8. ✅ Add staleness indicator and manual Refresh button
9. ✅ Test with event 199148 override — rank 6 predicted, actual rank 5, GW% staleness artifact confirmed
10. Filter best_scenario / worst_scenario to bubble matches only before returning