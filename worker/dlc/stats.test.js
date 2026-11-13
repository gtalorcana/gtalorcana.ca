// Run: node --test worker/dlc/
//
// Two kinds of test:
//   - a tiny hand-built event where every number can be checked by eye
//   - the saved fixture of DLC London Main Event 1 (event 1254364)
//
// Fixture numbers are only asserted for rounds saved as final — the snapshot
// tool never refetches those, so they stay put when the fixture is refreshed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIndex, listScopes, matchesIn, classify, matchupMatrix, deckStats, metaByRound,
  conversion, playerHistory, searchPlayers, dropsByRound, matchWinRate, gameWinRate,
  deckLabel, deckShort, UNKNOWN, leadersByDeck, bestOfRace,
} from '../../dlc/stats.js';
import { slimMatch, slimEvent, inkPair, mergePlayers } from './slim.js';
import { loadFixture } from './tools/fixture.mjs';

// ── Hand-built event ─────────────────────────────────────────────────────────
// Phase 1 (Swiss, 2 rounds), Phase 2 (Swiss, 1 round), Phase 3 (top cut, 1 round).
// Players 1,2 = amber,emerald (AE) · 3,4 = emerald,steel (ES) · 5 = amethyst,ruby (AR)
// 6 = no deck label · 7 = AE, gets an awarded loss and vanishes.

const AE = 'amber,emerald', ES = 'emerald,steel', AR = 'amethyst,ruby';
const win = (id, t, winner, loser, g = [2, 0, 0]) => ({ id, t, d: 1, p: [winner, loser], w: winner, g });

const tiny = {
  meta: {
    id: 1, name: 'Tiny',
    phases: [
      { id: 10, name: 'Phase 1', order: 1, round_type: 'SWISS', rounds: [
        { id: 101, number: 1, status: 'COMPLETE' }, { id: 102, number: 2, status: 'COMPLETE' }] },
      { id: 20, name: 'Phase 2', order: 2, round_type: 'SWISS', rounds: [
        { id: 201, number: 1, status: 'IN_PROGRESS' }] },
      { id: 30, name: 'Phase 3', order: 3, round_type: 'RANKED_SINGLE_ELIMINATION', rounds: [] },
    ],
  },
  players: {
    1: { h: 'alpha', ink: AE }, 2: { h: 'Alphabet', ink: AE }, 3: { h: 'cee', ink: ES },
    4: { h: 'dee', ink: ES }, 5: { h: 'eve', ink: AR }, 6: { h: 'mystery', ink: null },
    7: { h: 'ghost', ink: AE },
  },
  rounds: {
    101: { status: 'final', matches: [
      win(1, 1, 1, 3, [2, 1, 0]),                                  // AE beats ES 2-1
      win(2, 2, 2, 4),                                             // AE beats ES 2-0
      { id: 3, t: 3, d: 1, p: [5, 6], w: null, g: [1, 1, 1], k: 'ud' }, // AR draws Unknown 1-1-1
      { id: 4, t: 0, d: 1, p: [7], w: null, g: null, k: 'loss' },  // awarded loss
    ] },
    102: { status: 'final', matches: [
      win(5, 1, 1, 2, [2, 1, 0]),                                  // AE mirror
      win(6, 2, 3, 5),                                             // ES beats AR 2-0
      { id: 7, t: 3, d: 1, p: [4, 6], w: null, g: [0, 0, 3], k: 'id' }, // ES IDs with Unknown
    ] },
    201: { status: 'partial', matches: [
      win(8, 1, 3, 1),                                             // ES beats AE 2-0
      { id: 9, t: 2, d: 0, p: [2, 5], w: null, g: null },          // still playing
      { id: 10, t: 0, d: 1, p: [4], w: 4, g: null, k: 'bye' },     // bye
    ] },
  },
};
const ti = buildIndex(tiny);

test('index numbers rounds across phases and labels the top cut', () => {
  assert.deepEqual(ti.rounds.map(r => [r.id, r.seq, r.phase.name]), [
    [101, 1, 'Phase 1'], [102, 2, 'Phase 1'], [201, 3, 'Phase 2'],
  ]);
  assert.equal(ti.phases[2].label, 'Top cut (Phase 3)');
});

test('scopes: whole event, each phase with data, each round with data', () => {
  assert.deepEqual(listScopes(ti).map(s => s.key),
    ['all', 'phase:10', 'phase:20', 'round:101', 'round:102', 'round:201']);
  assert.equal(matchesIn(ti, 'all').length, 10);
  assert.equal(matchesIn(ti, 'phase:10').length, 7);
  assert.equal(matchesIn(ti, 'round:201').length, 3);
  assert.equal(matchesIn(ti, 'round:999').length, 0);
});

test('classify', () => {
  const kinds = matchesIn(ti, 'all').map(classify);
  assert.deepEqual(kinds, ['win', 'win', 'draw', 'noshow', 'win', 'win', 'draw', 'win', 'pending', 'bye']);
});

test('matrix: byes, awarded losses and unfinished matches are excluded', () => {
  const mx = matchupMatrix(ti, 'all');
  assert.equal(mx.counted, 7);
  assert.deepEqual(mx.excluded, { bye: 1, noshow: 1, pending: 1 });
});

test('matrix: cells hold both win rates and the sample size', () => {
  const mx = matchupMatrix(ti, 'all');
  // AE vs ES: two wins in round 1 (2-1, 2-0), one loss in round 3 (0-2).
  assert.deepEqual(mx.cells[AE][ES], { n: 3, w: 2, l: 1, d: 0, gw: 4, gl: 3, gd: 0 });
  assert.deepEqual(mx.cells[ES][AE], { n: 3, w: 1, l: 2, d: 0, gw: 3, gl: 4, gd: 0 });
  assert.equal(matchWinRate(mx.cells[AE][ES]), 2 / 3);
  assert.equal(gameWinRate(mx.cells[AE][ES]), 4 / 7);
});

test('matrix: draws are counted separately and leave the win rate undefined', () => {
  const mx = matchupMatrix(ti, 'all');
  assert.deepEqual(mx.cells[AR][UNKNOWN], { n: 1, w: 0, l: 0, d: 1, gw: 1, gl: 1, gd: 1 });
  assert.equal(matchWinRate(mx.cells[AR][UNKNOWN]), null);
  assert.deepEqual(mx.cells[ES][UNKNOWN], { n: 1, w: 0, l: 0, d: 1, gw: 0, gl: 0, gd: 3 });
});

test('matrix: mirrors are a count on the diagonal, not a cell', () => {
  const mx = matchupMatrix(ti, 'all');
  assert.deepEqual(mx.mirrors, { [AE]: 1 });
  assert.equal(mx.cells[AE][AE], undefined);
  assert.equal(mx.totals[AE].n, 3); // the mirror is not in the totals either
});

test('matrix: unknown decks sort last, the rest by matches played', () => {
  assert.deepEqual(matchupMatrix(ti, 'all').decks, [AE, ES, AR, UNKNOWN]);
});

test('matrix: filtering by round changes the sample', () => {
  const mx = matchupMatrix(ti, 'round:101');
  assert.equal(mx.counted, 3);
  assert.deepEqual(mx.cells[AE][ES], { n: 2, w: 2, l: 0, d: 0, gw: 4, gl: 1, gd: 0 });
});

test('deck stats: share counts distinct players, including byes and awarded losses', () => {
  const { total, rows } = deckStats(ti, 'all');
  assert.equal(total, 7);
  const ae = rows.find(r => r.deck === AE);
  assert.equal(ae.players, 3);
  assert.equal(ae.share, 3 / 7);
  assert.equal(ae.mirror, 1);
  assert.equal(ae.mwr, 2 / 3);
  assert.equal(rows.at(-1).deck, UNKNOWN);
});

test('meta by round counts players per deck in that round only', () => {
  const [r1, , r3] = metaByRound(ti);
  assert.equal(r1.total, 7);
  assert.deepEqual(r1.decks, { [AE]: 3, [ES]: 2, [AR]: 1, [UNKNOWN]: 1 });
  assert.equal(r3.total, 5);
});

test('conversion: advancing is read from the next phase pairings', () => {
  const conv = conversion(ti);
  assert.equal(conv.length, 1); // Phase 3 has no pairings yet
  const [c] = conv;
  assert.equal(c.from.name, 'Phase 1');
  assert.equal(c.entered, 7);
  assert.equal(c.advanced, 5);
  const ae = c.rows.find(r => r.deck === AE);
  assert.deepEqual([ae.entered, ae.advanced, ae.rate], [3, 2, 2 / 3]);
  assert.equal(c.rows.find(r => r.deck === UNKNOWN).advanced, 0);
});

test('player history is rebuilt from results, in round order', () => {
  const h = playerHistory(ti, 3);
  assert.deepEqual(h.rows.map(r => [r.round.seq, r.result, r.score, r.opp.handle, r.opp.deck, r.record]), [
    [1, 'L', '1-2', 'alpha', AE, '0-1-0'],
    [2, 'W', '2-0', 'eve', AR, '1-1-0'],
    [3, 'W', '2-0', 'alpha', AE, '2-1-0'],
  ]);
  assert.equal(h.points, 6);
});

test('player history: draws, byes, awarded losses, live matches', () => {
  assert.deepEqual(playerHistory(ti, 4).rows.map(r => [r.result, r.score, r.record]), [
    ['L', '0-2', '0-1-0'], ['D', '0-0-3', '0-1-1'], ['BYE', null, '1-1-1'],
  ]);
  const ghost = playerHistory(ti, 7);
  assert.deepEqual(ghost.rows.map(r => [r.result, r.awarded, r.opp]), [['L', true, null]]);
  assert.equal(playerHistory(ti, 2).rows.at(-1).result, 'LIVE');
  assert.equal(playerHistory(ti, 2).record, '1-1-0'); // a live match changes nothing
  assert.deepEqual(playerHistory(ti, 5).rows[0].score, '1-1-1');
});

test('player search is by handle, case-insensitive, prefix first', () => {
  assert.deepEqual(searchPlayers(ti, 'ALPHA').map(p => p.handle), ['alpha', 'Alphabet']);
  assert.deepEqual(searchPlayers(ti, 'e').map(p => p.handle).slice(0, 1), ['eve']);
  assert.deepEqual(searchPlayers(ti, '  '), []);
});

test('drops: players never paired again; unknown for the latest round', () => {
  const d = dropsByRound(ti);
  assert.deepEqual(d.map(x => [x.round.seq, x.players, x.left, x.phaseEnd]), [
    [1, 7, 1, false],   // the ghost
    [2, 6, 1, true],    // mystery did not continue into Phase 2
    [3, 5, null, false],
  ]);
});

test('deck labels', () => {
  assert.equal(deckLabel(AE), 'Amber / Emerald');
  assert.equal(deckShort('amethyst,steel'), 'Ay/St');
  assert.equal(deckLabel(UNKNOWN), 'Unknown');
});

// ── Slimming raw RPH records ─────────────────────────────────────────────────

const rawRel = (id, order, handle, value) => ({
  player_order: order,
  player: { id, best_identifier: 'Aaron B' },
  user_event_status: {
    best_identifier: handle,
    deck_descriptor_label: value == null ? null : { parts: [{ value, symbols: [{ image_url: 'https://signed.example/x' }] }] },
  },
});

test('slimMatch keeps ids, handles and ink names — never URLs or "First L" names', () => {
  const { match, players } = slimMatch({
    id: 9, table_number: 4, status: 'COMPLETE', players: [11, 22], winning_player: 22,
    games_won_by_winner: 2, games_won_by_loser: 1, games_drawn: 0,
    player_match_relationships: [rawRel(22, 2, 'two', 'steel,amber'), rawRel(11, 1, 'one', null)],
  });
  assert.deepEqual(match, { id: 9, t: 4, d: 1, p: [11, 22], w: 22, g: [2, 1, 0] });
  assert.deepEqual(players, [[11, { h: 'one', ink: null }], [22, { h: 'two', ink: 'amber,steel' }]]);
  assert.ok(!JSON.stringify({ match, players }).includes('http'));
  assert.ok(!JSON.stringify({ match, players }).includes('Aaron'));
});

test('slimMatch: bye vs awarded loss are both one-player matches', () => {
  const base = { id: 1, status: 'COMPLETE', players: [5], player_match_relationships: [rawRel(5, 1, 'x', 'ruby,steel')] };
  assert.equal(slimMatch({ ...base, match_is_bye: true, winning_player: 5 }).match.k, 'bye');
  assert.equal(slimMatch({ ...base, match_is_loss: true, winning_player: null }).match.k, 'loss');
});

test('inkPair normalises order and case', () => {
  assert.equal(inkPair({ deck_descriptor_label: { parts: [{ value: 'Steel, amber' }] } }), 'amber,steel');
  assert.equal(inkPair({ deck_descriptor_label: null }), null);
  assert.equal(inkPair(undefined), null);
});

test('mergePlayers reports changes and never forgets a known ink pair', () => {
  const map = {};
  assert.equal(mergePlayers(map, [[1, { h: 'a', ink: AE }]]), true);
  assert.equal(mergePlayers(map, [[1, { h: 'a', ink: AE }]]), false);
  assert.equal(mergePlayers(map, [[1, { h: 'a', ink: null }]]), false);
  assert.equal(map[1].ink, AE);
});

test('slimEvent reads structure from the API; upcoming phases have no rounds', () => {
  const e = slimEvent({
    id: 7, name: 'X', starting_player_count: 10,
    tournament_phases: [
      { id: 2, phase_name: 'Phase 2', order_in_phases: 2, round_type: 'SWISS', status: 'UPCOMING', number_of_rounds: 7 },
      { id: 1, phase_name: 'Phase 1', order_in_phases: 1, round_type: 'SWISS', status: 'IN_PROGRESS', number_of_rounds: 8,
        rounds: [{ id: 12, round_number: 2, status: 'UPCOMING', pairings_status: 'NOT_GENERATED' },
                 { id: 11, round_number: 1, status: 'COMPLETE', pairings_status: 'GENERATED', standings_status: 'GENERATED' }] },
    ],
  });
  assert.deepEqual(e.phases.map(p => p.id), [1, 2]);
  assert.deepEqual(e.phases[0].rounds.map(r => [r.id, r.pairings, r.standings]), [[11, true, true], [12, false, false]]);
  assert.deepEqual(e.phases[1].rounds, []);
});

// ── Fixture: DLC London Main Event 1 ─────────────────────────────────────────

const { dataset, standings } = loadFixture(1254364);
const fx = buildIndex(dataset);
const R1 = 'round:1582171', R2 = 'round:1582172';

test('fixture: structure comes from the event record', () => {
  assert.equal(dataset.meta.name, 'DLC London: Main Event 1');
  assert.equal(dataset.meta.player_count, 1633);
  assert.equal(fx.rounds[0].id, 1582171);
  assert.equal(fx.rounds[0].stored, 'final');
});

test('fixture: round 1 — 817 pairings, 1 bye, 15 draws', () => {
  const ms = matchesIn(fx, R1);
  assert.equal(ms.length, 817);
  const kinds = Object.groupBy(ms, classify);
  assert.equal(kinds.bye.length, 1);
  assert.equal(kinds.draw.length, 15);
  assert.equal(kinds.win.length, 801);
  const mx = matchupMatrix(fx, R1);
  assert.equal(mx.counted, 816);
  assert.deepEqual(mx.excluded, { bye: 1, noshow: 0, pending: 0 });
});

test('fixture: round 2 — awarded losses are not byes', () => {
  const kinds = Object.groupBy(matchesIn(fx, R2), classify);
  assert.equal(kinds.bye.length, 1);
  assert.equal(kinds.noshow.length, 4);
});

test('fixture: all 1,633 players are paired in round 1, keyed by id', () => {
  const ids = new Set(matchesIn(fx, R1).flatMap(m => m.p));
  assert.equal(ids.size, 1633);
  for (const id of ids) assert.ok(dataset.players[id]?.h, `player ${id} has a handle`);
});

test('fixture: no URLs are stored anywhere', () => {
  assert.ok(!JSON.stringify(dataset).includes('http'));
});

test('fixture: the matrix is symmetric in every scope', () => {
  for (const { key } of listScopes(fx)) {
    const mx = matchupMatrix(fx, key);
    let sides = 0;
    for (const a of mx.decks) {
      for (const b of mx.decks) {
        if (a === b) continue;
        const ab = mx.cells[a]?.[b], ba = mx.cells[b]?.[a];
        assert.equal(!!ab, !!ba);
        if (!ab) continue;
        assert.deepEqual([ab.n, ab.w, ab.l, ab.d, ab.gw, ab.gl], [ba.n, ba.l, ba.w, ba.d, ba.gl, ba.gw], `${key} ${a} vs ${b}`);
        sides += ab.n;
      }
    }
    const mirrors = Object.values(mx.mirrors).reduce((s, n) => s + n, 0);
    assert.equal(sides / 2 + mirrors, mx.counted, `${key}: every counted match is in exactly one place`);
    assert.equal(mx.counted + mx.excluded.bye + mx.excluded.noshow + mx.excluded.pending, matchesIn(fx, key).length);
  }
});

test('fixture: whole-event matrix is the sum of the round matrices', () => {
  const all = matchupMatrix(fx, 'all');
  const perRound = fx.rounds.filter(r => r.matches.length).map(r => matchupMatrix(fx, `round:${r.id}`));
  assert.equal(all.counted, perRound.reduce((s, m) => s + m.counted, 0));
  const [a, b] = all.decks;
  assert.equal(all.cells[a][b].w, perRound.reduce((s, m) => s + (m.cells[a]?.[b]?.w ?? 0), 0));
});

test('fixture: round 1 meta share', () => {
  const { total, rows } = deckStats(fx, R1);
  assert.equal(total, 1633);
  assert.equal(rows[0].deck, 'amber,emerald');
  assert.equal(rows.reduce((s, r) => s + r.players, 0), 1633);
  assert.ok(Math.abs(rows.reduce((s, r) => s + r.share, 0) - 1) < 1e-9);
});

// The strongest check we have: records rebuilt from match results must equal
// the per-round record RPH publishes in standings, for every player.
test('fixture: rebuilt records match RPH standings in every completed round', () => {
  const checked = [];
  for (const round of fx.rounds) {
    const rows = standings[round.id]?.rows;
    if (!rows) continue;
    for (const s of rows) {
      const upTo = playerHistory(fx, s.p).rows.filter(r => r.round.seq <= round.seq).at(-1);
      assert.equal(upTo?.record ?? '0-0-0', s.rec, `player ${s.p} after ${round.label}`);
      assert.equal(upTo?.points ?? 0, s.pts, `player ${s.p} points after ${round.label}`);
    }
    checked.push(round.seq);
  }
  assert.ok(checked.length >= 5, 'at least rounds 1-5 have standings');
});

test('fixture: drops per round', () => {
  const d = dropsByRound(fx);
  assert.deepEqual(d.slice(0, 2).map(x => x.players), [1633, 1565]);
  assert.equal(d[0].left, 68);
  assert.equal(d.at(-1).left, null);
});

test('fixture: two players sharing a "First L" name stay separate people', () => {
  const byHandle = Object.groupBy(Object.entries(dataset.players), ([, p]) => p.h.toLowerCase());
  const dupes = Object.values(byHandle).filter(g => g.length > 1);
  // Handles can collide too; ids never do, and history is per id.
  for (const group of dupes.slice(0, 5)) {
    const histories = group.map(([id]) => playerHistory(fx, Number(id)));
    assert.equal(new Set(histories.map(h => h.id)).size, group.length);
  }
});

// ── Best of each ink pair ────────────────────────────────────────────────────

test('leaders: top of each ink pair by standings rank, unknown decks left out', () => {
  const rows = [
    { r: 3, p: 2, pts: 3, rec: '1-1-0', omw: 0.5 }, { r: 1, p: 3, pts: 6, rec: '2-0-0', omw: 0.6 },
    { r: 2, p: 1, pts: 6, rec: '2-0-0', omw: 0.5 }, { r: 4, p: 6, pts: 2, rec: '0-0-2', omw: 0.4 },
    { r: 5, p: 7, pts: 0, rec: '0-1-0', omw: 0.3 },
  ];
  const out = leadersByDeck(ti, rows, 2);
  assert.deepEqual(out.map(g => [g.deck, g.players]), [[ES, 1], [AE, 3]]);
  assert.deepEqual(out[1].leaders.map(l => [l.rank, l.handle, l.behind]), [[2, 'alpha', 0], [3, 'Alphabet', 3]]);
});

test('fixture: every labelled ink pair has a leader, ranked in order', () => {
  const rows = standings[1582175].rows;
  const out = leadersByDeck(fx, rows, 3);
  assert.equal(out.length, 15);
  assert.equal(out[0].leaders[0].rank, 1);
  assert.equal(out.reduce((s, g) => s + g.players, 0) + rows.filter(s => !dataset.players[s.p]?.ink).length, 1633);
  for (const g of out) assert.deepEqual(g.leaders.map(l => l.rank), g.leaders.map(l => l.rank).sort((a, b) => a - b));
});

// ── Best-of race ─────────────────────────────────────────────────────────────
// One 4-round Swiss phase. Standings are after round 2, so 2 rounds (6 points)
// remain. Everyone was paired in round 2 except player 9, who dropped.

function raceIndex(phases) {
  const ink = { 1: AE, 2: AE, 3: AE, 4: ES, 5: ES, 6: AR, 7: AR, 8: AR, 9: AR };
  const pair = (id, a, b) => ({ id, t: id, d: 1, p: [a, b], w: a, g: [2, 0, 0] });
  return buildIndex({
    meta: { phases },
    players: Object.fromEntries(Object.entries(ink).map(([id, i]) => [id, { h: 'p' + id, ink: i }])),
    rounds: {
      11: { status: 'final', matches: [pair(1, 1, 2), pair(2, 3, 4), pair(3, 5, 6), pair(4, 7, 8), { id: 5, t: 0, d: 1, p: [9], w: 9, g: null, k: 'bye' }] },
      12: { status: 'final', matches: [pair(6, 1, 3), pair(7, 2, 4), pair(8, 5, 7), pair(9, 6, 8)] },
    },
  });
}
const swiss4 = { id: 1, name: 'Phase 1', order: 1, round_type: 'SWISS', rounds_planned: 4, rounds: [{ id: 11, number: 1 }, { id: 12, number: 2 }] };
const swiss3 = { id: 2, name: 'Phase 2', order: 2, round_type: 'SWISS', rounds_planned: 3, rounds: [] };
const raceRows = [
  { r: 1, p: 1, pts: 12 }, { r: 2, p: 2, pts: 5 }, { r: 3, p: 3, pts: 3 },                        // AE
  { r: 4, p: 4, pts: 9 }, { r: 5, p: 5, pts: 3 },                                                // ES
  { r: 6, p: 6, pts: 6 }, { r: 7, p: 7, pts: 3 }, { r: 8, p: 8, pts: 0 }, { r: 9, p: 9, pts: 6 }, // AR
];
const statusOf = race => Object.fromEntries(race.groups.map(g => [g.deck, g.status]));

test('race: final phase — locked, tiebreak only, open by points arithmetic', () => {
  const race = bestOfRace(raceIndex([swiss4]), raceRows, 12);
  assert.equal(race.roundsLeft, 2);
  assert.equal(race.rule, null);
  // AE: 12 vs best case 11. ES: 9 vs best case 9. AR: 6 vs best case 9.
  assert.deepEqual(statusOf(race), { [AE]: 'locked', [ES]: 'tiebreak', [AR]: 'open' });
  const ar = race.groups.find(g => g.deck === AR);
  assert.equal(ar.threats, 3);
  assert.deepEqual(ar.leaders.map(l => [l.id, l.max, l.canCatch]), [[6, 12, null], [7, 9, true], [8, 6, 'tie'], [9, 6, 'tie']]);
});

test('race: a dropped player cannot gain points', () => {
  const race = bestOfRace(raceIndex([swiss4]), raceRows, 12);
  assert.equal(race.groups.find(g => g.deck === AR).leaders.find(l => l.id === 9).max, 6);
});

test('race: points needed for the next phase decide who stays alive', () => {
  const race = bestOfRace(raceIndex([swiss4, swiss3]), raceRows, 12, { advancePoints: { 1: 12 } });
  assert.equal(race.roundsLeft, 2);
  assert.deepEqual(race.rule, { type: 'points', value: 12 });
  assert.equal(race.nextPhase.name, 'Phase 2');
  // AE: leader is through and nobody else can reach 12 -> locked for the event.
  // ES: leader (9) can reach 12, rival tops out at 9 -> can only draw level.
  // AR: leader (6) can reach 12; p7 tops out at 9 > 6 -> open.
  assert.deepEqual(statusOf(race), { [AE]: 'locked', [ES]: 'tiebreak', [AR]: 'open' });
  assert.equal(race.groups[0].leaders[0].through, true);

  // Lower the bar to 9: more players can reach Phase 2, so more races reopen.
  const easier = bestOfRace(raceIndex([swiss4, swiss3]), raceRows, 12, { advancePoints: { 1: 9 } });
  assert.equal(statusOf(easier)[ES], 'open'); // rival reaches 9
  assert.equal(statusOf(easier)[AE], 'open'); // p2 reaches 11
});

test('race: with no cut rule the next Swiss phase just adds rounds', () => {
  const race = bestOfRace(raceIndex([swiss4, swiss3]), raceRows, 12);
  assert.equal(race.roundsLeft, 5);
  assert.equal(race.rule, null);
  assert.equal(statusOf(race)[AE], 'open'); // 5 + 15 > 12
});

test('race: a ranked top cut is read from the event', () => {
  const cut = { id: 3, name: 'Phase 2', order: 2, round_type: 'RANKED_SINGLE_ELIMINATION', rank_required: 2, rounds: [] };
  const race = bestOfRace(raceIndex([swiss4, cut]), raceRows, 12);
  assert.deepEqual(race.rule, { type: 'rank', value: 2 });
  // p1 (12) is not certain of top 2: p4 can reach 15 and p6 can reach 12.
  assert.equal(race.groups[0].leaders[0].through, false);
  // p8 (best case 6) cannot make top 2: p1 and p4 already have more than 6.
  assert.equal(race.groups.find(g => g.deck === AR).leaders.find(l => l.id === 8).canCatch, 'tie');
});

test('race: nothing to report for a top-cut round', () => {
  const cutOnly = { id: 1, name: 'Top 8', order: 1, round_type: 'RANKED_SINGLE_ELIMINATION', rounds: [{ id: 11, number: 1 }, { id: 12, number: 2 }] };
  assert.equal(bestOfRace(raceIndex([cutOnly]), raceRows, 12), null);
});

test('fixture: London after round 6 with 18 points to reach Phase 2', () => {
  const race = bestOfRace(fx, standings[1582176].rows, 1582176, { advancePoints: { 1: 18 } });
  assert.equal(race.roundsLeft, 2);
  assert.deepEqual(race.rule, { type: 'points', value: 18 });
  assert.equal(race.groups.length, 15);
  for (const g of race.groups) {
    assert.ok(['locked', 'tiebreak', 'open'].includes(g.status));
    // A leader on 18 with rivals who can also reach 18 is never locked.
    if (g.leaders[0].through && g.threats) assert.equal(g.status, 'open');
  }
  // The biggest ink pair has several players already on 18.
  assert.equal(race.groups.find(g => g.deck === 'amber,emerald').status, 'open');
});
