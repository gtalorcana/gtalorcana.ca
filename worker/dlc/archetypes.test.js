// Run: node --test worker/dlc/archetypes.test.js
//
// Archetype classification: a hand-built ink pair where the answer is obvious,
// then the saved decklists from DLC Bangkok 2026 (event 1233041).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  deckDistance, distanceMatrix, linkage, cutTree, classifyInkPair, classifyEvent, DEFAULT_CUT,
  mergeDeckChunks, withDeckInks, withArchetypes, splitLabel,
} from '../../dlc/archetypes.js';
import { slimDeck, cardIndexOf } from './slim.js';
import { buildIndex, matchupMatrix, conversion, deckStats } from '../../dlc/stats.js';
import { loadFixture } from './tools/fixture.mjs';
import { fixtureDir } from './tools/fixture.mjs';

// 15 cards × 4 copies = a 60-card deck.
const deck = (ids, ink = 'amber,emerald') => ({ ink, cards: ids.map(i => [i, 4]) });
const range = (from, n) => Array.from({ length: n }, (_, i) => from + i);
const cards = Array.from({ length: 80 }, (_, i) => ({ n: `Card ${i} - Version`, t: 'Character' }));

test('distance is the number of cards two lists do not share', () => {
  const a = deck(range(0, 15));
  assert.equal(deckDistance(a, a), 0);
  assert.equal(deckDistance(a, deck(range(15, 15))), 60);
  assert.equal(deckDistance(a, deck([...range(0, 14), 40])), 4);        // one playset swapped
  assert.equal(deckDistance(a, { ink: 'x', cards: [[0, 2], ...range(1, 14).map(i => [i, 4])] }), 2); // 58 vs 60 cards
});

test('distance uses the larger list when one runs more than 60 cards', () => {
  const a = deck(range(0, 15));
  const b = { ink: 'x', cards: [...a.cards, [50, 2]] };
  assert.equal(deckDistance(a, b), 2);
  assert.equal(deckDistance(b, a), 2);
});

// Two clear archetypes with tech differences inside each, plus one rogue list.
const songs = range(0, 15), aggro = range(20, 15);
const entries = [
  ...[40, 41, 42, 43, 44, 45].map((tech, i) => ({ id: 100 + i, deck: deck([...songs.slice(0, 14), tech]) })),
  ...[50, 51, 52, 53, 54].map((tech, i) => ({ id: 200 + i, deck: deck([...aggro.slice(0, 14), tech]) })),
  { id: 300, deck: deck(range(60, 15)) },
];

test('lists that differ by tech choices land together; different decks do not', () => {
  const { archetypes, other } = classifyInkPair(entries, cards);
  assert.deepEqual(archetypes.map(a => a.size), [6, 5]);
  assert.deepEqual(archetypes[0].players, [100, 101, 102, 103, 104, 105]);
  assert.deepEqual(archetypes[1].players, [200, 201, 202, 203, 204]);
  assert.deepEqual(other, [300]); // one list alone is not an archetype
});

test('archetypes are named after their distinctive cards, core cards are listed', () => {
  const { archetypes } = classifyInkPair(entries, cards);
  assert.deepEqual(archetypes.map(a => a.key), ['A', 'B']);
  assert.equal(archetypes[0].name, 'Card 0 + Card 1');
  assert.equal(archetypes[0].core.length, 14);       // the 14 shared playsets
  assert.ok(archetypes[0].signature.every(s => s.inGroup === 1 && s.elsewhere === 0));
});

test('the result does not depend on the order lists arrive in', () => {
  const a = classifyInkPair(entries, cards);
  const b = classifyInkPair([...entries].reverse(), cards);
  assert.deepEqual(a.archetypes.map(x => x.players), b.archetypes.map(x => x.players));
  assert.deepEqual(a.archetypes.map(x => x.name), b.archetypes.map(x => x.name));
});

test('cut and minimum size are the only knobs', () => {
  assert.equal(classifyInkPair(entries, cards, { cut: 2 }).archetypes.length, 0);    // nothing is that close
  assert.deepEqual(classifyInkPair(entries, cards, { cut: 60 }).archetypes.map(a => a.size), [12]);
  assert.deepEqual(classifyInkPair(entries, cards, { minSize: 1 }).archetypes.map(a => a.size), [6, 5, 1]);
});

test('merge heights never decrease, so a cut is well defined', () => {
  const merges = linkage(distanceMatrix(entries.map(e => e.deck)));
  assert.equal(merges.length, entries.length - 1);
  for (let i = 1; i < merges.length; i++) assert.ok(merges[i].height >= merges[i - 1].height - 1e-9);
  assert.equal(cutTree(entries.length, merges, 0).length, entries.length);
  assert.equal(cutTree(entries.length, merges, 60).length, 1);
});

test('classifyEvent keeps ink pairs apart and labels every player', () => {
  const byPlayer = Object.fromEntries(entries.map(e => [e.id, e.deck]));
  byPlayer[400] = deck(songs, 'ruby,steel'); // same cards, different ink pair
  const { byInk, labelOf } = classifyEvent(byPlayer, cards);
  assert.deepEqual(Object.keys(byInk).sort(), ['amber,emerald', 'ruby,steel']);
  assert.equal(labelOf.get(100), 'amber,emerald/A');
  assert.equal(labelOf.get(200), 'amber,emerald/B');
  assert.equal(labelOf.get(300), 'amber,emerald/other');
  assert.equal(labelOf.get(400), 'ruby,steel/other');
});

// ── Fixture: DLC Bangkok 2026 ────────────────────────────────────────────────

const dir = fixtureDir(1233041);
const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const decks = read('decks.json');
const realCards = read('cards.json');
const event = classifyEvent(decks, realCards);
const songCopies = players => players.reduce((s, pid) =>
  s + decks[pid].cards.reduce((n, [c, q]) => n + (realCards[c].song ? q : 0), 0), 0) / players.length;

test('fixture: 706 lists, every one a legal size, none storing a URL', () => {
  assert.equal(Object.keys(decks).length, 706);
  for (const d of Object.values(decks)) assert.ok(d.cards.reduce((s, [, q]) => s + q, 0) >= 60);
  assert.ok(!JSON.stringify(realCards).includes('http'));
});

test('fixture: Amber / Emerald splits into a songs deck and a non-songs deck', () => {
  const [a, b] = event.byInk['amber,emerald'].archetypes;
  assert.deepEqual([a.size, b.size], [103, 41]);
  assert.ok(songCopies(a.players) > 15, 'the big archetype is built on songs');
  assert.ok(songCopies(b.players) < 2, 'the second plays almost none');
});

test('fixture: the split is the same anywhere near the default cut', () => {
  const entriesAE = Object.entries(decks).filter(([, d]) => d.ink === 'amber,emerald').map(([id, d]) => ({ id: Number(id), deck: d }));
  for (const cut of [DEFAULT_CUT - 8, DEFAULT_CUT - 4, DEFAULT_CUT + 4]) {
    assert.deepEqual(classifyInkPair(entriesAE, realCards, { cut }).archetypes.slice(0, 2).map(a => a.size), [103, 41], `cut ${cut}`);
  }
});

test('fixture: every player with a list gets exactly one label', () => {
  assert.equal(event.labelOf.size, 706);
  const inArchetype = [...event.labelOf.values()].filter(l => !l.endsWith('/other')).length;
  assert.ok(inArchetype / 706 > 0.9, 'over 90% of lists fall into a named archetype');
});

// ── Decklists: slimming and joining to matches ───────────────────────────────

const rawCard = (name, qty, extra = {}) => ({
  quantity: qty,
  card: { display_name: name, type: 'Character', image_url: 'https://example.com/signed.png',
    attribute_values: { Ink: 'Amber', 'Ink Cost': 3, ...extra } },
});

test('slimDeck keeps names and counts, shares one card table, stores no URL', () => {
  const table = [];
  const idx = cardIndexOf(table);
  const a = slimDeck({ descriptor: { values: ['Emerald', 'Amber'] }, sections: [
    { section_type: 'main', cards: [rawCard('Aurora - Dreaming', 4), rawCard('Sing Along - Song', 2, { Classifications: ['Action', 'Song'] })] },
    { section_type: 'sideboard', cards: [rawCard('Not Counted - X', 4)] },
  ] }, table, idx);
  const b = slimDeck({ descriptor: { values: [] }, sections: [{ cards: [rawCard('Aurora - Dreaming', 3), rawCard('Aurora - Dreaming', 1)] }] }, table, idx);
  assert.deepEqual(a, { ink: 'amber,emerald', cards: [[0, 4], [1, 2]] });
  assert.deepEqual(b, { ink: null, cards: [[0, 4]] });       // split entries of one card add up
  assert.equal(table.length, 2);
  assert.equal(table[1].song, 1);
  assert.ok(!JSON.stringify(table).includes('http'));
});

test('deck chunks merge in order; a later list replaces an earlier one', () => {
  const merged = mergeDeckChunks({ cards: [{ n: 'x' }], chunks: [
    { next: 2, decks: { 1: { ink: 'a,b', cards: [] }, 2: { ink: 'a,b', cards: [] } } },
    { next: 3, decks: { 2: { ink: 'c,d', cards: [] } } },
  ] });
  assert.deepEqual(Object.keys(merged.decks), ['1', '2']);
  assert.equal(merged.decks[2].ink, 'c,d');
  assert.deepEqual(mergeDeckChunks(null), { cards: [], decks: {} });
});

test('ink pairs are filled from decklists only where the match data has none', () => {
  const ds = { players: { 1: { h: 'a', ink: null }, 2: { h: 'b', ink: 'ruby,steel' }, 3: { h: 'c', ink: null } } };
  const out = withDeckInks(ds, { 1: { ink: 'amber,emerald' }, 2: { ink: 'amber,amethyst' } });
  assert.deepEqual(out.players, { 1: { h: 'a', ink: 'amber,emerald' }, 2: { h: 'b', ink: 'ruby,steel' }, 3: { h: 'c', ink: null } });
  assert.equal(ds.players[1].ink, null); // input untouched
});

test('archetype labels split back into ink pair and key', () => {
  assert.deepEqual(splitLabel('amber,emerald/A'), { ink: 'amber,emerald', key: 'A' });
  assert.deepEqual(splitLabel('amber,emerald/other'), { ink: 'amber,emerald', key: 'other' });
  assert.deepEqual(splitLabel('amber,emerald'), { ink: 'amber,emerald', key: null });
});

test('fixture: grouping by archetype reuses every ink-pair statistic', () => {
  const { dataset } = loadFixture(1233041);
  const byInk = buildIndex(dataset);
  const byArch = buildIndex(withArchetypes(dataset, event.labelOf));
  // Same matches either way; only the grouping differs.
  assert.equal(matchupMatrix(byArch, 'all').counted, matchupMatrix(byInk, 'all').counted);

  // The two Amber / Emerald archetypes have very different results.
  const mx = matchupMatrix(byArch, 'all');
  const wr = d => mx.totals[d].w / (mx.totals[d].w + mx.totals[d].l);
  assert.ok(wr('amber,emerald/A') > 0.55 && wr('amber,emerald/B') < 0.5);

  // Top cut by archetype: 128 players, each counted once.
  const cut = byArch.phases.find(p => p.elimination);
  const top = deckStats(byArch, `phase:${cut.id}`);
  assert.equal(top.total, 128);
  assert.equal(top.rows.reduce((n, r) => n + r.players, 0), 128);
  const conv = conversion(byArch)[0];
  assert.equal(conv.advanced, 128);
  assert.ok(conv.rows.some(r => r.deck === 'amber,emerald/A'));
});
