// Pure functions that turn raw RPH responses into the small records we store.
// No network, no Worker APIs. Shared by the Worker and the snapshot CLI so a
// fixture on disk is byte-for-byte what KV holds.
//
// Raw responses are ~9.5 KB per match, mostly signed image URLs that expire in
// 24h. Nothing here keeps a URL.

// "amber,emerald" — inks lower-cased, de-duplicated, sorted. null when RPH has
// no deck label for the player.
export function inkPair(userEventStatus) {
  const parts = userEventStatus?.deck_descriptor_label?.parts ?? [];
  const inks = parts
    .flatMap(p => String(p?.value ?? '').split(','))
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  return inks.length ? [...new Set(inks)].sort().join(',') : null;
}

// Event structure. Everything the tool knows about phases and rounds comes from
// here; upcoming phases simply have an empty rounds list until RPH creates them.
export function slimEvent(e) {
  return {
    id: e.id,
    name: e.name ?? `Event ${e.id}`,
    start: e.start_datetime ?? null,
    timezone: e.timezone ?? null,
    player_count: e.starting_player_count ?? e.registered_user_count ?? null,
    phases: (e.tournament_phases ?? [])
      .map(p => ({
        id: p.id,
        name: p.phase_name || `Phase ${p.order_in_phases}`,
        order: p.order_in_phases,
        round_type: p.round_type,
        status: p.status,
        rounds_planned: p.number_of_rounds ?? null,
        rank_required: p.rank_required_to_enter_phase ?? null,
        game_wins_needed: p.effective_maximum_number_of_game_wins_per_match ?? null,
        show_decklists: !!p.effective_show_decklists_to_opponents,
        rounds: (p.rounds ?? [])
          .map(r => ({
            id: r.id,
            number: r.round_number,
            status: r.status,
            pairings: r.pairings_status === 'GENERATED',
            standings: r.standings_status === 'GENERATED',
          }))
          .sort((a, b) => a.number - b.number),
      }))
      .sort((a, b) => a.order - b.order),
  };
}

// One match:
//   id  match id
//   t   table number
//   d   1 when the match is COMPLETE, else 0
//   p   player ids, in RPH's order (one id for a bye)
//   w   winning player id, or null (draw / not finished)
//   g   [games_won_by_winner, games_won_by_loser, games_drawn], or null
//   k   optional kind: 'bye' | 'loss' (awarded loss, usually a no-show: one
//       player, no winner) | 'id' | 'ud'
// Returns the match plus [playerId, {h, ink}] entries for the players map.
// h is the handle (user_event_status.best_identifier) — never the "First L" name,
// which collides between different people.
export function slimMatch(m) {
  const rels = [...(m.player_match_relationships ?? [])]
    .sort((a, b) => (a.player_order ?? 0) - (b.player_order ?? 0));
  const p = m.players ?? rels.map(r => r.player?.id).filter(id => id != null);

  const match = {
    id: m.id,
    t: m.table_number ?? 0,
    d: m.status === 'COMPLETE' ? 1 : 0,
    p,
    w: m.winning_player ?? null,
    g: m.games_won_by_winner == null
      ? null
      : [m.games_won_by_winner, m.games_won_by_loser ?? 0, m.games_drawn ?? 0],
  };
  // An awarded loss is a one-player match too (match_is_loss, no winner), so the
  // flags decide before the player count does.
  if (m.match_is_bye) match.k = 'bye';
  else if (m.match_is_loss) match.k = 'loss';
  else if (p.length < 2) match.k = 'bye';
  else if (m.match_is_intentional_draw) match.k = 'id';
  else if (m.match_is_unintentional_draw) match.k = 'ud';

  const players = rels
    .filter(r => r.player?.id != null)
    .map(r => [r.player.id, {
      h: r.user_event_status?.best_identifier ?? `Player ${r.player.id}`,
      ink: inkPair(r.user_event_status),
    }]);

  return { match, players };
}

const pct = v => (v == null ? null : Math.round(v * 10000) / 10000);

// One standings row. `points` and `match_record` are the per-round values;
// `record` and the user_event_status counters are live and must not be used.
export function slimStanding(s) {
  return {
    r: s.rank,
    p: s.player?.id ?? s.id,
    pts: s.points ?? s.match_points ?? 0,
    rec: s.match_record ?? null,
    omw: pct(s.opponent_match_win_percentage),
    gw: pct(s.game_win_percentage),
    ogw: pct(s.opponent_game_win_percentage),
  };
}

// Merge freshly fetched matches into a stored list, replacing by match id.
export function mergeMatches(existing, incoming) {
  const byId = new Map(existing.map(m => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()];
}

export const sortMatches = matches =>
  matches.sort((a, b) => (a.t || Infinity) - (b.t || Infinity) || a.id - b.id);

// Merge player entries into the players map. Returns true if anything changed,
// so callers can skip a KV write when nothing did.
export function mergePlayers(map, entries) {
  let changed = false;
  for (const [id, info] of entries) {
    const cur = map[id];
    // Keep a known ink pair if a later response has none.
    const ink = info.ink ?? cur?.ink ?? null;
    if (!cur || cur.h !== info.h || cur.ink !== ink) {
      map[id] = { h: info.h, ink };
      changed = true;
    }
  }
  return changed;
}
