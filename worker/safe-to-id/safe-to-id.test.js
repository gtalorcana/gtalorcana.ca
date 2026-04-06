/**
 * Safe to ID — Unit Tests
 *
 * TODO: set up Vitest (or Jest) and extract the pure analysis functions
 * from index.js into a testable module. Tests below cover the cases we've
 * validated manually and the bugs we've fixed.
 *
 * Setup:
 *   npm install -D vitest
 *   extract analyzeStandings(), computeExpectedDanger(), runSimulation(),
 *   computeTiebreakers() etc. into analysis.js
 *   import them here and mock the RPH fetch calls with fixture JSON
 */

// import { describe, it, expect } from 'vitest';
// import { analyzeStandings, runSimulation } from './analysis.js';
// import standingsR3   from './fixtures/round-651005-standings.json'; // round 4 standings
// import matchesR4     from './fixtures/round-651005-matches.json';   // round 4 pairings

// ── OMW% correctness ──────────────────────────────────────────────────────────

// TODO: verify OMW% formula matches RPH exactly for all 11 players in event
// 404135 after round 4.
//
// Formula: average of max(0.33, opp_pts / (3 × rounds_played)) across all
// non-bye opponents. Verified manually with curl + node against live standings.
//
// test('OMW% matches RPH for all players at event 404135 R4', () => { ... });

// TODO: verify byes are excluded from opponent list in OMW% calculation.
// Neil, Sleepy_Butterfly, and Lateforclass each had 1 bye → 3 opponents, not 4.
//
// test('bye opponents are excluded from OMW% calculation', () => { ... });

// ── Target match result ───────────────────────────────────────────────────────

// TODO: when target player's current-round match is already complete with a
// loss (+0 pts), the simulation must use +0, not assume an ID (+1).
//
// Regression: ryanfan lost their R4 match at event 404135. Before the fix,
// knownPtDelta[targetPlayerId] was always set to 1 (ID assumed), causing the
// simulation to show ryanfan in 4th when they actually finished 7th.
//
// test('simulation uses actual result when target match is already done (loss)', () => { ... });
// test('simulation uses actual result when target match is already done (win)', () => { ... });
// test('simulation uses actual result when target match is already done (draw)', () => { ... });

// ── Exhaustive simulation weighting ──────────────────────────────────────────

// TODO: each scenario in exhaustive simulation must be weighted by the product
// of its per-outcome probabilities, not counted equally.
//
// Regression: before the fix, all 3^N scenarios were weighted 1 each, giving
// equal weight to a 90%-probable ID and a 10%-probable decisive result.
//
// test('exhaustive simulation weights scenarios by probability', () => { ... });
// test('weighted makes_cut_pct differs from unweighted count for same input', () => { ... });

// ── Danger count / expected danger ───────────────────────────────────────────

// TODO: simple mode danger count — player with max_possible_points < threshold
// is not a danger player.
//
// test('simple: player who cannot reach target score is not a danger', () => { ... });
// test('simple: player already above target score counts toward already-above set', () => { ... });

// TODO: full mode expected danger — sum of per-player win probabilities is
// always lower than raw danger count due to zero-sum pairing constraints.
//
// test('full: expected danger < danger count for realistic inputs', () => { ... });

// ── Simulation verdict thresholds ────────────────────────────────────────────

// TODO: simulation verdict boundaries.
//
// test('simulation verdict is SAFE when makes_cut_pct >= 70', () => { ... });
// test('simulation verdict is RISKY when makes_cut_pct >= 40 and < 70', () => { ... });
// test('simulation verdict is UNSAFE when makes_cut_pct < 40', () => { ... });

// ── EVENT_COMPLETE guard ──────────────────────────────────────────────────────

// TODO: when event_lifecycle_status === 'EVENT_COMPLETE', the analyze endpoint
// should return an error rather than running analysis (Swiss is over, no IDs
// to evaluate).
//
// test('analyze returns error for completed events', () => { ... });

// ── Dropped players ───────────────────────────────────────────────────────────

// TODO: dropped players must be excluded from danger counts and simulation
// but their historical results still count toward opponents' OMW%.
//
// test('dropped players are excluded from danger list', () => { ... });
// test('dropped player results still count in OMW% for their opponents', () => { ... });
