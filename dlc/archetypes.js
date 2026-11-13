// DLC Explorer — archetype classification.
//
// Pure functions: no network, no DOM. Groups decklists inside one ink pair into
// archetypes using nothing but the cards in them. No human labels anything.
//
//   deck   { ink: "amber,emerald", cards: [[cardIndex, quantity], ...] }
//   cards  [{ n: "Name - Version", t: type, c: ink cost, ink: [...], song: 1? }]
//
// The rules, applied identically to every ink pair:
//   1. Distance between two lists = number of cards they do not share
//      (0 = identical, 60 = nothing in common).
//   2. Lists are merged bottom-up, closest groups first (average linkage).
//   3. Merging stops at `cut` cards of average difference.
//   4. A group smaller than `minSize` is not an archetype; it goes to "Other".
//   5. An archetype is named after its most distinctive cards.

// 35 sits in the empty stretch between "same deck, different tech" (mostly under
// 28 cards apart) and "different deck" (mostly over 40) seen at DLC Bangkok 2026.
export const DEFAULT_CUT = 35;
export const DEFAULT_MIN_SIZE = 5;

const total = deck => deck.cards.reduce((s, [, q]) => s + q, 0);

// Cards not shared, counting copies. Lists over 60 cards use the larger size.
export function deckDistance(a, b) {
  const qa = new Map(a.cards);
  let shared = 0;
  for (const [card, q] of b.cards) shared += Math.min(q, qa.get(card) ?? 0);
  return Math.max(total(a), total(b)) - shared;
}

export function distanceMatrix(decks) {
  const n = decks.length;
  const d = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) d[i][j] = d[j][i] = deckDistance(decks[i], decks[j]);
  }
  return d;
}

// Average-linkage agglomerative clustering. Deterministic: ties are broken by
// position, and callers pass decks in a fixed order (player id).
// Returns the merge history: [{ a, b, height, size }] where a and b are cluster
// ids (0..n-1 are single decks, n+k is the cluster made by merge k).
export function linkage(matrix) {
  const n = matrix.length;
  const dist = matrix.map(row => Array.from(row));
  const size = new Array(n).fill(1);
  const id = Array.from({ length: n }, (_, i) => i);
  const alive = new Set(id);
  const merges = [];

  while (alive.size > 1) {
    let bi = -1, bj = -1, best = Infinity;
    for (const i of alive) {
      for (const j of alive) {
        if (j <= i) continue;
        if (dist[i][j] < best) { best = dist[i][j]; bi = i; bj = j; }
      }
    }
    // Merge bj into bi: the new distance is the size-weighted average.
    for (const k of alive) {
      if (k === bi || k === bj) continue;
      const v = (dist[bi][k] * size[bi] + dist[bj][k] * size[bj]) / (size[bi] + size[bj]);
      dist[bi][k] = dist[k][bi] = v;
    }
    merges.push({ a: id[bi], b: id[bj], height: best, size: size[bi] + size[bj] });
    size[bi] += size[bj];
    id[bi] = n + merges.length - 1;
    alive.delete(bj);
  }
  return merges;
}

// Groups of deck positions after stopping every merge above `cut`.
export function cutTree(n, merges, cut) {
  const members = new Map(Array.from({ length: n }, (_, i) => [i, [i]]));
  merges.forEach((m, k) => {
    if (m.height > cut) return;
    members.set(n + k, [...members.get(m.a), ...members.get(m.b)]);
    members.delete(m.a);
    members.delete(m.b);
  });
  // A merge above the cut leaves its children in place, but later merges may
  // refer to it — those are above the cut too (heights never decrease).
  return [...members.values()].sort((x, y) => y.length - x.length || x[0] - y[0]);
}

// Share of the group's lists that play each card, and the average copies when played.
function cardUsage(decks) {
  const use = new Map();
  for (const deck of decks) {
    for (const [card, q] of deck.cards) {
      const u = use.get(card) ?? { lists: 0, copies: 0 };
      u.lists++; u.copies += q;
      use.set(card, u);
    }
  }
  return use;
}

// Classify the decks of ONE ink pair.
//   entries  [{ id: playerId, deck }]
// Returns { archetypes: [...], other: [playerIds], merges, cut }
//   archetype: { key, name, players: [ids], size,
//                signature: [{ card, name, inGroup, elsewhere }],   most distinctive first
//                core: [{ card, name, share, copies }] }            cards in >= 90% of lists
export function classifyInkPair(entries, cards, { cut = DEFAULT_CUT, minSize = DEFAULT_MIN_SIZE } = {}) {
  const sorted = [...entries].sort((a, b) => a.id - b.id);
  const decks = sorted.map(e => e.deck);
  const merges = linkage(distanceMatrix(decks));
  const groups = cutTree(decks.length, merges, cut);

  const archetypes = [];
  const other = [];
  for (const group of groups) {
    if (group.length < minSize) { other.push(...group.map(i => sorted[i].id)); continue; }
    const inside = group.map(i => decks[i]);
    const insideSet = new Set(group);
    const outside = decks.filter((_, i) => !insideSet.has(i));
    const useIn = cardUsage(inside);
    const useOut = cardUsage(outside);

    const rows = [...useIn].map(([card, u]) => ({
      card,
      name: cards[card]?.n ?? `Card ${card}`,
      inGroup: u.lists / inside.length,
      elsewhere: outside.length ? (useOut.get(card)?.lists ?? 0) / outside.length : 0,
      copies: u.copies / u.lists,
    }));
    // Distinctive = common here, rare in the rest of the ink pair.
    const signature = rows
      .filter(r => r.inGroup >= 0.6)
      .sort((a, b) => (b.inGroup - b.elsewhere) - (a.inGroup - a.elsewhere) || a.name.localeCompare(b.name))
      .slice(0, 5)
      .map(({ card, name, inGroup, elsewhere }) => ({ card, name, inGroup, elsewhere }));
    const core = rows
      .filter(r => r.inGroup >= 0.9)
      .sort((a, b) => b.inGroup - a.inGroup || b.copies - a.copies || a.name.localeCompare(b.name))
      .map(({ card, name, inGroup, copies }) => ({ card, name, share: inGroup, copies }));

    archetypes.push({ players: group.map(i => sorted[i].id), size: group.length, signature, core });
  }

  archetypes.forEach((a, i) => {
    a.key = String.fromCharCode(65 + i);
    // With a single archetype nothing is distinctive; fall back to its core cards.
    // Two different characters, not two versions of the same one.
    const lead = [...new Set((outsideExists(archetypes, a) ? a.signature : a.core).map(c => shortName(c.name)))].slice(0, 2);
    a.name = lead.length ? lead.join(' + ') : `Archetype ${a.key}`;
  });
  return { archetypes, other, merges, cut };
}

const outsideExists = (all, a) => all.length > 1 || a.signature.some(s => s.elsewhere > 0);
// "Cheshire Cat - Inexplicable" -> "Cheshire Cat"
const shortName = name => name.split(' - ')[0];

// Classify a whole event. Returns { byInk: { [ink]: result }, labelOf: Map(playerId -> label) }
// where label is "amber,emerald/A" or "amber,emerald/other".
export function classifyEvent(decksByPlayer, cards, options = {}) {
  const groups = {};
  for (const [pid, deck] of Object.entries(decksByPlayer)) {
    if (!deck?.ink) continue;
    (groups[deck.ink] ??= []).push({ id: Number(pid), deck });
  }
  const byInk = {};
  const labelOf = new Map();
  for (const [ink, entries] of Object.entries(groups)) {
    const result = classifyInkPair(entries, cards, options);
    byInk[ink] = result;
    for (const a of result.archetypes) for (const pid of a.players) labelOf.set(pid, `${ink}/${a.key}`);
    for (const pid of result.other) labelOf.set(pid, `${ink}/other`);
  }
  return { byInk, labelOf };
}

// Pairwise distances inside an ink pair as a histogram, in buckets of `step` cards.
// Used to check that "tech choices" and "different decks" separate cleanly.
export function distanceHistogram(entries, step = 4) {
  const decks = entries.map(e => e.deck);
  const buckets = new Array(Math.ceil(64 / step) + 1).fill(0);
  for (let i = 0; i < decks.length; i++) {
    for (let j = i + 1; j < decks.length; j++) {
      buckets[Math.min(buckets.length - 1, Math.floor(deckDistance(decks[i], decks[j]) / step))]++;
    }
  }
  return buckets;
}

// ── Joining decklists to a match dataset ─────────────────────────────────────

// GET /dlc/decks returns { cards, chunks: [{ decks: { [playerId]: deck } }] }.
// Later chunks win, so a list a player replaced overrides the earlier one.
export function mergeDeckChunks(payload) {
  const decks = {};
  for (const chunk of payload?.chunks ?? []) Object.assign(decks, chunk?.decks ?? {});
  return { cards: payload?.cards ?? [], decks };
}

// Some events carry no ink label in their match data. Returns a dataset whose
// players have a missing ink pair filled in from their decklist.
export function withDeckInks(dataset, decks) {
  const players = {};
  for (const [pid, p] of Object.entries(dataset.players ?? {})) {
    players[pid] = p.ink || !decks[pid]?.ink ? p : { ...p, ink: decks[pid].ink };
  }
  return { ...dataset, players };
}

// Returns a dataset whose players carry their archetype label in place of the
// ink pair, so every ink-pair statistic becomes an archetype statistic.
// Players without a decklist have no label and count as unknown.
export function withArchetypes(dataset, labelOf) {
  const players = {};
  for (const [pid, p] of Object.entries(dataset.players ?? {})) {
    players[pid] = { ...p, ink: labelOf.get(Number(pid)) ?? null };
  }
  return { ...dataset, players };
}

// "amber,emerald/A" -> { ink: "amber,emerald", key: "A" }; a plain ink pair has key null.
export function splitLabel(label) {
  const i = String(label).indexOf('/');
  return i < 0 ? { ink: label, key: null } : { ink: label.slice(0, i), key: label.slice(i + 1) };
}
