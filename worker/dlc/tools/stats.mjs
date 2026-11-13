// Print DLC Explorer stats from a saved fixture — no network, no Worker.
//
// Usage: node worker/dlc/tools/stats.mjs <event_id | fixture dir> [options]
//   --scope <key>     all (default) | phase:<n> | round:<n>   (n = 1-based position)
//                     or an exact key such as round:1582171
//   --top <n>         decks shown in the matrix (default 10)
//   --games           matrix shows game win rate instead of match win rate
//   --player <text>   round-by-round history for the best handle match
//   --standings <n>   top n of the latest saved standings
//   --json            dump the computed stats as JSON instead of tables
//
// Take a fixture first with: node worker/dlc/tools/snapshot.mjs <event_id>

import { loadFixture } from './fixture.mjs';
import {
  buildIndex, listScopes, matchupMatrix, deckStats, metaByRound, conversion, playerHistory,
  searchPlayers, dropsByRound, matchWinRate, gameWinRate, deckLabel, deckShort, handleOf, deckOf,
} from '../../../dlc/stats.js';

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
};
if (!args[0] || args[0].startsWith('--')) {
  console.error('Usage: node worker/dlc/tools/stats.mjs <event_id | fixture dir> [--scope all|phase:N|round:N] [--top N] [--games] [--player text] [--standings N] [--json]');
  process.exit(1);
}

const { dataset, standings } = loadFixture(args[0]);
const index = buildIndex(dataset);
const scopes = listScopes(index);

// phase:2 / round:6 mean "the 2nd phase" / "round 6 of the event"; raw ids work too.
function resolveScope(input) {
  if (scopes.some(s => s.key === input)) return input;
  const [kind, n] = input.split(':');
  if (kind === 'phase') {
    const phase = index.phases[Number(n) - 1];
    if (phase) return `phase:${phase.id}`;
  }
  if (kind === 'round') {
    const round = index.rounds.find(r => r.seq === Number(n));
    if (round) return `round:${round.id}`;
  }
  return input;
}
const scopeKey = resolveScope(opt('scope', 'all'));
const scope = scopes.find(s => s.key === scopeKey);
if (!scope) {
  console.error(`No data for scope "${opt('scope')}". Available:\n  ${scopes.map(s => `${s.key}  ${s.label}`).join('\n  ')}`);
  process.exit(1);
}

const pctText = v => (v == null ? '  –' : `${Math.round(v * 100)}%`.padStart(4));
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

const mx = matchupMatrix(index, scopeKey);
const decks = deckStats(index, scopeKey);

if (flag('json')) {
  console.log(JSON.stringify({
    event: dataset.meta.name, scope: scope.label, matrix: mx, decks,
    meta_by_round: metaByRound(index).map(r => ({ round: r.round.seq, total: r.total, decks: r.decks })),
    conversion: conversion(index).map(c => ({ from: c.from.name, to: c.to.name, entered: c.entered, advanced: c.advanced, rows: c.rows })),
    drops: dropsByRound(index).map(d => ({ round: d.round.seq, players: d.players, left: d.left, phase_end: d.phaseEnd })),
  }, null, 2));
  process.exit(0);
}

console.log(`\n${dataset.meta.name}  ·  ${scope.label}`);
console.log(`${mx.counted} matches counted  ·  excluded: ${mx.excluded.bye} byes, ${mx.excluded.noshow} awarded losses, ${mx.excluded.pending} unfinished\n`);

// ── Meta share and win rates ────────────────────────────────────────────────
console.log('INK PAIRS  (win rates exclude mirrors, byes and awarded losses; draws counted separately)');
console.log(`${pad('Deck', 22)}${padL('Players', 8)}${padL('Share', 7)}${padL('W', 6)}${padL('L', 6)}${padL('D', 5)}${padL('Match%', 8)}${padL('Game%', 7)}${padL('Mirrors', 9)}`);
for (const r of decks.rows) {
  console.log(`${pad(deckLabel(r.deck), 22)}${padL(r.players, 8)}${padL((r.share * 100).toFixed(1) + '%', 7)}${padL(r.w, 6)}${padL(r.l, 6)}${padL(r.d, 5)}${padL(pctText(r.mwr), 8)}${padL(pctText(r.gwr), 7)}${padL(r.mirror, 9)}`);
}

// ── Matchup matrix ──────────────────────────────────────────────────────────
const top = Number(opt('top', 10));
const shown = mx.decks.slice(0, top);
const useGames = flag('games');
const W = 11;
console.log(`\nMATCHUP MATRIX  ${useGames ? 'game' : 'match'} win rate of the row deck vs the column deck, (sample size)`);
console.log(`Diagonal = mirror matches, count only.${mx.decks.length > top ? `  Showing ${top} of ${mx.decks.length} decks (--top).` : ''}`);
console.log(pad('', 8) + shown.map(d => padL(deckShort(d), W)).join(''));
for (const a of shown) {
  const row = shown.map(b => {
    if (a === b) return padL(`[${mx.mirrors[a] ?? 0}]`, W);
    const c = mx.cells[a]?.[b];
    if (!c) return padL('·', W);
    return padL(`${pctText(useGames ? gameWinRate(c) : matchWinRate(c)).trim()} (${c.n})`, W);
  });
  console.log(pad(deckShort(a), 8) + row.join(''));
}
console.log(shown.map(d => `${deckShort(d)} = ${deckLabel(d)}`).join('   '));

// ── Meta share by round ─────────────────────────────────────────────────────
const byRound = metaByRound(index);
const trendDecks = deckStats(index, 'all').rows.slice(0, top).map(r => r.deck);
console.log('\nMETA SHARE BY ROUND  (share of players paired that round)');
console.log(pad('', 8) + byRound.map(r => padL(`R${r.round.seq}`, 7)).join(''));
for (const d of trendDecks) {
  console.log(pad(deckShort(d), 8) + byRound.map(r => padL(((r.decks[d] ?? 0) / r.total * 100).toFixed(1) + '%', 7)).join(''));
}

// ── Conversion ──────────────────────────────────────────────────────────────
for (const c of conversion(index)) {
  console.log(`\nCONVERSION  ${c.from.name} → ${c.to.label}: ${c.advanced} of ${c.entered} advanced`);
  console.log(`${pad('Deck', 22)}${padL('Entered', 8)}${padL('Advanced', 9)}${padL('Rate', 7)}${padL('Share before', 14)}${padL('Share after', 13)}`);
  for (const r of c.rows) {
    console.log(`${pad(deckLabel(r.deck), 22)}${padL(r.entered, 8)}${padL(r.advanced, 9)}${padL(pctText(r.rate), 7)}${padL((r.shareBefore * 100).toFixed(1) + '%', 14)}${padL((r.shareAfter * 100).toFixed(1) + '%', 13)}`);
  }
}
if (!conversion(index).length) console.log('\nCONVERSION  no later phase has pairings yet.');

// ── Drops ───────────────────────────────────────────────────────────────────
console.log('\nPLAYERS AND DROPS BY ROUND  (left = not paired in any later round)');
for (const d of dropsByRound(index)) {
  const left = d.left == null ? '–' : d.left;
  console.log(`${pad(d.round.label, 10)}${pad(d.round.phase.name, 10)}${padL(d.players, 6)} players${padL(left, 6)} left${d.phaseEnd ? '  (end of phase: includes players who missed the cut)' : ''}`);
}

// ── Standings ───────────────────────────────────────────────────────────────
if (opt('standings')) {
  const last = [...index.rounds].reverse().find(r => standings[r.id]);
  if (last) {
    console.log(`\nSTANDINGS after ${last.label}`);
    for (const s of standings[last.id].rows.slice(0, Number(opt('standings')))) {
      console.log(`${padL(s.r, 5)}  ${pad(handleOf(index, s.p), 26)}${pad(deckShort(deckOf(index, s.p)), 7)}${pad(s.rec, 8)}${padL(s.pts, 3)} pts  OMW ${pctText(s.omw)}  GW ${pctText(s.gw)}  OGW ${pctText(s.ogw)}`);
    }
  }
}

// ── Player ──────────────────────────────────────────────────────────────────
if (opt('player')) {
  const hits = searchPlayers(index, opt('player'), 5);
  if (!hits.length) console.log(`\nPLAYER  no handle matches "${opt('player')}"`);
  else {
    const h = playerHistory(index, hits[0].id);
    console.log(`\nPLAYER  ${h.handle}  ·  ${deckLabel(h.deck)}  ·  ${h.record}  (id ${h.id})`);
    for (const r of h.rows) {
      const opp = r.opp ? `${pad(r.opp.handle, 26)}${deckLabel(r.opp.deck)}` : (r.awarded ? 'awarded loss' : '');
      console.log(`${pad(r.round.label, 10)}${pad(r.table ? `T${r.table}` : '', 7)}${pad(r.result, 5)}${pad(r.score ?? '', 7)}${pad(r.record, 8)}${opp}`);
    }
    if (hits.length > 1) console.log(`Other matches: ${hits.slice(1).map(p => p.handle).join(', ')}`);
  }
}
console.log('');
