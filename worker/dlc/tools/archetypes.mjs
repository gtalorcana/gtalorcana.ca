// Classify an event's decklists into archetypes and print the result.
//
// Usage: node worker/dlc/tools/archetypes.mjs <event_id> [options]
//   --cut <n>      stop merging lists that differ by more than n cards (default from archetypes.js)
//   --min <n>      smallest group that counts as an archetype
//   --ink <pair>   only this ink pair, e.g. amber,emerald
//   --matrix       archetype vs archetype matchup matrix
//   --scope <key>  matches used for the matrix: all (default) | phase:N | round:N
//   --top <n>      archetypes shown in the matrix (default 12)
//
// Needs tools/snapshot.mjs and tools/decklists.mjs to have been run for the event.

import fs from 'fs';
import path from 'path';
import { loadFixture } from './fixture.mjs';
import { classifyEvent, classifyInkPair, DEFAULT_CUT, DEFAULT_MIN_SIZE } from '../../../dlc/archetypes.js';
import { buildIndex, listScopes, matchupMatrix, matchWinRate, deckLabel, deckShort } from '../../../dlc/stats.js';

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
};
if (!args[0] || args[0].startsWith('--')) {
  console.error('Usage: node worker/dlc/tools/archetypes.mjs <event_id> [--cut N] [--min N] [--ink pair] [--matrix] [--scope key] [--top N]');
  process.exit(1);
}

const { dir, dataset } = loadFixture(args[0]);
const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
if (!fs.existsSync(path.join(dir, 'decks.json'))) {
  console.error('No decklists saved for this event — run tools/decklists.mjs first');
  process.exit(1);
}
const decks = read('decks.json');
const cards = read('cards.json');
const cut = Number(opt('cut', DEFAULT_CUT));
const minSize = Number(opt('min', DEFAULT_MIN_SIZE));
const onlyInk = opt('ink');

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const pct = v => `${Math.round(v * 100)}%`;

const { byInk, labelOf } = classifyEvent(decks, cards, { cut, minSize });
const inks = Object.keys(byInk).sort((a, b) =>
  (byInk[b].archetypes.reduce((s, x) => s + x.size, 0) + byInk[b].other.length) -
  (byInk[a].archetypes.reduce((s, x) => s + x.size, 0) + byInk[a].other.length));

// Average copies of song cards per list — an objective read on "songs deck".
const songCopies = players => {
  let n = 0;
  for (const pid of players) for (const [c, q] of decks[pid].cards) if (cards[c].song) n += q;
  return n / players.length;
};

console.log(`\n${dataset.meta.name}`);
console.log(`${Object.keys(decks).length} decklists · cut ${cut} cards · minimum archetype size ${minSize}\n`);

const names = new Map(); // label -> display name
for (const ink of inks) {
  const res = byInk[ink];
  const n = res.archetypes.reduce((s, a) => s + a.size, 0) + res.other.length;
  for (const a of res.archetypes) names.set(`${ink}/${a.key}`, `${deckShort(ink)} ${a.key}`);
  names.set(`${ink}/other`, `${deckShort(ink)} other`);
  if (onlyInk && ink !== onlyInk) continue;

  console.log(`${deckLabel(ink).toUpperCase()}  ${n} lists → ${res.archetypes.length} archetype${res.archetypes.length === 1 ? '' : 's'}${res.other.length ? `, ${res.other.length} unclassified` : ''}`);
  for (const a of res.archetypes) {
    console.log(`  ${a.key}  ${pad(a.name, 44)} ${padL(a.size, 4)} lists (${pct(a.size / n)})   ${a.core.length} core cards · ${songCopies(a.players).toFixed(1)} song copies`);
    if (res.archetypes.length > 1 || res.other.length) {
      console.log(`       distinctive: ${a.signature.slice(0, 4).map(s => `${s.name} (${pct(s.inGroup)} here, ${pct(s.elsewhere)} elsewhere)`).join('; ')}`);
    }
  }
  // Does the grouping hold if the cut moves? Sizes of archetypes at nearby cuts.
  const entries = Object.entries(decks).filter(([, d]) => d.ink === ink).map(([pid, deck]) => ({ id: Number(pid), deck }));
  const stability = [cut - 8, cut - 4, cut, cut + 4, cut + 8].map(c => {
    const r = classifyInkPair(entries, cards, { cut: c, minSize });
    return `${c}: [${r.archetypes.map(a => a.size).join(', ')}]${r.other.length ? ` +${r.other.length}` : ''}`;
  });
  console.log(`     if the cut moved → ${stability.join('   ')}\n`);
}

if (flag('matrix')) {
  // Reuse the ink-pair matrix: swap each player's ink pair for their archetype label.
  const relabelled = {
    ...dataset,
    players: Object.fromEntries(Object.entries(dataset.players).map(([pid, p]) =>
      [pid, { ...p, ink: labelOf.get(Number(pid)) ?? null }])),
  };
  const index = buildIndex(relabelled);
  const scopes = listScopes(index);
  let scopeKey = opt('scope', 'all');
  const [kind, num] = scopeKey.split(':');
  if (kind === 'phase' && index.phases[num - 1]) scopeKey = `phase:${index.phases[num - 1].id}`;
  if (kind === 'round') { const r = index.rounds.find(x => x.seq === Number(num)); if (r) scopeKey = `round:${r.id}`; }
  const scope = scopes.find(s => s.key === scopeKey) ?? scopes[0];

  const mx = matchupMatrix(index, scope.key);
  const top = Number(opt('top', 12));
  const shown = mx.decks.filter(d => d !== 'unknown' && !d.endsWith('/other')).slice(0, top);
  const W = 11;
  const label = d => names.get(d) ?? d;
  console.log(`ARCHETYPE MATCHUP MATRIX  ·  ${scope.label}  ·  ${mx.counted} matches counted`);
  console.log('Match win rate of the row archetype vs the column archetype, (sample size). Diagonal = mirror count.');
  console.log(pad('', 10) + pad('vs field', 12) + shown.map(d => padL(label(d), W)).join(''));
  for (const a of shown) {
    const t = mx.totals[a];
    const field = t ? `${pct(matchWinRate(t) ?? 0)} (${t.n})` : '·';
    const row = shown.map(b => {
      if (a === b) return padL(`[${mx.mirrors[a] ?? 0}]`, W);
      const c = mx.cells[a]?.[b];
      if (!c) return padL('·', W);
      const r = matchWinRate(c);
      return padL(`${r == null ? '–' : pct(r)} (${c.n})`, W);
    });
    console.log(pad(label(a), 10) + pad(field, 12) + row.join(''));
  }
  console.log('');
  for (const d of shown) {
    const [ink, key] = d.split('/');
    const a = byInk[ink].archetypes.find(x => x.key === key);
    console.log(`${pad(label(d), 10)}${deckLabel(ink)} · ${a.name} · ${a.size} lists`);
  }
  console.log('');
}
