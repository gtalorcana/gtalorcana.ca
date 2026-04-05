/**
 * GTA Lorcana — ID Check Worker
 *
 * Routes:
 *   GET  /safe-to-id/event?id={event_id}  — fetch event metadata from RPH
 *   POST /safe-to-id/analyze              — run ID safety analysis
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

const CACHE_TTL = 10; // seconds — short enough to feel fresh after a standings announcement

async function fetchWithCache(cacheKey, fetchFn, ctx) {
  const cache = caches.default;
  const cacheRequest = new Request(`https://api.gtalorcana.ca/__cache__/${cacheKey}`);

  const cached = await cache.match(cacheRequest);
  console.log(`[cache] ${cacheKey}: ${cached ? 'HIT' : 'MISS'}`);
  if (cached) return cached.json();

  const data = await fetchFn();
  ctx.waitUntil(cache.put(cacheRequest, new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_TTL}` },
  })));
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

    if (url.pathname === '/safe-to-id/event' && request.method === 'GET') {
      return handleEvent(url, origin, ctx);
    }

    if (url.pathname === '/safe-to-id/analyze' && request.method === 'POST') {
      return handleAnalyze(request, origin, ctx);
    }

    return errResponse('Not found', 404, origin);
  },
};

// ── GET /safe-to-id/event?id={event_id} ────────────────────────────────────────

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

  const eventLifecycleStatus = inProgress ? 'EVENT_IN_PROGRESS' : 'EVENT_COMPLETE';

  return jsonResponse({
    event_id: eventId,
    event_name: event.name,
    player_count: event.starting_player_count,
    total_swiss_rounds: totalSwissRounds,
    current_round: currentRound,
    event_lifecycle_status: eventLifecycleStatus,
    rounds,
    players,
  }, 200, origin);
}

// ── POST /safe-to-id/analyze ────────────────────────────────────────────────────

async function handleAnalyze(request, origin, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errResponse('Invalid JSON body', 400, origin);
  }

  const {
    event_id, total_swiss_rounds, top_cut, player_id, depth,
    override_round_id, override_current_pairings_round_id,
    locked_id_rate, bubble_id_rate, monte_carlo_samples,
  } = body;
  const useCache = !override_round_id;

  if (!event_id || !total_swiss_rounds || !top_cut || !player_id || !depth) {
    return errResponse('Missing required fields: event_id, total_swiss_rounds, top_cut, player_id, depth', 400, origin);
  }
  if (!['simple', 'full'].includes(depth)) {
    return errResponse('depth must be "simple" or "full"', 400, origin);
  }

  // Fetch event to determine current round and round IDs
  let eventData;
  try {
    eventData = useCache
      ? await fetchWithCache(`event:${event_id}`, () => rphFetch(`${RPH_BASE}/events/?id=${event_id}`), ctx)
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
  let standingsRoundNumber;  // the round the standings actually reflect
  let roundsForMatches;

  if (override_round_id) {
    const overrideRound = rounds.find(r => r.id === override_round_id);
    if (!overrideRound) return errResponse('override_round_id not found in event rounds', 400, origin);
    standingsRoundId = override_round_id;
    currentRound = overrideRound.round_number;
    standingsRoundNumber = overrideRound.round_number;
    roundsForMatches = rounds.filter(r => r.round_number <= overrideRound.round_number);
  } else {
    const inProgress = rounds.find(r => r.status !== 'COMPLETE');
    currentRound = inProgress
      ? inProgress.round_number
      : rounds.length > 0 ? rounds[rounds.length - 1].round_number : 1;
    const lastCompleted = completedRounds[completedRounds.length - 1];
    standingsRoundId = lastCompleted.id;
    standingsRoundNumber = lastCompleted.round_number;
    roundsForMatches = completedRounds;
  }

  // Fetch standings
  let standingsData;
  try {
    standingsData = useCache
      ? await fetchWithCache(`standings:${standingsRoundId}`, () => rphFetch(`${RPH_BASE}/tournament-rounds/${standingsRoundId}/standings`), ctx)
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

  // Dropped players cannot play future rounds — exclude from danger counts and simulation.
  // Historical results still count for OMW% calculations.
  const droppedPlayerIds = new Set(
    standings
      .filter(s => s.user_event_status?.registration_status === 'DROPPED')
      .map(s => s.player?.id)
      .filter(id => id != null)
  );
  const isDropped = s => droppedPlayerIds.has(s.player?.id);

  // ── Incorporate known current-round results ──────────────────────────────
  // Standings are from the last completed round.  When a round is in-progress,
  // some matches are already done — incorporate those results so the danger
  // count reflects reality (e.g. a player who already lost can't reach as
  // high a point total).

  // Fetch current-round pairings (if available) to adjust points
  let currentPairingsRoundId;
  if (override_current_pairings_round_id === 'none') {
    currentPairingsRoundId = null;
  } else if (override_current_pairings_round_id) {
    currentPairingsRoundId = override_current_pairings_round_id;
  } else if (override_round_id) {
    const overrideRound = rounds.find(r => r.id === override_round_id);
    const nextRound = rounds.find(r => r.round_number === overrideRound.round_number + 1);
    currentPairingsRoundId = nextRound?.id ?? null;
  } else {
    const inProgressRound = rounds.find(r => r.status !== 'COMPLETE');
    currentPairingsRoundId = inProgressRound?.id ?? null;
  }

  let currentPairings = null;
  let pairingMatches = [];
  if (currentPairingsRoundId) {
    try {
      currentPairings = override_current_pairings_round_id
        ? await rphFetch(`${RPH_BASE}/tournament-rounds/${currentPairingsRoundId}/matches`)
        : await fetchWithCache(
            `matches:current:${currentPairingsRoundId}`,
            () => rphFetch(`${RPH_BASE}/tournament-rounds/${currentPairingsRoundId}/matches`),
            ctx
          );
      pairingMatches = currentPairings?.matches ?? currentPairings?.results ?? [];
    } catch {
      // Pairings unavailable — proceed without adjustments
    }
  }

  // Identify opponent from current-round pairings (if available)
  let opponentId = null;
  for (const m of pairingMatches) {
    if (m.match_is_bye) continue;
    const players = m.players ?? [];
    if (players.includes(player_id) && players.length >= 2) {
      opponentId = players[0] === player_id ? players[1] : players[0];
      break;
    }
  }

  // Build per-player point deltas and track who has completed their current match
  const pointDeltas = {};
  const matchDone = new Set();

  for (const m of pairingMatches) {
    const players = m.players ?? [];

    if (m.match_is_bye) {
      const pid = players[0];
      if (pid != null) {
        pointDeltas[pid] = (pointDeltas[pid] ?? 0) + 3;
        matchDone.add(pid);
      }
      continue;
    }

    if (players.length < 2) continue;
    const [p1, p2] = players;

    const isComplete = m.status === 'COMPLETE'
      || m.match_is_intentional_draw === true
      || m.match_is_unintentional_draw === true
      || m.winning_player != null;

    if (!isComplete) continue;

    matchDone.add(p1);
    matchDone.add(p2);

    if (m.match_is_intentional_draw || m.match_is_unintentional_draw) {
      pointDeltas[p1] = (pointDeltas[p1] ?? 0) + 1;
      pointDeltas[p2] = (pointDeltas[p2] ?? 0) + 1;
    } else {
      const winner = m.winning_player;
      pointDeltas[winner] = (pointDeltas[winner] ?? 0) + 3;
      // loser gets 0
    }
  }

  // Per-player effective points and max possible points
  function effectivePoints(s) {
    const pid = s.player?.id;
    return (s.points ?? 0) + (pointDeltas[pid] ?? 0);
  }

  function maxPossiblePoints(s) {
    const pid = s.player?.id;
    const pts = effectivePoints(s);
    const played = standingsRoundNumber + (matchDone.has(pid) ? 1 : 0);
    return pts + Math.max(0, total_swiss_rounds - played) * 3;
  }

  // Target player's effective state
  const adjustedPoints = effectivePoints(myStanding);
  const targetPlayed = standingsRoundNumber + (matchDone.has(player_id) ? 1 : 0);
  const roundsRemaining = Math.max(0, total_swiss_rounds - targetPlayed);
  // When all rounds are played (e.g. target had a bye), the ID question is moot —
  // use actual points rather than a hypothetical +1.
  const pointsIfIdOne = roundsRemaining > 0 ? adjustedPoints + 1 : adjustedPoints;
  const pointsIfIdTwo = roundsRemaining > 0 ? adjustedPoints + 2 : adjustedPoints;

  // Handle all-players-advance edge case
  if (playerCount > 0 && playerCount <= top_cut) {
    const response = {
      player_name: playerName,
      current_record: record,
      current_points: adjustedPoints,
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

  // Probability of gaining at least `gap` match points in `rounds` rounds.
  // Per-round outcomes: win (+3, p=0.475), draw (+1, p=0.05), loss (+0, p=0.475).
  function probReach(gap, rounds) {
    if (gap <= 0) return 1.0;
    if (gap > rounds * 3) return 0.0;
    const maxPts = rounds * 3;
    // prob[g] = probability of having exactly g points after r rounds
    let prob = new Float64Array(maxPts + 1);
    prob[0] = 1.0;
    for (let r = 0; r < rounds; r++) {
      const next = new Float64Array(maxPts + 1);
      for (let g = 0; g <= r * 3; g++) {
        if (prob[g] === 0) continue;
        next[g] += prob[g] * 0.475;       // loss: +0
        if (g + 1 <= maxPts) next[g + 1] += prob[g] * 0.05; // draw: +1
        if (g + 3 <= maxPts) next[g + 3] += prob[g] * 0.475; // win: +3
      }
      prob = next;
    }
    let cumProb = 0;
    for (let g = gap; g <= maxPts; g++) cumProb += prob[g];
    return cumProb;
  }

  function computeScenario(pointsIfId) {
    // canCatch includes dropped players so they still appear in the danger list
    // (with dropped: true), but danger_count only counts active players.
    const canCatch = otherStandings.filter(s => maxPossiblePoints(s) >= pointsIfId);
    const activeCanCatch = canCatch.filter(s => !isDropped(s));
    const alreadyAbove = activeCanCatch.filter(s => effectivePoints(s) > pointsIfId).length;
    const dangerCount = activeCanCatch.length - alreadyAbove;

    const expectedDanger = activeCanCatch.reduce((sum, s) => {
      const gap = pointsIfId - effectivePoints(s);
      return sum + probReach(gap, roundsRemaining);
    }, 0);

    let verdict;
    if (expectedDanger < top_cut - 1) verdict = 'safe';
    else if (expectedDanger < top_cut + 1) verdict = 'risky';
    else verdict = 'unsafe';

    return { pointsIfId, dangerCount, expectedDanger: Math.round(expectedDanger * 10) / 10, verdict, canCatch };
  }

  const oneRound = computeScenario(pointsIfIdOne);
  const twoRounds = roundsRemaining > 1 ? computeScenario(pointsIfIdTwo) : null;

  const targetMatchDone = matchDone.has(player_id);

  const response = {
    player_name: playerName,
    current_record: record,
    current_points: adjustedPoints,
    rounds_remaining: roundsRemaining,
    target_match_done: targetMatchDone || undefined,
    top_cut,
    depth,
    all_players_advance: false,
    id_one_round: {
      points_if_id: oneRound.pointsIfId,
      danger_count: oneRound.dangerCount,
      expected_danger: oneRound.expectedDanger,
      verdict: oneRound.verdict,
      verdict_source: 'expected',
    },
    id_two_rounds: twoRounds
      ? { points_if_id: twoRounds.pointsIfId, danger_count: twoRounds.dangerCount, expected_danger: twoRounds.expectedDanger, verdict: twoRounds.verdict, verdict_source: 'expected' }
      : null,
  };

  if (roundsRemaining <= 1) {
    response.id_two_rounds_note = 'Only 1 round remaining — double ID not applicable.';
  }

  // Opponent analysis: if pairings identify an opponent, check if they benefit from ID
  if (opponentId) {
    const oppStanding = standings.find(s => s.player?.id === opponentId);
    if (oppStanding && !isDropped(oppStanding)) {
      const oppName = oppStanding.user_event_status?.best_identifier ?? `Player ${opponentId}`;
      const oppPoints = effectivePoints(oppStanding);
      const oppPointsIfId = oppPoints + 1;
      const oppOtherStandings = standings.filter(s => s.player?.id !== opponentId);
      const oppCanCatch = oppOtherStandings.filter(s => !isDropped(s) && maxPossiblePoints(s) >= oppPointsIfId);
      const oppExpectedDanger = oppCanCatch.reduce((sum, s) => {
        const gap = oppPointsIfId - effectivePoints(s);
        return sum + probReach(gap, roundsRemaining);
      }, 0);
      const oppRoundedED = Math.round(oppExpectedDanger * 10) / 10;
      let oppVerdict;
      if (oppExpectedDanger < top_cut - 1) oppVerdict = 'safe';
      else if (oppExpectedDanger < top_cut + 1) oppVerdict = 'risky';
      else oppVerdict = 'unsafe';

      response.opponent = {
        name: oppName,
        current_points: oppPoints,
        points_if_id: oppPointsIfId,
        expected_danger: oppRoundedED,
        verdict: oppVerdict,
        will_accept_id: oppVerdict !== 'unsafe',
      };
    }
  }

  // Simple: return with unknown tiebreakers, no caveat
  if (depth === 'simple') {
    response.danger_players = oneRound.canCatch.map(s => ({
      name: s.user_event_status?.best_identifier ?? `Player ${s.player?.id}`,
      current_points: effectivePoints(s),
      max_possible_points: maxPossiblePoints(s),
      tiebreaker_vs_you: 'unknown',
      match_done: matchDone.has(s.player?.id) || undefined,
      dropped: isDropped(s) || undefined,
    })).sort((a, b) => b.max_possible_points - a.max_possible_points);
    return jsonResponse(response, 200, origin);
  }

  // Full: add tiebreaker data from standings + compute GW% from raw match data
  const myOmw = myStanding.opponent_match_win_percentage ?? 0;
  const myOgw = myStanding.opponent_game_win_percentage ?? 0;

  response.your_tiebreakers = {
    omw_pct: myOmw,
    gw_pct: null,
    ogw_pct: myOgw,
  };

  const gwByPlayer = {};
  const gamesWon = {};
  const gamesPlayed = {};
  let hist = null;

  // Helper: apply a single completed match's game data into gamesWon/gamesPlayed
  function applyGameData(match) {
    if (match.match_is_bye) return;
    const ww = match.games_won_by_winner;
    const wl = match.games_won_by_loser;
    if (ww == null || wl == null) return;
    const players = match.players ?? [];

    if (match.match_is_intentional_draw || match.match_is_unintentional_draw || match.winning_player == null) {
      // Draw: players[0] credited with games_won_by_winner, players[1] with games_won_by_loser
      const [p1, p2] = players;
      if (p1 != null) {
        gamesWon[p1] = (gamesWon[p1] ?? 0) + ww;
        gamesPlayed[p1] = (gamesPlayed[p1] ?? 0) + ww + wl;
      }
      if (p2 != null) {
        gamesWon[p2] = (gamesWon[p2] ?? 0) + wl;
        gamesPlayed[p2] = (gamesPlayed[p2] ?? 0) + ww + wl;
      }
    } else {
      const winnerId = match.winning_player;
      const loserId = players.find(p => p !== winnerId);
      gamesWon[winnerId] = (gamesWon[winnerId] ?? 0) + ww;
      gamesPlayed[winnerId] = (gamesPlayed[winnerId] ?? 0) + ww + wl;
      if (loserId != null) {
        gamesWon[loserId] = (gamesWon[loserId] ?? 0) + wl;
        gamesPlayed[loserId] = (gamesPlayed[loserId] ?? 0) + ww + wl;
      }
    }
  }

  function recomputeGwByPlayer() {
    for (const [pid, played] of Object.entries(gamesPlayed)) {
      const won = gamesWon[pid] ?? 0;
      gwByPlayer[pid] = played > 0 ? Math.max(0.33, won / played) : 0.33;
    }
  }

  if (depth === 'full') {
    let allMatchData;
    try {
      allMatchData = await Promise.all(
        roundsForMatches.map(r =>
          useCache
            ? fetchWithCache(`matches:${r.id}`, () => rphFetch(`${RPH_BASE}/tournament-rounds/${r.id}/matches`), ctx)
            : rphFetch(`${RPH_BASE}/tournament-rounds/${r.id}/matches`)
        )
      );
    } catch (e) {
      return errResponse(`RPH API error fetching matches: ${e.message}`, 502, origin);
    }

    for (const roundData of allMatchData) {
      for (const match of roundData.matches ?? roundData.results ?? []) {
        applyGameData(match);
      }
    }

    recomputeGwByPlayer();
    response.your_tiebreakers.gw_pct = gwByPlayer[player_id] ?? 0.33;

    // Build match history (wins/played/opps) for Full+ simulation
    hist = buildMatchHistory(allMatchData);
  }

  // Build danger players list, sorted by max possible points DESC then OMW% DESC
  response.danger_players = oneRound.canCatch
    .map(s => {
      const pid = s.player?.id;
      const theirOmw = s.opponent_match_win_percentage ?? 0;
      const theirOgw = s.opponent_game_win_percentage ?? 0;
      const myGw = gwByPlayer[player_id] ?? 0.33;
      const theirGw = gwByPlayer[pid] ?? 0.33;
      let tiebreakerVsYou;
      if (Math.abs(myOmw - theirOmw) > 0.01) {
        tiebreakerVsYou = myOmw > theirOmw ? 'loses' : 'wins';
      } else if (Math.abs(myGw - theirGw) > 0.01) {
        tiebreakerVsYou = myGw > theirGw ? 'loses' : 'wins';
      } else if (Math.abs(myOgw - theirOgw) > 0.01) {
        tiebreakerVsYou = myOgw > theirOgw ? 'loses' : 'wins';
      } else {
        tiebreakerVsYou = 'too_close';
      }

      const entry = {
        name: s.user_event_status?.best_identifier ?? `Player ${pid}`,
        current_points: effectivePoints(s),
        max_possible_points: maxPossiblePoints(s),
        omw_pct: theirOmw,
        gw_pct: gwByPlayer[pid] ?? 0.33,
        ogw_pct: theirOgw,
        tiebreaker_vs_you: tiebreakerVsYou,
        match_done: matchDone.has(pid) || undefined,
        dropped: isDropped(s) || undefined,
      };
      return entry;
    })
    .sort((a, b) =>
      b.max_possible_points !== a.max_possible_points
        ? b.max_possible_points - a.max_possible_points
        : b.omw_pct - a.omw_pct
    );

  response.caveat = 'Tiebreakers will shift as the current round completes.';

  // ── Full: attempt pairing simulation ─────────────────────────────────────
  // Pairings were already fetched above for point adjustments; reuse them.

  // Enrich GW% with known current-round match results before simulation.
  if (depth === 'full' && pairingMatches.length > 0) {
    for (const match of pairingMatches) {
      applyGameData(match);
    }
    recomputeGwByPlayer();
    response.your_tiebreakers.gw_pct = gwByPlayer[player_id] ?? 0.33;
  }

  if (!currentPairings || pairingMatches.length === 0) {
    response.pairings_available = false;
    return jsonResponse(response, 200, origin);
  }

  // Only run simulation when this is the last round — we can't simulate
  // future rounds because Swiss pairings depend on results we don't have.
  if (roundsRemaining <= 1) {
    const fullPlusResult = computeFullPlus({
      standings,
      hist,
      gwByPlayer,
      currentPairings,
      targetPlayerId: player_id,
      topCut: top_cut,
      currentRound,
      lockedIdRate: locked_id_rate ?? 0.90,
      bubbleIdRate: bubble_id_rate ?? 0.03,
      monteCarloSamples: monte_carlo_samples ?? 1000,
    });

    response.pairings_available = true;
    response.simulation = fullPlusResult;

    // Override verdict with simulation-based result
    if (fullPlusResult.makes_cut_pct != null) {
      const simVerdict = fullPlusResult.makes_cut_pct >= 70 ? 'safe'
                       : fullPlusResult.makes_cut_pct >= 40 ? 'risky'
                       : 'unsafe';
      response.id_one_round.verdict = simVerdict;
      response.id_one_round.verdict_source = 'simulation';
      response.id_one_round.makes_cut_pct = fullPlusResult.makes_cut_pct;
    }
  } else {
    response.pairings_available = true;
    response.simulation_note = 'Simulation skipped — multiple rounds remain and future pairings are unknown.';
  }

  return jsonResponse(response, 200, origin);
}

// ── Full+ simulation ──────────────────────────────────────────────────────────

function buildMatchHistory(allMatchData) {
  const wins = {};
  const played = {};
  const opps = {};

  for (const roundData of allMatchData) {
    const matches = roundData.matches ?? roundData.results ?? [];
    for (const match of matches) {
      const players = match.players ?? [];

      // Byes count as +1 win and +1 played for the recipient's own match record
      // (which affects OMW% of anyone who later plays them). No opponent to track.
      if (match.match_is_bye) {
        const pid = players[0];
        if (pid != null) {
          wins[pid] = (wins[pid] ?? 0) + 1;
          played[pid] = (played[pid] ?? 0) + 1;
        }
        continue;
      }

      if (players.length < 2) continue;
      const [p1, p2] = players;

      opps[p1] = opps[p1] ?? [];
      opps[p2] = opps[p2] ?? [];
      opps[p1].push(p2);
      opps[p2].push(p1);

      played[p1] = (played[p1] ?? 0) + 1;
      played[p2] = (played[p2] ?? 0) + 1;

      if (!match.match_is_intentional_draw && !match.match_is_unintentional_draw) {
        const w = match.winning_player;
        if (w != null) wins[w] = (wins[w] ?? 0) + 1;
      }
    }
  }

  return { wins, played, opps };
}

function computeFullPlus({ standings, hist, gwByPlayer, currentPairings, targetPlayerId, topCut, currentRound, lockedIdRate = 0.90, bubbleIdRate = 0.03, monteCarloSamples = 1000 }) {
  const EXHAUSTIVE_THRESHOLD = 12;
  const MONTE_CARLO_SAMPLES = Math.min(Math.max(Math.floor(monteCarloSamples), 100), 10000);

  // Per-player lookup from standings
  const standingsMap = {};
  for (const s of standings) {
    const pid = s.player?.id;
    if (pid == null) continue;
    standingsMap[pid] = {
      pts: s.points ?? 0,
      omw: s.opponent_match_win_percentage ?? 0,
      gw: gwByPlayer[pid] ?? 0.33,
      ogw: s.opponent_game_win_percentage ?? 0,
    };
  }

  // Check if target has a bye — byes are auto-wins, not ID-able
  const pairingMatches = currentPairings.matches ?? currentPairings.results ?? [];
  const targetHasBye = pairingMatches.some(m =>
    m.match_is_bye && (m.players ?? []).includes(targetPlayerId)
  );

  const targetPts = standingsMap[targetPlayerId]?.pts ?? 0;

  // Check if the target's match is already complete so we use the actual result
  // rather than the hypothetical ID. This matters when all-but-one matches are
  // done and the target's own match finished before they ran the tool.
  let targetMatchAlreadyDone = false;
  let targetActualDelta = 1; // default: assume ID (+1)
  if (!targetHasBye) {
    for (const m of pairingMatches) {
      const players = m.players ?? [];
      if (m.match_is_bye || players.length < 2) continue;
      if (!players.includes(targetPlayerId)) continue;
      if (isKnownResult(m)) {
        targetMatchAlreadyDone = true;
        if (m.match_is_intentional_draw || m.match_is_unintentional_draw) {
          targetActualDelta = 1;
        } else if (m.winning_player === targetPlayerId) {
          targetActualDelta = 3;
        } else {
          targetActualDelta = 0;
        }
      }
      break;
    }
  }

  // Bye targets keep their bye points; non-bye targets get their actual delta if the
  // match is done, or +1 for the hypothetical ID if it hasn't been played yet.
  const targetPointsAfterID = targetPts + (targetHasBye ? 3 : targetActualDelta);

  // Classify a player by their situation relative to the cut line.
  // locked: already at or above the points target — safe even without winning
  // bubble: can reach the target by winning this round
  // other:  below the bubble
  function classifyPlayer(pid) {
    const pts = standingsMap[pid]?.pts ?? 0;
    if (pts >= targetPointsAfterID) return 'locked';
    if (pts + 3 >= targetPointsAfterID) return 'bubble';
    return 'other';
  }

  // Probability that an unknown match ends in an intentional draw.
  // Outcomes: draw, p1 wins, p2 wins — each unknown match supplies its own idProbability.
  function getIdProbability(p1, p2) {
    const c1 = classifyPlayer(p1);
    const c2 = classifyPlayer(p2);
    if (c1 === 'locked' && c2 === 'locked') return lockedIdRate;
    if (c1 === 'locked' || c2 === 'locked') return 0.10;
    if (c1 === 'bubble' && c2 === 'bubble') return bubbleIdRate;
    return 0.02;
  }

  // A match result is already known when the status is COMPLETE,
  // draw flags are set, or a winner is recorded.
  function isKnownResult(m) {
    return m.status === 'COMPLETE'
      || m.match_is_intentional_draw === true
      || m.match_is_unintentional_draw === true
      || m.winning_player != null;
  }

  // Process current round matches — split into known (applied as facts)
  // and unknown (to be simulated).

  const knownAddWins = {};
  const knownAddPlayed = {};
  const knownPtDelta = {};
  const currentRoundOpps = {};
  const unknownMatches = [];
  let knownResultsCount = 0;

  // Target player: use actual delta if their match is already done, else assume ID (+1).
  // Byes are handled in the loop below.
  if (!targetHasBye) {
    knownPtDelta[targetPlayerId] = targetActualDelta;
    knownAddPlayed[targetPlayerId] = 1;
  }

  for (const m of pairingMatches) {
    const players = m.players ?? [];

    // Bye — always a known result; counts as a match win for OMW% purposes
    if (m.match_is_bye) {
      const pid = players[0];
      if (pid != null) {
        knownPtDelta[pid] = (knownPtDelta[pid] ?? 0) + 3;
        knownAddWins[pid] = (knownAddWins[pid] ?? 0) + 1;
        knownAddPlayed[pid] = (knownAddPlayed[pid] ?? 0) + 1;
      }
      knownResultsCount++;
      continue;
    }

    if (players.length < 2) continue;
    const [p1, p2] = players;

    // Target player's match: if already done use the actual result; otherwise assume ID.
    if (p1 === targetPlayerId || p2 === targetPlayerId) {
      const opp = p1 === targetPlayerId ? p2 : p1;
      currentRoundOpps[targetPlayerId] = opp;
      currentRoundOpps[opp] = targetPlayerId;
      knownResultsCount++;
      knownAddPlayed[opp] = (knownAddPlayed[opp] ?? 0) + 1;
      if (targetMatchAlreadyDone) {
        // Mirror the target's actual result for the opponent
        if (targetActualDelta === 1) {
          // Draw — opponent also gets +1
          knownPtDelta[opp] = (knownPtDelta[opp] ?? 0) + 1;
        } else if (targetActualDelta === 3) {
          // Target won — opponent gets 0 (no entry needed)
        } else {
          // Target lost — opponent won, gets +3
          knownAddWins[opp] = (knownAddWins[opp] ?? 0) + 1;
          knownPtDelta[opp] = (knownPtDelta[opp] ?? 0) + 3;
        }
      } else {
        // Match not yet played — assume mutual ID
        knownPtDelta[opp] = (knownPtDelta[opp] ?? 0) + 1;
      }
      continue;
    }

    currentRoundOpps[p1] = p2;
    currentRoundOpps[p2] = p1;

    if (isKnownResult(m)) {
      knownResultsCount++;
      knownAddPlayed[p1] = (knownAddPlayed[p1] ?? 0) + 1;
      knownAddPlayed[p2] = (knownAddPlayed[p2] ?? 0) + 1;
      if (m.match_is_intentional_draw || m.match_is_unintentional_draw) {
        knownPtDelta[p1] = (knownPtDelta[p1] ?? 0) + 1;
        knownPtDelta[p2] = (knownPtDelta[p2] ?? 0) + 1;
      } else {
        const winner = m.winning_player;
        const loser = winner === p1 ? p2 : p1;
        knownAddWins[winner] = (knownAddWins[winner] ?? 0) + 1;
        knownPtDelta[winner] = (knownPtDelta[winner] ?? 0) + 3;
      }
    } else {
      unknownMatches.push({ p1, p2, idProbability: getIdProbability(p1, p2) });
    }
  }

  const N = unknownMatches.length;
  const isExhaustive = N <= EXHAUSTIVE_THRESHOLD;

  // allPlayers array for ranking — exclude dropped players (they don't place)
  const allPlayers = standings
    .filter(s => s.player?.id != null && s.user_event_status?.registration_status !== 'DROPPED')
    .map(s => ({
      pid: s.player.id,
      basePoints: s.points ?? 0,
      gw: gwByPlayer[s.player.id] ?? 0.33,
      ogw: s.opponent_game_win_percentage ?? 0,
    }));

  // Simulate one combination of unknown match outcomes and return the target's rank.
  // outcomes: [{ p1, p2, outcome }]  outcome: 0=draw, 1=p1 wins, 2=p2 wins
  function simulateScenario(outcomes) {
    const ptDelta = { ...knownPtDelta };

    for (const { p1, p2, outcome } of outcomes) {
      if (outcome === 0) {
        ptDelta[p1] = (ptDelta[p1] ?? 0) + 1;
        ptDelta[p2] = (ptDelta[p2] ?? 0) + 1;
      } else if (outcome === 1) {
        ptDelta[p1] = (ptDelta[p1] ?? 0) + 3;
      } else {
        ptDelta[p2] = (ptDelta[p2] ?? 0) + 3;
      }
    }

    // RPH OMW% formula: average of opponents' match point % = points / (3 × rounds),
    // floor 0.33. This exactly matches what RPH reports in standings.
    // Using final simulated points for each opponent so OMW% reflects this scenario.
    // After the current round completes, each player has played `currentRound` rounds.
    // (currentRound is the in-progress round number, e.g. 4 for round 4.)
    const totalRounds = currentRound;
    function omwOf(pid) {
      const pastOpps = hist.opps[pid] ?? [];
      const currOpp = currentRoundOpps[pid];
      const allOpps = currOpp != null ? [...pastOpps, currOpp] : pastOpps;
      if (allOpps.length === 0) return standingsMap[pid]?.omw ?? 0;
      const sum = allOpps.reduce((acc, opp) => {
        const finalPts = (standingsMap[opp]?.pts ?? 0) + (ptDelta[opp] ?? 0);
        return acc + Math.max(0.33, finalPts / (3 * totalRounds));
      }, 0);
      return sum / allOpps.length;
    }

    return allPlayers.map(({ pid, basePoints, gw, ogw }) => ({
      pid,
      pts: basePoints + (ptDelta[pid] ?? 0),
      omw: omwOf(pid),
      gw,
      ogw,
    })).sort((a, b) => {
      if (b.pts !== a.pts) return b.pts - a.pts;
      const omwD = b.omw - a.omw;
      if (Math.abs(omwD) > 0.0001) return omwD;
      const gwD = b.gw - a.gw;
      if (Math.abs(gwD) > 0.0001) return gwD;
      return b.ogw - a.ogw;
    }).findIndex(p => p.pid === targetPlayerId) + 1;
  }

  function playerName(pid) {
    const s = standings.find(s => s.player?.id === pid);
    return s?.user_event_status?.best_identifier ?? `Player ${pid}`;
  }

  function scenarioToNames(outcomes) {
    return outcomes.map(({ p1, p2, outcome }) => {
      if (outcome === 0) return { type: 'draw', players: [playerName(p1), playerName(p2)] };
      const winner = outcome === 1 ? p1 : p2;
      const loser = outcome === 1 ? p2 : p1;
      return { type: 'win', winner: playerName(winner), loser: playerName(loser) };
    });
  }

  let makesCutCount = 0;
  let weightedMakesCut = 0;
  let totalWeight = 0;
  let bestRank = Infinity;
  let worstRank = 0;
  let bestScenario = null;
  let worstScenario = null;

  if (isExhaustive) {
    const total = Math.pow(3, N);
    for (let combo = 0; combo < total; combo++) {
      const outcomes = unknownMatches.map((m, i) => {
        const digit = Math.floor(combo / Math.pow(3, i)) % 3;
        return { p1: m.p1, p2: m.p2, outcome: digit, idProbability: m.idProbability };
      });
      // Weight this scenario by the product of each outcome's probability so that
      // high-idProbability matches (e.g. locked vs locked at 0.90) count more than
      // low-probability decisive results. Without this, all 3^N scenarios are equal
      // which badly skews the % when idProbability varies across matches.
      let weight = 1;
      for (const { outcome, idProbability } of outcomes) {
        weight *= outcome === 0 ? idProbability : (1 - idProbability) * 0.5;
      }
      const rank = simulateScenario(outcomes);
      totalWeight += weight;
      if (rank <= topCut) {
        makesCutCount++;
        weightedMakesCut += weight;
      }
      if (rank < bestRank) { bestRank = rank; bestScenario = outcomes; }
      if (rank > worstRank) { worstRank = rank; worstScenario = outcomes; }
    }
    const bubbleOnly = outcomes => outcomes.filter(({ p1, p2 }) =>
      classifyPlayer(p1) === 'bubble' || classifyPlayer(p2) === 'bubble'
    );
    bestScenario = bestScenario ? scenarioToNames(bubbleOnly(bestScenario)) : null;
    worstScenario = worstScenario ? scenarioToNames(bubbleOnly(worstScenario)) : null;
  } else {
    for (let i = 0; i < MONTE_CARLO_SAMPLES; i++) {
      const outcomes = unknownMatches.map(m => {
        const roll = Math.random();
        let outcome;
        if (roll < m.idProbability) outcome = 0;
        else if (roll < m.idProbability + (1 - m.idProbability) * 0.5) outcome = 1;
        else outcome = 2;
        return { p1: m.p1, p2: m.p2, outcome };
      });
      const rank = simulateScenario(outcomes);
      if (rank <= topCut) makesCutCount++;
      if (rank < bestRank) bestRank = rank;
      if (rank > worstRank) worstRank = rank;
    }
    totalWeight = MONTE_CARLO_SAMPLES;
    weightedMakesCut = makesCutCount;
  }

  const makesCutPct = totalWeight > 0
    ? parseFloat(((weightedMakesCut / totalWeight) * 100).toFixed(1))
    : 0;

  return {
    simulation_mode: isExhaustive ? 'exhaustive' : 'monte_carlo',
    total_scenarios: isExhaustive ? Math.pow(3, N) : MONTE_CARLO_SAMPLES,
    makes_cut_scenarios: makesCutCount,
    makes_cut_pct: makesCutPct,
    margin_of_error_pct: isExhaustive ? 0 : 3.5,
    best_rank: bestRank === Infinity ? null : bestRank,
    worst_rank: worstRank === 0 ? null : worstRank,
    known_results: knownResultsCount,
    unknown_results: N,
    best_scenario: isExhaustive ? bestScenario : null,
    worst_scenario: isExhaustive ? worstScenario : null,
  };
}
