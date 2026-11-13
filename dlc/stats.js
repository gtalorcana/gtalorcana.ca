// DLC Explorer — stats.
//
// Pure functions: no network, no DOM, no Worker APIs. The page, the CLI
// (worker/dlc/tools/stats.mjs) and the tests all import this one file.
//
// Input is a dataset, exactly as GET /dlc/matches returns it:
//   {
//     meta:    { id, name, phases: [{ id, name, order, round_type, rounds: [{ id, number, status }] }] },
//     players: { [playerId]: { h: handle, ink: "amber,emerald" | null } },
//     rounds:  { [roundId]: { status: 'final' | 'partial', matches: [...] } },
//   }
// Match shape is documented in worker/dlc/slim.js.
//
// Everything is keyed on player id. Handles are for display only.

export const UNKNOWN = 'unknown';

const INK_ABBR = { amber: 'Am', amethyst: 'Ay', emerald: 'Em', ruby: 'Ru', sapphire: 'Sa', steel: 'St' };
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

export const deckLabel = deck =>
  deck === UNKNOWN ? 'Unknown' : deck.split(',').map(cap).join(' / ');
export const deckShort = deck =>
  deck === UNKNOWN ? '??' : deck.split(',').map(i => INK_ABBR[i] ?? cap(i).slice(0, 2)).join('/');

// ── Index ────────────────────────────────────────────────────────────────────

const isElimination = roundType => /ELIMINATION/.test(roundType ?? '');

// Flattens phases into one ordered round list. `seq` numbers rounds across the
// whole event (1, 2, 3 …) regardless of how RPH numbers them inside a phase.
export function buildIndex(dataset) {
  const players = dataset.players ?? {};
  const phases = [...(dataset.meta?.phases ?? [])]
    .sort((a, b) => a.order - b.order)
    .map((p, i) => ({
      id: p.id,
      index: i,
      name: p.name,
      label: isElimination(p.round_type) ? `Top cut (${p.name})` : p.name,
      elimination: isElimination(p.round_type),
      status: p.status,
      rounds: [],
    }));

  const rounds = [];
  let seq = 0;
  for (const phase of phases) {
    const src = dataset.meta.phases.find(p => p.id === phase.id);
    for (const r of [...(src.rounds ?? [])].sort((a, b) => a.number - b.number)) {
      const stored = dataset.rounds?.[r.id];
      const round = {
        id: r.id,
        seq: ++seq,
        number: r.number,
        status: r.status,
        phase,
        label: `Round ${seq}`,
        stored: stored?.status ?? null,
        matches: stored?.matches ?? [],
      };
      rounds.push(round);
      phase.rounds.push(round);
    }
  }

  // Per-player appearances, in round order.
  const byPlayer = new Map();
  for (const round of rounds) {
    for (const m of round.matches) {
      for (const pid of m.p) {
        if (!byPlayer.has(pid)) byPlayer.set(pid, []);
        byPlayer.get(pid).push({ round, match: m });
      }
    }
  }

  return { meta: dataset.meta, players, phases, rounds, byPlayer };
}

export const deckOf = (index, pid) => index.players[pid]?.ink ?? UNKNOWN;
export const handleOf = (index, pid) => index.players[pid]?.h ?? `Player ${pid}`;

// ── Scopes (filters over the one match list) ─────────────────────────────────

// [{ key: 'all' | 'phase:<id>' | 'round:<id>', label, rounds }]
// Only phases and rounds that have stored matches are offered.
export function listScopes(index) {
  const withData = index.rounds.filter(r => r.matches.length > 0);
  const scopes = [{ key: 'all', label: 'Whole event', rounds: withData }];
  for (const phase of index.phases) {
    const rs = phase.rounds.filter(r => r.matches.length > 0);
    if (rs.length) scopes.push({ key: `phase:${phase.id}`, label: phase.label, rounds: rs });
  }
  for (const r of withData) {
    scopes.push({
      key: `round:${r.id}`,
      label: `${r.label} · ${r.phase.name}${r.stored === 'final' ? '' : ' (in progress)'}`,
      rounds: [r],
    });
  }
  return scopes;
}

export function roundsIn(index, scopeKey = 'all') {
  return listScopes(index).find(s => s.key === scopeKey)?.rounds ?? [];
}

export const matchesIn = (index, scopeKey = 'all') =>
  roundsIn(index, scopeKey).flatMap(r => r.matches);

// ── Match classification ─────────────────────────────────────────────────────

// 'pending' | 'bye' | 'noshow' | 'draw' | 'win'
// Only 'win' and 'draw' are real games of Lorcana and count toward any rate.
export function classify(m) {
  if (m.k === 'loss') return 'noshow';
  if (m.k === 'bye' || m.p.length < 2) return 'bye';
  if (!m.d) return 'pending';
  if (m.w == null || m.k === 'id' || m.k === 'ud') return 'draw';
  return 'win';
}

// A played match from each player's side: { pid, opp, res: 'W'|'L'|'D', gf, ga, gd }.
// Games: on a decisive match g = [winner's games, loser's games, drawn]. On a
// draw RPH credits p[0] with g[0] and p[1] with g[1].
function sides(m, kind) {
  const [a, b] = m.p;
  const [g0, g1, gd] = m.g ?? [0, 0, 0];
  if (kind === 'draw') {
    return [
      { pid: a, opp: b, res: 'D', gf: g0, ga: g1, gd },
      { pid: b, opp: a, res: 'D', gf: g1, ga: g0, gd },
    ];
  }
  const loser = m.w === a ? b : a;
  return [
    { pid: m.w, opp: loser, res: 'W', gf: g0, ga: g1, gd },
    { pid: loser, opp: m.w, res: 'L', gf: g1, ga: g0, gd },
  ];
}

const emptyCell = () => ({ n: 0, w: 0, l: 0, d: 0, gw: 0, gl: 0, gd: 0 });

function addSide(cell, s) {
  cell.n++;
  if (s.res === 'W') cell.w++; else if (s.res === 'L') cell.l++; else cell.d++;
  cell.gw += s.gf; cell.gl += s.ga; cell.gd += s.gd;
}

// Draws are counted separately, so a rate is wins / (wins + losses).
// null when there is nothing decisive to divide by.
export const rate = (w, l) => (w + l > 0 ? w / (w + l) : null);
export const matchWinRate = c => rate(c.w, c.l);
export const gameWinRate = c => rate(c.gw, c.gl);

// ── Matchup matrix ───────────────────────────────────────────────────────────

// Ink pair vs ink pair for the scope.
//   decks    ink pairs, most-played first
//   cells    cells[a][b] = a's results against b (a !== b): { n, w, l, d, gw, gl, gd }
//   mirrors  mirrors[a] = number of a-vs-a matches (count only — always 50%)
//   totals   totals[a] = a's results against everything except itself
//   counted  matches that fed the matrix; excluded = { bye, noshow, pending }
export function matchupMatrix(index, scopeKey = 'all') {
  const cells = {};
  const mirrors = {};
  const totals = {};
  const played = {};
  const excluded = { bye: 0, noshow: 0, pending: 0 };
  let counted = 0;

  for (const m of matchesIn(index, scopeKey)) {
    const kind = classify(m);
    if (kind !== 'win' && kind !== 'draw') { excluded[kind]++; continue; }
    counted++;
    const [s1, s2] = sides(m, kind);
    const d1 = deckOf(index, s1.pid);
    const d2 = deckOf(index, s2.pid);
    played[d1] = (played[d1] ?? 0) + 1;
    played[d2] = (played[d2] ?? 0) + 1;
    if (d1 === d2) { mirrors[d1] = (mirrors[d1] ?? 0) + 1; continue; }
    for (const [mine, theirs, side] of [[d1, d2, s1], [d2, d1, s2]]) {
      addSide((cells[mine] ??= {})[theirs] ??= emptyCell(), side);
      addSide(totals[mine] ??= emptyCell(), side);
    }
  }

  const decks = Object.keys(played).sort((a, b) =>
    (a === UNKNOWN) - (b === UNKNOWN) || played[b] - played[a] || a.localeCompare(b));
  return { decks, cells, mirrors, totals, played, counted, excluded };
}

// ── Meta share and win rate per ink pair ─────────────────────────────────────

// One row per ink pair for the scope, most-played first:
//   players  distinct players on the deck who were paired in the scope
//   share    players / all distinct players paired in the scope
//   w, l, d, gw, gl, gd  results excluding mirrors, byes and no-shows
//   mirror   mirror matches (count only)
export function deckStats(index, scopeKey = 'all') {
  const seen = {};
  const all = new Set();
  for (const m of matchesIn(index, scopeKey)) {
    for (const pid of m.p) {
      all.add(pid);
      (seen[deckOf(index, pid)] ??= new Set()).add(pid);
    }
  }
  const mx = matchupMatrix(index, scopeKey);
  const rows = Object.keys(seen).map(deck => {
    const t = mx.totals[deck] ?? emptyCell();
    return {
      deck,
      players: seen[deck].size,
      share: all.size ? seen[deck].size / all.size : 0,
      ...t,
      mirror: mx.mirrors[deck] ?? 0,
      mwr: matchWinRate(t),
      gwr: gameWinRate(t),
    };
  });
  rows.sort((a, b) =>
    (a.deck === UNKNOWN) - (b.deck === UNKNOWN) || b.players - a.players || a.deck.localeCompare(b.deck));
  return { total: all.size, rows };
}

// Meta share round by round: [{ round, total, decks: { [deck]: players } }]
export function metaByRound(index) {
  return index.rounds.filter(r => r.matches.length > 0).map(round => {
    const decks = {};
    let total = 0;
    for (const m of round.matches) {
      for (const pid of m.p) {
        const d = deckOf(index, pid);
        decks[d] = (decks[d] ?? 0) + 1;
        total++;
      }
    }
    return { round, total, decks };
  });
}

// ── Conversion between phases ────────────────────────────────────────────────

const participants = rounds => new Set(rounds.flatMap(r => r.matches.flatMap(m => m.p)));

// For each phase that has a following phase with pairings: who advanced.
// "Advanced" is read off the next phase's pairings — RPH has no explicit flag.
//   [{ from, to, entered, advanced, rows: [{ deck, entered, advanced, rate, shareBefore, shareAfter }] }]
export function conversion(index) {
  const out = [];
  for (let i = 0; i + 1 < index.phases.length; i++) {
    const from = index.phases[i];
    const to = index.phases[i + 1];
    const before = participants(from.rounds);
    const after = participants(to.rounds);
    if (!before.size || !after.size) continue;

    const rows = {};
    for (const pid of before) {
      const row = rows[deckOf(index, pid)] ??= { deck: deckOf(index, pid), entered: 0, advanced: 0 };
      row.entered++;
      if (after.has(pid)) row.advanced++;
    }
    const advanced = [...before].filter(pid => after.has(pid)).length;
    const list = Object.values(rows).map(r => ({
      ...r,
      rate: r.entered ? r.advanced / r.entered : null,
      shareBefore: r.entered / before.size,
      shareAfter: advanced ? r.advanced / advanced : 0,
    }));
    list.sort((a, b) =>
      (a.deck === UNKNOWN) - (b.deck === UNKNOWN) || b.entered - a.entered || a.deck.localeCompare(b.deck));
    out.push({ from, to, entered: before.size, advanced, rows: list });
  }
  return out;
}

// ── Player page ──────────────────────────────────────────────────────────────

// Round-by-round history rebuilt from match results (the record RPH attaches to
// a player is live, not a per-round snapshot).
//   rows: [{ round, table, result, score, opp: { id, handle, deck } | null, record, points }]
//   result: 'W' | 'L' | 'D' | 'BYE' | 'LIVE'; `awarded` marks a no-show / awarded result.
export function playerHistory(index, pid) {
  let w = 0, l = 0, d = 0;
  const rows = (index.byPlayer.get(pid) ?? []).map(({ round, match: m }) => {
    const kind = classify(m);
    const oppId = m.p.find(p => p !== pid) ?? null;
    const opp = oppId == null ? null
      : { id: oppId, handle: handleOf(index, oppId), deck: deckOf(index, oppId) };
    let result, score = null, awarded = false;

    if (kind === 'bye') { result = 'BYE'; w++; }
    else if (kind === 'pending') { result = 'LIVE'; }
    else if (kind === 'noshow') {
      // RPH records an awarded loss as a one-player match with no winner.
      awarded = true;
      if (m.w === pid) { result = 'W'; w++; } else { result = 'L'; l++; }
    } else {
      const side = sides(m, kind).find(s => s.pid === pid);
      result = side.res;
      if (result === 'W') w++; else if (result === 'L') l++; else d++;
      if (m.g) score = `${side.gf}-${side.ga}${side.gd ? `-${side.gd}` : ''}`;
    }
    return {
      round, table: m.t || null, result, score, awarded, kind: m.k ?? null, opp,
      record: `${w}-${l}-${d}`, points: w * 3 + d,
    };
  });
  return {
    id: pid, handle: handleOf(index, pid), deck: deckOf(index, pid),
    rows, record: `${w}-${l}-${d}`, points: w * 3 + d,
  };
}

// Case-insensitive handle search: [{ id, handle, deck }], best matches first.
export function searchPlayers(index, query, limit = 25) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits = [];
  for (const [id, p] of Object.entries(index.players)) {
    const h = (p.h ?? '').toLowerCase();
    const at = h.indexOf(q);
    if (at >= 0) hits.push({ id: Number(id), handle: p.h, deck: p.ink ?? UNKNOWN, at, len: h.length });
  }
  hits.sort((a, b) => a.at - b.at || a.len - b.len || a.handle.localeCompare(b.handle));
  return hits.slice(0, limit).map(({ at, len, ...rest }) => rest);
}

// ── Drops ────────────────────────────────────────────────────────────────────

// Per round: how many players were paired, and how many were never paired again.
// `left` is null for the latest round (nobody has had the chance to come back).
// At the end of a phase, not continuing mostly means missing the cut rather than
// dropping, so those rounds are flagged `phaseEnd`.
export function dropsByRound(index) {
  const withData = index.rounds.filter(r => r.matches.length > 0);
  const lastSeen = new Map();
  for (const round of withData) {
    for (const m of round.matches) for (const pid of m.p) lastSeen.set(pid, round.seq);
  }
  const left = {};
  for (const seq of lastSeen.values()) left[seq] = (left[seq] ?? 0) + 1;

  return withData.map((round, i) => {
    const next = withData[i + 1];
    return {
      round,
      players: participants([round]).size,
      left: next ? (left[round.seq] ?? 0) : null,
      phaseEnd: !!next && next.phase.id !== round.phase.id,
    };
  });
}
