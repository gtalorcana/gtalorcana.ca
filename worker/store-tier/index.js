/**
 * GTA Lorcana — Store Tier Worker
 *
 * Routes:
 *   GET  /store-tier/stores?q={name|uuid}          — store search / lookup
 *   GET  /store-tier/events?store=&from=&to=       — Lorcana events in a window (no ticket counts)
 *   POST /store-tier/tickets                       — registrations for up to 20 events
 *
 * Spec: docs/store-tier/store-tier-spec.md
 */

const RPH_BASE = 'https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2';
const PLAYHUB_EVENT = 'https://tcg.ravensburgerplay.com/events/';

const LORCANA_GAME_ID = 1;
const MAX_TICKET_EVENTS = 20;   // keeps subrequests per request well under the Cloudflare cap
const RPH_PAGE_SIZE = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PRERELEASE_RE = /pre-?release/i;

const ALLOWED_ORIGINS = [
  'https://gtalorcana.ca',
  'https://www.gtalorcana.ca',
  'http://localhost',
  'http://127.0.0.1',
];

// Cache TTLs (seconds)
const TTL_STORE = 3600;    // store records barely change
const TTL_EVENTS = 300;    // new events get scheduled during the window
const TTL_REGS_PAST = 86400;  // a finished event's registrations are immutable
const TTL_REGS_LIVE = 300;    // an upcoming event is still taking signups

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

/** Fetch every page of a paginated RPH list endpoint. */
async function rphFetchAll(path) {
  const sep = path.includes('?') ? '&' : '?';
  let page = 1;
  let all = [];
  // Hard stop at 50 pages (5000 events) — no real store is anywhere near this.
  while (page && page <= 50) {
    const data = await rphFetch(`${RPH_BASE}${path}${sep}page_size=${RPH_PAGE_SIZE}&page=${page}`);
    all = all.concat(data.results || []);
    page = data.next_page_number || null;
  }
  return all;
}

async function fetchWithCache(cacheKey, ttl, fetchFn, ctx) {
  const cache = caches.default;
  const cacheRequest = new Request(`https://api.gtalorcana.ca/__cache__/store-tier/${cacheKey}`);

  const cached = await cache.match(cacheRequest);
  console.log(`[cache] ${cacheKey}: ${cached ? 'HIT' : 'MISS'}`);
  if (cached) return cached.json();

  const data = await fetchFn();
  ctx.waitUntil(cache.put(cacheRequest, new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` },
  })));
  return data;
}

/**
 * Format a UTC instant as a YYYY-MM-DD date in the store's local timezone.
 *
 * Window edges (Sept 1, Nov 1) are the whole point of the tool, and a 7pm ET event is
 * already the next day in UTC — comparing raw UTC dates would push late events into the
 * wrong month.
 */
function localDate(isoDatetime, timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(isoDatetime));
  } catch {
    return (isoDatetime || '').slice(0, 10);
  }
}

// ── Router ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      if (url.pathname === '/store-tier/stores' && request.method === 'GET') {
        return await handleStores(url, origin, ctx);
      }
      if (url.pathname === '/store-tier/events' && request.method === 'GET') {
        return await handleEvents(url, origin, ctx);
      }
      if (url.pathname === '/store-tier/tickets' && request.method === 'POST') {
        return await handleTickets(request, origin, ctx);
      }
    } catch (err) {
      console.error(err.stack || err.message);
      return errResponse(`Ravensburger Play Hub request failed: ${err.message}`, 502, origin);
    }

    return errResponse('Not found', 404, origin);
  },
};

// ── Store resolution ─────────────────────────────────────────────────────────

function mapGameStore(gs) {
  const s = gs.store || {};
  return {
    game_store_id: gs.id,
    store_id: s.id,
    name: s.name || null,
    address: s.full_address || null,
    city: s.city || null,
    website: s.website || null,
    timezone: s.timezone || null,
  };
}

/** Accepts a Play Hub store UUID or a numeric RPH store id. */
async function resolveStore(param, ctx) {
  if (UUID_RE.test(param)) {
    const gs = await fetchWithCache(
      `gamestore:${param}`, TTL_STORE,
      () => rphFetch(`${RPH_BASE}/game-stores/${param}/`),
      ctx,
    );
    return mapGameStore(gs);
  }
  if (/^\d+$/.test(param)) {
    // Numeric ids have no direct endpoint — the store record comes off the events below.
    return { game_store_id: null, store_id: parseInt(param, 10), name: null, address: null, city: null, website: null, timezone: null };
  }
  return null;
}

/**
 * The store's IANA timezone appears on the EVENT DETAIL payload only — neither
 * /game-stores/ nor the event list carries it, and event.timezone is null. Since window
 * edges are the whole point of this tool, spend one cached subrequest to get it right.
 */
async function resolveTimezone(storeId, events, ctx) {
  const sample = events.find(e => e.game === LORCANA_GAME_ID) || events[0];
  if (!sample) return 'UTC';
  try {
    const detail = await fetchWithCache(
      `tz:${storeId}`, TTL_REGS_PAST,
      async () => {
        const ev = await rphFetch(`${RPH_BASE}/events/${sample.id}/`);
        return { timezone: (ev.store && ev.store.timezone) || ev.timezone || 'UTC' };
      },
      ctx,
    );
    return detail.timezone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// ── GET /store-tier/stores?q= ────────────────────────────────────────────────

async function handleStores(url, origin, ctx) {
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 2) return errResponse('Query must be at least 2 characters', 400, origin);

  // A pasted Play Hub store ID resolves directly instead of going through search.
  if (UUID_RE.test(q)) {
    try {
      const store = await resolveStore(q, ctx);
      return jsonResponse({ stores: [store] }, 200, origin);
    } catch {
      return errResponse('No store found with that Play Hub ID', 404, origin);
    }
  }

  const data = await fetchWithCache(
    `search:${q.toLowerCase()}`, TTL_STORE,
    () => rphFetch(`${RPH_BASE}/game-stores/?game=${LORCANA_GAME_ID}&search=${encodeURIComponent(q)}&page_size=25`),
    ctx,
  );

  // The game= filter is NOT honoured by RPH — a search for one store comes back with a
  // record per game it carries (Lorcana, Riftbound, …), all sharing one store.id. Filter
  // to Lorcana here so the UUID we hand back is the Lorcana one, then dedupe by store.
  const all = (data.results || []).filter(gs => gs.store && gs.store.id);
  const lorcana = all.filter(gs => gs.game && gs.game.id === LORCANA_GAME_ID);
  const source = lorcana.length ? lorcana : all;

  const seen = new Set();
  const stores = [];
  for (const gs of source) {
    if (seen.has(gs.store.id)) continue;
    seen.add(gs.store.id);
    stores.push(mapGameStore(gs));
  }

  return jsonResponse({ stores }, 200, origin);
}

// ── GET /store-tier/events?store=&from=&to= ──────────────────────────────────

async function handleEvents(url, origin, ctx) {
  const storeParam = (url.searchParams.get('store') || '').trim();
  const from = (url.searchParams.get('from') || '').trim();
  const to = (url.searchParams.get('to') || '').trim();

  if (!storeParam) return errResponse('Missing store', 400, origin);
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return errResponse('from and to must be YYYY-MM-DD dates', 400, origin);
  }
  if (from >= to) return errResponse('from must be earlier than to', 400, origin);

  let store;
  try {
    store = await resolveStore(storeParam, ctx);
  } catch {
    return errResponse('No store found with that Play Hub ID', 404, origin);
  }
  if (!store) return errResponse('store must be a Play Hub store ID (UUID) or a numeric store id', 400, origin);

  // store_id= (not store=) — store= silently drops some of the store's events.
  const raw = await fetchWithCache(
    `events:${store.store_id}`, TTL_EVENTS,
    () => rphFetchAll(`/events/?store_id=${store.store_id}`),
    ctx,
  );

  if (!raw.length) {
    return jsonResponse({
      store, window: { from, to }, events: [], excluded: { non_lorcana: 0, out_of_window: 0, test_or_template: 0 },
    }, 200, origin);
  }

  // Fill in store details we could not get from a numeric id.
  const sample = raw.find(e => e.store && e.store.id === store.store_id) || raw[0];
  if (!store.name && sample.store) {
    store.name = sample.store.name || null;
    store.address = sample.store.full_address || null;
    store.city = sample.store.city || null;
  }
  if (!store.timezone) store.timezone = await resolveTimezone(store.store_id, raw, ctx);

  const nowIso = new Date().toISOString();
  const excluded = { non_lorcana: 0, out_of_window: 0, test_or_template: 0 };
  const events = [];

  for (const e of raw) {
    if (e.game !== LORCANA_GAME_ID) { excluded.non_lorcana++; continue; }
    if (e.is_test_event || e.is_template) { excluded.test_or_template++; continue; }

    const date = localDate(e.start_datetime, store.timezone);
    if (date < from || date >= to) { excluded.out_of_window++; continue; }  // [from, to)

    events.push({
      id: e.id,
      name: e.name,
      start_datetime: e.start_datetime,
      local_date: date,
      is_past: e.start_datetime < nowIso,
      // RPH has no prerelease flag — every event is typed LOCALS. Name match is the only
      // signal on the list payload; Sealed format is a supporting hint, not proof.
      prerelease_guess: PRERELEASE_RE.test(e.name || ''),
      format: e.gameplay_format ? e.gameplay_format.name : null,
      online: !!e.event_is_online,
      // Reported for reference only — this field is unreliable, tickets come from /tickets.
      registered_user_count: e.registered_user_count,
      url: `${PLAYHUB_EVENT}${e.id}`,
    });
  }

  events.sort((a, b) => a.start_datetime.localeCompare(b.start_datetime));

  return jsonResponse({ store, window: { from, to }, events, excluded }, 200, origin);
}

// ── POST /store-tier/tickets ─────────────────────────────────────────────────

/**
 * Body: { "events": [{ "id": 824107, "past": false }] }
 *   or: { "event_ids": [824107, 775281] }   ← simpler shape for curl; caches as live
 *
 * Returns raw user_ids so the client can union them across chunks — the worker stays
 * stateless and never holds a whole window in memory.
 */
async function handleTickets(request, origin, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errResponse('Invalid JSON body', 400, origin);
  }

  let items = [];
  if (Array.isArray(body.events)) {
    items = body.events.map(e => ({ id: e.id, past: !!e.past }));
  } else if (Array.isArray(body.event_ids)) {
    items = body.event_ids.map(id => ({ id, past: false }));
  } else {
    return errResponse('Body must include events[] or event_ids[]', 400, origin);
  }

  items = items.filter(e => Number.isInteger(e.id) && e.id > 0);
  if (!items.length) return errResponse('No valid event ids', 400, origin);
  if (items.length > MAX_TICKET_EVENTS) {
    return errResponse(`Too many events — send at most ${MAX_TICKET_EVENTS} per request`, 400, origin);
  }

  const results = await Promise.all(items.map(async ({ id, past }) => {
    try {
      const regs = await fetchWithCache(
        `regs:${id}`, past ? TTL_REGS_PAST : TTL_REGS_LIVE,
        () => rphFetchAll(`/events/${id}/registrations/`),
        ctx,
      );

      const userIds = [];
      const statuses = {};
      let guestTickets = 0;

      for (const r of regs) {
        const status = r.registration_status || 'UNKNOWN';
        statuses[status] = (statuses[status] || 0) + 1;
        // Guests and userless registrations count as tickets but cannot be deduplicated
        // into unique fans — no stable identity to dedupe on.
        if (r.is_guest || !r.user || !r.user.id) guestTickets++;
        else userIds.push(r.user.id);
      }

      return {
        event_id: id,
        tickets: regs.length,
        user_ids: [...new Set(userIds)],
        guest_tickets: guestTickets,
        statuses,
      };
    } catch (err) {
      console.error(`event ${id}: ${err.message}`);
      return { event_id: id, error: err.message, tickets: 0, user_ids: [], guest_tickets: 0, statuses: {} };
    }
  }));

  return jsonResponse({ events: results }, 200, origin);
}
