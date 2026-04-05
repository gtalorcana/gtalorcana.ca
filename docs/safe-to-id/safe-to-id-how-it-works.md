# Safe to ID? — How It Works

## What is an Intentional Draw?

In Swiss-format tournaments, two players can agree to an **Intentional Draw (ID)** instead of playing their match. Both players receive 1 match point each, compared to the winner of a played match receiving 3. Players consider IDing when they believe the 1 guaranteed point is safer than risking a loss for the chance at 3.

---

## The Core Question

The tool asks: **if you take an ID and finish this round with X points, how likely is it that too many other players also reach X points and bump you out of the top cut?**

---

## Step 1 — Danger Players

A **danger player** is any other active player in the event who can mathematically reach or exceed your projected points by winning their remaining rounds:

```
maxPossiblePoints = currentPoints + (roundsRemaining × 3)
isDanger = maxPossiblePoints >= yourPointsAfterID
```

A player already above your projected score counts toward the danger total immediately. A player who can only reach it by winning out is a potential danger.

**Danger count** is the number of players who can catch you but aren't already above you:

```
dangerCount = players who can reach yourPointsAfterID
            - players already above yourPointsAfterID
```

---

## Step 2 — Simple Verdict

Simple mode compares `dangerCount` directly to the top-cut size:

| Condition | Verdict |
|-----------|---------|
| dangerCount < top cut | ✅ SAFE |
| dangerCount = top cut | ⚠️ RISKY |
| dangerCount > top cut | ❌ UNSAFE |

This is a conservative upper bound — it assumes every danger player wins out, which requires them all to beat each other (impossible when they're paired together).

---

## Step 3 — Expected Danger (Full Mode)

Full mode replaces the raw count with a **probability-weighted expected danger**. Each danger player is weighted by their statistical probability of actually winning enough rounds to catch you.

Per-round outcome probabilities assumed:
- Win (+3 points): **47.5%**
- Draw (+1 point): **5%**
- Loss (+0 points): **47.5%**

The probability of gaining at least *gap* points across *n* rounds is computed by dynamic programming over all possible point totals. The sum across all danger players gives `expectedDanger`.

The verdict thresholds shift accordingly:

| Condition | Verdict |
|-----------|---------|
| expectedDanger < top_cut − 1 | ✅ SAFE |
| expectedDanger < top_cut + 1 | ⚠️ RISKY |
| expectedDanger ≥ top_cut + 1 | ❌ UNSAFE |

Expected danger is almost always lower than the raw count because zero-sum pairing constraints prevent all danger players from winning simultaneously.

---

## Step 4 — Tiebreakers (Full Mode)

When players finish Swiss with the same match points, Ravensburger uses three tiebreakers in order:

### OMW% — Opponent Match Win Percentage
Average of your opponents' match win rates. Playing against stronger opponents raises this.

**Formula:**
```
OMW% = average over all opponents of:
  max(33%, opponent's final points ÷ (3 × rounds played))
```

The 33% floor prevents a string of opponents with losing records from dragging your OMW% below a baseline. This is RPH's exact formula, verified against live event standings.

### GW% — Game Win Percentage
Your own percentage of individual games won across all matches.

```
GW% = max(33%, games you won ÷ total games played)
```

Note: `game_win_percentage` is not reported in RPH standings — the tool computes it from raw match data.

### OGW% — Opponent Game Win Percentage
Average of your opponents' game win percentages.

**Tiebreaker comparison:** For each danger player, the tool compares their tiebreaker values to yours. A difference of less than 1% is considered "too close to call" (😬). Otherwise:
- 😰 = they beat you on this tiebreaker
- 😌 = you beat them

---

## Step 5 — Simulation (Full Mode, Final Round)

When pairings are available for the current round, the tool runs a **probabilistic simulation** to compute your exact chance of making cut across all realistic outcomes.

### How matches are categorised

Each player is classified relative to your projected final points:

| Class | Condition | ID probability |
|-------|-----------|----------------|
| **Locked** | Already at or above your points | ~90% (they can ID safely) |
| **Bubble** | Can reach your points with a win | ~3% (they need to win) |
| **Other** | Can't reach your points | ~2% (unintentional draws only) |

Matches between a locked and a non-locked player use ~10% ID probability.

### Per-scenario outcome probabilities

For each unknown match:
```
Draw (ID)       = idProbability
Player 1 wins   = (1 − idProbability) × 50%
Player 2 wins   = (1 − idProbability) × 50%
```

Decisive outcomes are modelled as 50/50 (skill not factored in).

### Exhaustive vs Monte Carlo

| Unknown matches | Method | Detail |
|----------------|--------|--------|
| ≤ 12 | Exhaustive | Every 3^N combination checked, weighted by probability |
| > 12 | Monte Carlo | 1,000 samples drawn from probability distribution; ±3.5% margin of error |

Each exhaustive scenario is weighted by the product of its individual outcome probabilities, so a locked-vs-locked ID (90% likely) contributes far more to the final percentage than the scenario where those same players played it out.

### Ranking in each scenario

For each combination of outcomes, the tool recomputes:
1. Final points for every player
2. OMW% for every player using the simulated final points
3. GW% (taken from match history; not recomputed per scenario)
4. OGW% (from standings; not recomputed per scenario)

Players are ranked by points → OMW% → GW% → OGW%. The tool records whether you land inside the top cut.

### Simulation verdict thresholds

| makes_cut_pct | Verdict |
|---------------|---------|
| ≥ 70% | ✅ SAFE |
| ≥ 40% | ⚠️ RISKY |
| < 40% | ❌ UNSAFE |

---

## When your match is already done

If your round result is already recorded before you run the tool, the simulation uses your **actual result** (win/loss/draw) rather than assuming a hypothetical ID. The verdict label changes to **"Make top cut?"** and opponent analysis is hidden since there's no ID offer to evaluate.

---

## Known Limitations

- **Skill is ignored.** Win probability is 50/50 for all players.
- **ID rates are estimates.** The 90% locked and 3% bubble rates are based on typical tournament behaviour, not observed data for this specific event.
- **Tiebreakers shift.** GW% and OGW% values reflect the last completed round. They update on refresh as the current round finishes.
- **Multi-phase (DLC) events** are not fully supported. The tool analyses the primary Swiss phase only.
- **This is a probability estimate, not a guarantee.** Use it as one input among many — your read of specific matchups and player tendencies matters too.
