/**
 * GTA Lorcana — ID Check Worker
 *
 * Routes:
 *   GET  /id-check/event?id={event_id}  — fetch event metadata from RPH
 *   POST /id-check/analyze              — run ID safety analysis
 */

const RPH_BASE = 'https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2';

const ALLOWED_ORIGINS = [
  'https://gtalorcana.ca',
  'https://www.gtalorcana.ca',
  'http://localhost',
  'http://127.0.0.1',
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.some(o => origin && origin.startsWith(o));
  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'https://gtalorcana.ca',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(data, status = 200, origin = '') {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function errResponse(message, status, origin) {
  return jsonResponse({ error: message }, status, origin);
}

async function rphFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`RPH returned ${res.status} for ${url}`);
  return res.json();
}

async function fetchWithCache(cacheKey, fetchFn, ttl, ctx) {
  const cache = caches.default;
  const cacheUrl = new URL(`https://api.gtalorcana.ca/__cache__/${cacheKey}`);
  const cacheRequest = new Request(cacheUrl.toString());

  const cached = await cache.match(cacheRequest);
  console.log(`[cache] ${cacheKey}: ${cached ? 'HIT' : 'MISS'}`);
  if (cached) return cached.json();

  const data = await fetchFn();

  const cacheResponse = new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${ttl}`,
    },
  });
  ctx.waitUntil(cache.put(cacheRequest, cacheResponse));

  return data;
}

// ── Router ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === '/id-check/event' && request.method === 'GET') {
      return handleEvent(url, origin, ctx);
    }

    if (url.pathname === '/id-check/analyze' && request.method === 'POST') {
      return handleAnalyze(request, origin, ctx);
    }

    return errResponse('Not found', 404, origin);
  },
};

// ── GET /id-check/event?id={event_id} ────────────────────────────────────────

async function handleEvent(url, origin, ctx) {
  const eventIdStr = url.searchParams.get('id');
  if (!eventIdStr || !/^\d+$/.test(eventIdStr)) {
    return errResponse('Missing or invalid event ID', 400, origin);
  }
  const eventId = parseInt(eventIdStr, 10);

  // Fetch event from RPH
  let eventData;
  try {
    eventData = await fetchWithCache(
      `event:${eventId}`,
      () => rphFetch(`${RPH_BASE}/events/?id=${eventId}`),
      60,
      ctx
    );
  } catch (e) {
    return errResponse(`RPH API error: ${e.message}`, 502, origin);
  }

  const results = eventData.results ?? [];
  if (results.length === 0) {
    return errResponse('Event not found', 404, origin);
  }
  const event = results[0];

  // Find the Swiss phase
  const phases = event.tournament_phases ?? [];
  const swissPhase = phases.find(p => p.round_type === 'SWISS') ?? phases[0];
  if (!swissPhase) {
    return errResponse('Event has no tournament phases', 400, origin);
  }

  const rounds = (swissPhase.rounds ?? []).map(r => ({
    id: r.id,
    round_number: r.round_number,
    status: r.status,
  }));
  const totalSwissRounds = rounds.length;

  // Determine current round (first non-complete, or last round if all done)
  const inProgress = rounds.find(r => r.status !== 'COMPLETE');
  const currentRound = inProgress
    ? inProgress.round_number
    : rounds.length > 0 ? rounds[rounds.length - 1].round_number : 1;

  // Find last completed round
  const completedRounds = rounds.filter(r => r.status === 'COMPLETE');
  if (completedRounds.length === 0) {
    return errResponse('No completed rounds yet — nothing to analyze', 400, origin);
  }
  const lastCompleted = completedRounds[completedRounds.length - 1];

  // Fetch standings for last completed round (used to build player list)
  let standingsData;
  try {
    standingsData = await fetchWithCache(
      `standings:${lastCompleted.id}`,
      () => rphFetch(`${RPH_BASE}/tournament-rounds/${lastCompleted.id}/standings`),
      60,
      ctx
    );
  } catch (e) {
    return errResponse(`RPH API error fetching standings: ${e.message}`, 502, origin);
  }

  const standings = standingsData.standings ?? [];
  const players = standings
    .map(s => ({
      id: s.player?.id,
      name: s.user_event_status?.best_identifier ?? `Player ${s.player?.id}`,
    }))
    .filter(p => p.id != null)
    .sort((a, b) => a.name.localeCompare(b.name));

  return jsonResponse({
    event_id: eventId,
    event_name: event.name,
    player_count: event.starting_player_count,
    total_swiss_rounds: totalSwissRounds,
    current_round: currentRound,
    rounds,
    players,
  }, 200, origin);
}

// ── POST /id-check/analyze ────────────────────────────────────────────────────

async function handleAnalyze(request, origin, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errResponse('Invalid JSON body', 400, origin);
  }

  const { event_id, total_swiss_rounds, top_cut, player_id, depth, override_round_id } = body;
  const useCache = !override_round_id;

  if (!event_id || !total_swiss_rounds || !top_cut || !player_id || !depth) {
    return errResponse('Missing required fields: event_id, total_swiss_rounds, top_cut, player_id, depth', 400, origin);
  }
  if (!['simple', 'medium', 'full'].includes(depth)) {
    return errResponse('depth must be "simple", "medium", or "full"', 400, origin);
  }

  // Fetch event to determine current round and round IDs
  let eventData;
  try {
    eventData = useCache
      ? await fetchWithCache(`event:${event_id}`, () => rphFetch(`${RPH_BASE}/events/?id=${event_id}`), 60, ctx)
      : await rphFetch(`${RPH_BASE}/events/?id=${event_id}`);
  } catch (e) {
    return errResponse(`RPH API error: ${e.message}`, 502, origin);
  }

  const results = eventData.results ?? [];
  if (results.length === 0) return errResponse('Event not found', 404, origin);
  const event = results[0];
  const playerCount = event.starting_player_count ?? 0;

  const phases = event.tournament_phases ?? [];
  const swissPhase = phases.find(p => p.round_type === 'SWISS') ?? phases[0];
  if (!swissPhase) return errResponse('Event has no tournament phases', 400, origin);

  const rounds = (swissPhase.rounds ?? []).map(r => ({
    id: r.id,
    round_number: r.round_number,
    status: r.status,
  }));

  const completedRounds = rounds.filter(r => r.status === 'COMPLETE');
  if (completedRounds.length === 0) {
    return errResponse('No completed rounds yet — nothing to analyze', 400, origin);
  }

  // Determine which round's standings to use and what currentRound is
  let standingsRoundId;
  let currentRound;
  let roundsForMatches;

  if (override_round_id) {
    const overrideRound = rounds.find(r => r.id === override_round_id);
    if (!overrideRound) return errResponse('override_round_id not found in event rounds', 400, origin);
    standingsRoundId = override_round_id;
    currentRound = overrideRound.round_number;
    roundsForMatches = rounds.filter(r => r.round_number <= overrideRound.round_number);
  } else {
    const inProgress = rounds.find(r => r.status !== 'COMPLETE');
    currentRound = inProgress
      ? inProgress.round_number
      : rounds.length > 0 ? rounds[rounds.length - 1].round_number : 1;
    const lastCompleted = completedRounds[completedRounds.length - 1];
    standingsRoundId = lastCompleted.id;
    roundsForMatches = completedRounds;
  }

  // Fetch standings
  let standingsData;
  try {
    standingsData = useCache
      ? await fetchWithCache(`standings:${standingsRoundId}`, () => rphFetch(`${RPH_BASE}/tournament-rounds/${standingsRoundId}/standings`), 60, ctx)
      : await rphFetch(`${RPH_BASE}/tournament-rounds/${standingsRoundId}/standings`);
  } catch (e) {
    return errResponse(`RPH API error fetching standings: ${e.message}`, 502, origin);
  }

  const standings = standingsData.standings ?? [];

  // Find target player
  const myStanding = standings.find(s => s.player?.id === player_id);
  if (!myStanding) return errResponse('Player not found in standings', 404, origin);

  const playerName = myStanding.user_event_status?.best_identifier ?? `Player ${player_id}`;
  const currentPoints = myStanding.points ?? 0;
  const record = myStanding.record ?? '0-0-0';

  const roundsRemaining = Math.max(0, total_swiss_rounds - currentRound);
  const pointsIfIdOne = currentPoints + 1;
  const pointsIfIdTwo = currentPoints + 2;

  // Handle all-players-advance edge case
  if (playerCount > 0 && playerCount <= top_cut) {
    const response = {
      player_name: playerName,
      current_record: record,
      current_points: currentPoints,
      rounds_remaining: roundsRemaining,
      top_cut,
      depth,
      all_players_advance: true,
      id_one_round: { points_if_id: pointsIfIdOne, danger_count: 0, verdict: 'safe' },
      id_two_rounds: roundsRemaining > 1
        ? { points_if_id: pointsIfIdTwo, danger_count: 0, verdict: 'safe' }
        : null,
      caveat: 'Top cut equals or exceeds player count — all players advance.',
    };
    if (roundsRemaining <= 1) {
      response.id_two_rounds_note = 'Only 1 round remaining — double ID not applicable.';
    }
    return jsonResponse(response, 200, origin);
  }

  const otherStandings = standings.filter(s => s.player?.id !== player_id);

  function computeScenario(pointsIfId) {
    const alreadyAbove = otherStandings.filter(s => (s.points ?? 0) > pointsIfId).length;
    const canCatch = otherStandings.filter(s =>
      (s.points ?? 0) + roundsRemaining * 3 >= pointsIfId
    );
    const dangerCount = canCatch.length - alreadyAbove;
    let verdict;
    if (dangerCount < top_cut) verdict = 'safe';
    else if (dangerCount === top_cut) verdict = 'risky';
    else verdict = 'unsafe';
    return { pointsIfId, dangerCount, verdict, canCatch };
  }

  const oneRound = computeScenario(pointsIfIdOne);
  const twoRounds = roundsRemaining > 1 ? computeScenario(pointsIfIdTwo) : null;

  const response = {
    player_name: playerName,
    current_record: record,
    current_points: currentPoints,
    rounds_remaining: roundsRemaining,
    top_cut,
    depth,
    all_players_advance: false,
    id_one_round: {
      points_if_id: oneRound.pointsIfId,
      danger_count: oneRound.dangerCount,
      verdict: oneRound.verdict,
    },
    id_two_rounds: twoRounds
      ? { points_if_id: twoRounds.pointsIfId, danger_count: twoRounds.dangerCount, verdict: twoRounds.verdict }
      : null,
  };

  if (roundsRemaining <= 1) {
    response.id_two_rounds_note = 'Only 1 round remaining — double ID not applicable.';
  }

  // Simple: return with unknown tiebreakers, no caveat
  if (depth === 'simple') {
    response.danger_players = oneRound.canCatch.map(s => ({
      name: s.user_event_status?.best_identifier ?? `Player ${s.player?.id}`,
      current_points: s.points ?? 0,
      max_possible_points: (s.points ?? 0) + roundsRemaining * 3,
      tiebreaker_vs_you: 'unknown',
    })).sort((a, b) => b.max_possible_points - a.max_possible_points);
    return jsonResponse(response, 200, origin);
  }

  // Medium + Full: add tiebreaker data from standings
  const myOmw = myStanding.opponent_match_win_percentage ?? 0;
  const myOgw = myStanding.opponent_game_win_percentage ?? 0;

  response.your_tiebreakers = {
    omw_pct: myOmw,
    gw_pct: null,
    ogw_pct: myOgw,
  };

  // Full: compute GW% for every player from raw match history
  const gwByPlayer = {};
  if (depth === 'full') {
    let allMatchData;
    try {
      allMatchData = await Promise.all(
        roundsForMatches.map(r =>
          useCache
            ? fetchWithCache(`matches:${r.id}`, () => rphFetch(`${RPH_BASE}/tournament-rounds/${r.id}/matches`), 300, ctx)
            : rphFetch(`${RPH_BASE}/tournament-rounds/${r.id}/matches`)
        )
      );
    } catch (e) {
      return errResponse(`RPH API error fetching matches: ${e.message}`, 502, origin);
    }

    const gamesWon = {};
    const gamesPlayed = {};

    for (const roundData of allMatchData) {
      const matches = roundData.matches ?? roundData.results ?? [];
      for (const match of matches) {
        if (match.match_is_bye) {
          const pid = match.players?.[0];
          if (pid != null) {
            gamesWon[pid] = (gamesWon[pid] ?? 0) + 2;
            gamesPlayed[pid] = (gamesPlayed[pid] ?? 0) + 2;
          }
          continue;
        }
        // Skip draws (no game wins to attribute)
        if (match.match_is_intentional_draw || match.match_is_unintentional_draw) continue;

        const winnerId = match.winning_player;
        const players = match.players ?? [];
        const loserId = players.find(p => p !== winnerId);
        const ww = match.games_won_by_winner ?? 0;
        const wl = match.games_won_by_loser ?? 0;

        if (winnerId != null) {
          gamesWon[winnerId] = (gamesWon[winnerId] ?? 0) + ww;
          gamesPlayed[winnerId] = (gamesPlayed[winnerId] ?? 0) + ww + wl;
        }
        if (loserId != null) {
          gamesWon[loserId] = (gamesWon[loserId] ?? 0) + wl;
          gamesPlayed[loserId] = (gamesPlayed[loserId] ?? 0) + ww + wl;
        }
      }
    }

    for (const [pid, played] of Object.entries(gamesPlayed)) {
      const won = gamesWon[pid] ?? 0;
      gwByPlayer[pid] = played > 0 ? Math.max(0.33, won / played) : 0.33;
    }

    response.your_tiebreakers.gw_pct = gwByPlayer[player_id] ?? 0.33;
  }

  // Build danger players list, sorted by max possible points DESC then OMW% DESC
  response.danger_players = oneRound.canCatch
    .map(s => {
      const pid = s.player?.id;
      const theirOmw = s.opponent_match_win_percentage ?? 0;
      const theirOgw = s.opponent_game_win_percentage ?? 0;
      const maxPossible = (s.points ?? 0) + roundsRemaining * 3;

      let tiebreakerVsYou;
      if (depth === 'full') {
        const myGw = gwByPlayer[player_id] ?? 0.33;
        const theirGw = gwByPlayer[pid] ?? 0.33;
        if (Math.abs(myOmw - theirOmw) > 0.01) {
          tiebreakerVsYou = myOmw > theirOmw ? 'loses' : 'wins';
        } else if (Math.abs(myGw - theirGw) > 0.01) {
          tiebreakerVsYou = myGw > theirGw ? 'loses' : 'wins';
        } else if (Math.abs(myOgw - theirOgw) > 0.01) {
          tiebreakerVsYou = myOgw > theirOgw ? 'loses' : 'wins';
        } else {
          tiebreakerVsYou = 'too_close';
        }
      } else {
        // Medium: OMW% → OGW%
        if (Math.abs(myOmw - theirOmw) > 0.01) {
          tiebreakerVsYou = myOmw > theirOmw ? 'loses' : 'wins';
        } else if (Math.abs(myOgw - theirOgw) > 0.01) {
          tiebreakerVsYou = myOgw > theirOgw ? 'loses' : 'wins';
        } else {
          tiebreakerVsYou = 'too_close';
        }
      }

      const entry = {
        name: s.user_event_status?.best_identifier ?? `Player ${pid}`,
        current_points: s.points ?? 0,
        max_possible_points: maxPossible,
        omw_pct: theirOmw,
        ogw_pct: theirOgw,
        tiebreaker_vs_you: tiebreakerVsYou,
      };
      if (depth === 'full') entry.gw_pct = gwByPlayer[pid] ?? 0.33;
      return entry;
    })
    .sort((a, b) =>
      b.max_possible_points !== a.max_possible_points
        ? b.max_possible_points - a.max_possible_points
        : b.omw_pct - a.omw_pct
    );

  response.caveat = 'Tiebreakers will shift as the current round completes.';

  return jsonResponse(response, 200, origin);
}
