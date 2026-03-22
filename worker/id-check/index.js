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

  const {
    event_id, total_swiss_rounds, top_cut, player_id, depth,
    override_round_id, override_current_pairings_round_id,
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

  // Full: add tiebreaker data from standings + compute GW% from raw match data
  const myOmw = myStanding.opponent_match_win_percentage ?? 0;
  const myOgw = myStanding.opponent_game_win_percentage ?? 0;

  response.your_tiebreakers = {
    omw_pct: myOmw,
    gw_pct: null,
    ogw_pct: myOgw,
  };

  const gwByPlayer = {};
  let hist = null;

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

    // Build match history (wins/played/opps) for Full+ simulation
    hist = buildMatchHistory(allMatchData);
  }

  // Build danger players list, sorted by max possible points DESC then OMW% DESC
  response.danger_players = oneRound.canCatch
    .map(s => {
      const pid = s.player?.id;
      const theirOmw = s.opponent_match_win_percentage ?? 0;
      const theirOgw = s.opponent_game_win_percentage ?? 0;
      const maxPossible = (s.points ?? 0) + roundsRemaining * 3;

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
        current_points: s.points ?? 0,
        max_possible_points: maxPossible,
        omw_pct: theirOmw,
        gw_pct: gwByPlayer[pid] ?? 0.33,
        ogw_pct: theirOgw,
        tiebreaker_vs_you: tiebreakerVsYou,
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

  // Determine which round to use for current pairings
  let currentPairingsRoundId;
  if (override_current_pairings_round_id) {
    currentPairingsRoundId = override_current_pairings_round_id;
  } else if (override_round_id) {
    const overrideRound = rounds.find(r => r.id === override_round_id);
    const nextRound = rounds.find(r => r.round_number === overrideRound.round_number + 1);
    currentPairingsRoundId = nextRound?.id ?? null;
  } else {
    const inProgressRound = rounds.find(r => r.status !== 'COMPLETE');
    currentPairingsRoundId = inProgressRound?.id ?? null;
  }

  if (!currentPairingsRoundId) {
    response.pairings_available = false;
    return jsonResponse(response, 200, origin);
  }

  // Fetch current round pairings
  let currentPairings;
  try {
    currentPairings = override_current_pairings_round_id
      ? await rphFetch(`${RPH_BASE}/tournament-rounds/${currentPairingsRoundId}/matches`)
      : await fetchWithCache(
          `matches:current:${currentPairingsRoundId}`,
          () => rphFetch(`${RPH_BASE}/tournament-rounds/${currentPairingsRoundId}/matches`),
          30,
          ctx
        );
  } catch (e) {
    return errResponse(`RPH API error fetching current pairings: ${e.message}`, 502, origin);
  }

  const pairingMatches = currentPairings.matches ?? currentPairings.results ?? [];
  if (pairingMatches.length === 0) {
    response.pairings_available = false;
    return jsonResponse(response, 200, origin);
  }

  const fullPlusResult = computeFullPlus({
    standings,
    hist,
    gwByPlayer,
    currentPairings,
    targetPlayerId: player_id,
    topCut: top_cut,
  });

  response.pairings_available = true;
  response.simulation = fullPlusResult;

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
      if (match.match_is_bye || players.length < 2) continue;
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

function computeFullPlus({ standings, hist, gwByPlayer, currentPairings, targetPlayerId, topCut }) {
  const EXHAUSTIVE_THRESHOLD = 12;
  const MONTE_CARLO_SAMPLES = 1000;

  // Per-player lookup from standings
  const standingsMap = {};
  for (const s of standings) {
    const pid = s.player?.id;
    if (pid == null) continue;
    standingsMap[pid] = {
      pts: s.points ?? 0,
      gw: gwByPlayer[pid] ?? 0.33,
      ogw: s.opponent_game_win_percentage ?? 0,
    };
  }

  const targetPts = standingsMap[targetPlayerId]?.pts ?? 0;
  const targetPointsAfterID = targetPts + 1;

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
    if (c1 === 'locked' && c2 === 'locked') return 0.90;
    if (c1 === 'locked' || c2 === 'locked') return 0.10; // one locked, one not
    if (c1 === 'bubble' && c2 === 'bubble') return 0.03;
    return 0.02; // neither near cut
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
  const pairingMatches = currentPairings.matches ?? currentPairings.results ?? [];

  const knownAddWins = {};
  const knownAddPlayed = {};
  const knownPtDelta = {};
  const currentRoundOpps = {};
  const unknownMatches = [];
  let knownResultsCount = 0;

  // Target player always IDs (+1 point each, +1 played for both, no win credited)
  knownPtDelta[targetPlayerId] = 1;
  knownAddPlayed[targetPlayerId] = 1;

  for (const m of pairingMatches) {
    const players = m.players ?? [];

    // Bye — always a known result
    if (m.match_is_bye) {
      const pid = players[0];
      if (pid != null) knownPtDelta[pid] = (knownPtDelta[pid] ?? 0) + 3;
      knownResultsCount++;
      continue;
    }

    if (players.length < 2) continue;
    const [p1, p2] = players;

    // Target player's match: treated as ID regardless of actual status
    if (p1 === targetPlayerId || p2 === targetPlayerId) {
      const opp = p1 === targetPlayerId ? p2 : p1;
      knownPtDelta[opp] = (knownPtDelta[opp] ?? 0) + 1;
      knownAddPlayed[opp] = (knownAddPlayed[opp] ?? 0) + 1;
      currentRoundOpps[targetPlayerId] = opp;
      currentRoundOpps[opp] = targetPlayerId;
      knownResultsCount++;
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

  // allPlayers array for ranking
  const allPlayers = standings
    .filter(s => s.player?.id != null)
    .map(s => ({
      pid: s.player.id,
      basePoints: s.points ?? 0,
      gw: gwByPlayer[s.player.id] ?? 0.33,
      ogw: s.opponent_game_win_percentage ?? 0,
    }));

  // Simulate one combination of unknown match outcomes and return the target's rank.
  // outcomes: [{ p1, p2, outcome }]  outcome: 0=draw, 1=p1 wins, 2=p2 wins
  function simulateScenario(outcomes) {
    const addWins = { ...knownAddWins };
    const addPlayed = { ...knownAddPlayed };
    const ptDelta = { ...knownPtDelta };

    for (const { p1, p2, outcome } of outcomes) {
      addPlayed[p1] = (addPlayed[p1] ?? 0) + 1;
      addPlayed[p2] = (addPlayed[p2] ?? 0) + 1;
      if (outcome === 0) {
        ptDelta[p1] = (ptDelta[p1] ?? 0) + 1;
        ptDelta[p2] = (ptDelta[p2] ?? 0) + 1;
      } else if (outcome === 1) {
        addWins[p1] = (addWins[p1] ?? 0) + 1;
        ptDelta[p1] = (ptDelta[p1] ?? 0) + 3;
      } else {
        addWins[p2] = (addWins[p2] ?? 0) + 1;
        ptDelta[p2] = (ptDelta[p2] ?? 0) + 3;
      }
    }

    function omwOf(pid) {
      const pastOpps = hist.opps[pid] ?? [];
      const currOpp = currentRoundOpps[pid];
      const allOpps = currOpp != null ? [...pastOpps, currOpp] : pastOpps;
      if (allOpps.length === 0) return 0.33;
      const total = allOpps.reduce((sum, opp) => {
        const w = (hist.wins[opp] ?? 0) + (addWins[opp] ?? 0);
        const p = (hist.played[opp] ?? 0) + (addPlayed[opp] ?? 0);
        return sum + Math.max(0.33, p > 0 ? w / p : 0.33);
      }, 0);
      return total / allOpps.length;
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
      let weight = 1.0;
      const outcomes = unknownMatches.map((m, i) => {
        const digit = Math.floor(combo / Math.pow(3, i)) % 3;
        const winProb = (1 - m.idProbability) * 0.5;
        weight *= digit === 0 ? m.idProbability : winProb;
        return { p1: m.p1, p2: m.p2, outcome: digit };
      });
      const rank = simulateScenario(outcomes);
      totalWeight += weight;
      if (rank <= topCut) {
        makesCutCount++;
        weightedMakesCut += weight;
      }
      if (rank < bestRank) { bestRank = rank; bestScenario = outcomes; }
      if (rank > worstRank) { worstRank = rank; worstScenario = outcomes; }
    }
    bestScenario = bestScenario ? scenarioToNames(bestScenario) : null;
    worstScenario = worstScenario ? scenarioToNames(worstScenario) : null;
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
