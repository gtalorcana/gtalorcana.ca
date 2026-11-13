/**
 * GTA Lorcana — DLC Explorer Worker
 *
 * Cron (every minute): reads each tracked event's structure from RPH, then does
 * ONE unit of ingest work — a single page of matches or standings — and stores
 * the slimmed result in KV. Completed rounds are stored once and never fetched
 * again; only in-progress rounds are refreshed.
 *
 * Routes (all GET, public data only):
 *   /dlc/events                      tracked events
 *   /dlc/event?id={event_id}         structure + ingest progress
 *   /dlc/matches?id={event_id}       { meta, players, rounds } — the whole match list
 *   /dlc/standings?id=&round={id}    standings after one round
 *
 * This Worker computes no stats. The page does that with /dlc/stats.js.
 */

import { fetchEvent, fetchMatchesPage, fetchStandingsPage } from './rph.js';
import { slimEvent, slimMatch, slimStanding, mergeMatches, mergePlayers, sortMatches } from './slim.js';

// ── Tuning (sized for the Workers free plan) ─────────────────────────────────
// Free plan: 10 ms CPU per run, 50 subrequests per run, 1,000 KV writes per day.
// CPU is the tight one — a raw match is ~9.5 KB of JSON to parse — so each run
// handles one page. On a paid plan these can simply be raised.
const MATCH_PAGE_SIZE = 100;       // ~0.95 MB of JSON per page (200 measured 18 ms CPU)
const STANDINGS_PAGE_SIZE = 500;   // ~0.75 MB per page
const REFRESH_MS = 15 * 60 * 1000; // how often an in-progress round is re-read
const RETRY_MS = 5 * 60 * 1000;    // back-off after a failed page
const SERVE_TTL = 30;              // seconds responses are cached at the edge
const STALE_DAYS = 10;             // stop polling an event this long after it started

const ALLOWED_ORIGINS = [
  'https://gtalorcana.ca',
  'https://www.gtalorcana.ca',
  'http://localhost',
  'http://127.0.0.1',
];

const K = {
  state: id => `event:${id}:state`,
  players: id => `event:${id}:players`,
  matches: (id, roundId) => `event:${id}:round:${roundId}:matches`,
  standings: (id, roundId) => `event:${id}:round:${roundId}:standings`,
};

// Only these events are ingested or served, so nobody can point the Worker at
// arbitrary event ids. Set in wrangler.toml.
const trackedIds = env =>
  String(env.TRACKED_EVENTS ?? '').split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s)).map(Number);

// ── Cron ─────────────────────────────────────────────────────────────────────

async function runCron(env) {
  const now = Date.now();
  const events = [];
  const jobs = [];

  for (const id of trackedIds(env)) {
    const state = (await env.DLC.get(K.state(id), 'json')) ?? { id, meta: null, rounds: {} };
    if (state.done) continue;

    let meta;
    try {
      meta = slimEvent(await fetchEvent(id));
    } catch (e) {
      console.log(`[dlc] event ${id}: ${e.message}`);
      continue;
    }
    const ev = { id, state, dirty: JSON.stringify(meta) !== JSON.stringify(state.meta) };
    state.meta = meta;
    events.push(ev);

    // Phases and rounds are whatever RPH says they are right now.
    let pending = 0;
    for (const phase of meta.phases) {
      for (const round of phase.rounds) {
        if (!round.pairings) continue;
        const idx = (state.rounds[round.id] ??= {});
        const complete = round.status === 'COMPLETE';
        const waiting = now < (idx.retry_after ?? 0);

        if (idx.matches !== 'final') {
          pending++;
          // A finished round is finalised straight away; a live one is re-read
          // every REFRESH_MS (and a cycle already under way is carried through).
          const due = complete || idx.cycling || now - (idx.cycle_started ?? 0) >= REFRESH_MS;
          if (due && !waiting) jobs.push({ kind: 'matches', ev, round, pri: complete ? 0 : 2, at: idx.cycle_started ?? 0 });
        } else if (idx.standings !== 'final' && round.standings) {
          pending++;
          if (!waiting) jobs.push({ kind: 'standings', ev, round, pri: 1, at: 0 });
        }
      }
    }

    const allPhasesDone = meta.phases.length > 0 && meta.phases.every(p => p.status === 'COMPLETE');
    const stale = meta.start && now - Date.parse(meta.start) > STALE_DAYS * 86400000;
    if (!pending && (allPhasesDone || stale)) {
      state.done = true;
      ev.dirty = true;
    }
  }

  // One page of RPH data per run: finished rounds first, then standings, then
  // whichever live round has waited longest.
  jobs.sort((a, b) => a.pri - b.pri || a.at - b.at || a.round.id - b.round.id);
  const job = jobs[0];
  if (job) {
    const idx = job.ev.state.rounds[job.round.id];
    try {
      if (job.kind === 'matches') await ingestMatchesPage(env, job, now);
      else await ingestStandingsPage(env, job);
      console.log(`[dlc] ${job.kind} event ${job.ev.id} round ${job.round.id}: matches=${idx.matches ?? '-'} standings=${idx.standings ?? '-'}`);
    } catch (e) {
      console.log(`[dlc] ${job.kind} event ${job.ev.id} round ${job.round.id} failed: ${e.message}`);
      idx.retry_after = now + RETRY_MS;
      job.ev.dirty = true;
    }
  }

  // State is only written when something changed, to stay inside the KV write budget.
  for (const ev of events) {
    if (ev.dirty) await env.DLC.put(K.state(ev.id), JSON.stringify(ev.state));
  }
}

// A "cycle" walks every page of a round once. While it runs, the stored value
// carries _cycle = { page, final, seen }. When the last page lands, matches that
// were not seen in this cycle (re-pairings) are dropped, and if the round was
// already COMPLETE when the cycle began the value becomes final.
async function ingestMatchesPage(env, { ev, round }, now) {
  const idx = ev.state.rounds[round.id];
  const key = K.matches(ev.id, round.id);
  const val = (await env.DLC.get(key, 'json')) ?? { round: round.id, status: 'partial', matches: [] };

  const cycle = val._cycle ?? { page: 1, final: round.status === 'COMPLETE', seen: [] };
  if (!val._cycle) {
    idx.cycle_started = now;
    ev.dirty = true;
  }

  const data = await fetchMatchesPage(round.id, cycle.page, MATCH_PAGE_SIZE);
  const slim = (data.results ?? []).map(slimMatch);
  val.matches = mergeMatches(val.matches, slim.map(s => s.match));
  cycle.seen.push(...slim.map(s => s.match.id));

  const players = (await env.DLC.get(K.players(ev.id), 'json')) ?? {};
  if (mergePlayers(players, slim.flatMap(s => s.players))) {
    await env.DLC.put(K.players(ev.id), JSON.stringify(players));
  }

  if (data.next_page_number) {
    cycle.page = data.next_page_number;
    val._cycle = cycle;
    if (!idx.cycling) { idx.cycling = true; ev.dirty = true; }
  } else {
    const seen = new Set(cycle.seen);
    val.matches = sortMatches(val.matches.filter(m => seen.has(m.id)));
    delete val._cycle;
    if (cycle.final) val.status = 'final';
    idx.matches = val.status;
    idx.n = val.matches.length;
    idx.cycling = false;
    delete idx.retry_after;
    ev.dirty = true;
  }
  val.updated_at = new Date(now).toISOString();
  await env.DLC.put(key, JSON.stringify(val));
}

async function ingestStandingsPage(env, { ev, round }) {
  const idx = ev.state.rounds[round.id];
  const key = K.standings(ev.id, round.id);
  const val = (await env.DLC.get(key, 'json')) ?? { round: round.id, rows: [], _page: 1 };

  const data = await fetchStandingsPage(round.id, val._page ?? 1, STANDINGS_PAGE_SIZE);
  val.rows.push(...(data.results ?? []).map(slimStanding));

  if (data.next_page_number) {
    val._page = data.next_page_number;
    if (idx.standings !== 'partial') { idx.standings = 'partial'; ev.dirty = true; }
  } else {
    delete val._page;
    // De-duplicate by player in case two runs overlapped on the same page.
    val.rows = [...new Map(val.rows.map(r => [r.p, r])).values()].sort((a, b) => a.r - b.r);
    idx.standings = 'final';
    delete idx.retry_after;
    ev.dirty = true;
  }
  val.updated_at = new Date().toISOString();
  await env.DLC.put(key, JSON.stringify(val));
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.some(o => origin && origin.startsWith(o));
  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'https://gtalorcana.ca',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

function respond(body, status, origin, ttl = 0) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': ttl ? `public, max-age=${ttl}` : 'no-store',
      ...corsHeaders(origin),
    },
  });
}

const errResponse = (message, status, origin) => respond(JSON.stringify({ error: message }), status, origin);

// Builds the JSON body once per SERVE_TTL per edge location; KV is not read on a hit.
// `build` returns a JSON string, or null for "no data".
async function cachedBody(ctx, cacheKey, build) {
  const cache = caches.default;
  const req = new Request(`https://api.gtalorcana.ca/__cache__/dlc/${cacheKey}`);
  const hit = await cache.match(req);
  if (hit) return hit.text();

  const body = await build();
  if (body != null) {
    ctx.waitUntil(cache.put(req, new Response(body, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${SERVE_TTL}` },
    })));
  }
  return body;
}

const eventSummary = state => ({
  id: state.id,
  name: state.meta?.name ?? `Event ${state.id}`,
  start: state.meta?.start ?? null,
  player_count: state.meta?.player_count ?? null,
  complete: !!state.done,
  rounds_stored: Object.values(state.rounds ?? {}).filter(r => r.matches).length,
});

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin') || '';

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== 'GET') return errResponse('Method not allowed', 405, origin);

  const tracked = trackedIds(env);

  if (url.pathname === '/dlc/events') {
    const body = await cachedBody(ctx, 'events', async () => {
      const states = await Promise.all(tracked.map(id => env.DLC.get(K.state(id), 'json')));
      return JSON.stringify({
        events: tracked.map((id, i) => (states[i]?.meta ? eventSummary(states[i]) : { id, name: `Event ${id}`, pending: true })),
      });
    });
    return respond(body, 200, origin, SERVE_TTL);
  }

  if (!['/dlc/event', '/dlc/matches', '/dlc/standings'].includes(url.pathname)) {
    return errResponse('Not found', 404, origin);
  }

  const idStr = url.searchParams.get('id');
  if (!idStr || !/^\d+$/.test(idStr)) return errResponse('Missing or invalid event ID', 400, origin);
  const id = Number(idStr);
  if (!tracked.includes(id)) return errResponse('This event is not tracked', 404, origin);

  if (url.pathname === '/dlc/event') {
    const body = await cachedBody(ctx, `event:${id}`, async () => {
      const state = await env.DLC.get(K.state(id), 'json');
      if (!state?.meta) return null;
      return JSON.stringify({ ...eventSummary(state), meta: state.meta, rounds: state.rounds });
    });
    return body == null ? errResponse('No data for this event yet', 404, origin) : respond(body, 200, origin, SERVE_TTL);
  }

  if (url.pathname === '/dlc/matches') {
    const body = await cachedBody(ctx, `matches:${id}`, async () => {
      const state = await env.DLC.get(K.state(id), 'json');
      if (!state?.meta) return null;
      // Stored round values are passed through as text — re-parsing a megabyte
      // of JSON here would cost CPU for nothing.
      const roundIds = Object.entries(state.rounds ?? {})
        .filter(([, r]) => r.matches || r.cycle_started)
        .map(([rid]) => rid);
      const [players, ...values] = await Promise.all([
        env.DLC.get(K.players(id)),
        ...roundIds.map(rid => env.DLC.get(K.matches(id, rid))),
      ]);
      const rounds = roundIds
        .map((rid, i) => (values[i] ? `"${rid}":${values[i]}` : null))
        .filter(Boolean)
        .join(',');
      return `{"meta":${JSON.stringify(state.meta)},"complete":${!!state.done},"players":${players ?? '{}'},"rounds":{${rounds}}}`;
    });
    return body == null ? errResponse('No data for this event yet', 404, origin) : respond(body, 200, origin, SERVE_TTL);
  }

  // /dlc/standings
  const roundStr = url.searchParams.get('round');
  if (!roundStr || !/^\d+$/.test(roundStr)) return errResponse('Missing or invalid round ID', 400, origin);
  const body = await cachedBody(ctx, `standings:${id}:${roundStr}`, async () => {
    const state = await env.DLC.get(K.state(id), 'json');
    if (state?.rounds?.[roundStr]?.standings !== 'final') return null;
    return env.DLC.get(K.standings(id, roundStr));
  });
  return body == null ? errResponse('No standings stored for this round', 404, origin) : respond(body, 200, origin, SERVE_TTL);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (e) {
      console.log(`[dlc] ${e.stack ?? e.message}`);
      return errResponse('Internal error', 500, request.headers.get('Origin') || '');
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runCron(env));
  },
};
