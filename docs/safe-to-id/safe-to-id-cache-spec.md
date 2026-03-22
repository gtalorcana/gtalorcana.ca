# Safe to ID? Tool — Caching Follow-up

**Status: ✅ Fully implemented, then simplified (2026-03-22)**
- Single `fetchWithCache` with 10s TTL — no checkbox, no force refresh, no fresh marker
- All RPH endpoints use the same 10s TTL; override_round_id bypasses cache entirely
- `event_lifecycle_status` still returned from `/event` endpoint (used for UI display, no longer for checkbox auto-enable)

## Context

This task adds Cloudflare Cache API to the existing `worker/safe-to-id/index.js`.
Complete and validate all test cases in `TEST_CASES.md` before implementing this.

---

## Why Cache

During a live tournament, many players may hit the tool simultaneously in the same
60-second window. Without caching, every request makes fresh RPH API calls:

- Simple/Medium: 2 RPH calls per request (event + standings)
- Full: up to 8 RPH calls per request (event + standings + 1 per completed round of matches)

With 30 players checking at once in Full mode during a 6-round event, that's ~240 RPH
calls in seconds. Caching reduces this to a handful regardless of concurrent users.

---

## What to Cache

| Data | Cache Key | TTL | Notes |
|------|-----------|-----|-------|
| Event metadata | `rph:event:{event_id}` | 60s | Changes rarely mid-tournament |
| Round standings | `rph:standings:{round_id}` | 60s | Completed rounds never change |
| Round matches | `rph:matches:{round_id}` | 300s | Completed rounds never change — 5min safe |

---

## Implementation

Use the Cloudflare Cache API (`caches.default`). Workers do not have access to
Redis or KV by default — the Cache API is the correct tool here.

### Cache helper pattern

```js
async function fetchWithCache(cacheKey, fetchFn, ttl, ctx) {
  const cache = caches.default;
  const cacheUrl = new URL(`https://api.gtalorcana.ca/__cache__/${cacheKey}`);
  const cacheRequest = new Request(cacheUrl.toString());

  // Check cache
  const cached = await cache.match(cacheRequest);
  if (cached) {
    return await cached.json();
  }

  // Fetch fresh
  const data = await fetchFn();

  // Store in cache — must use ctx.waitUntil so it doesn't block the response
  const cacheResponse = new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${ttl}`,
    },
  });
  ctx.waitUntil(cache.put(cacheRequest, cacheResponse));

  return data;
}
```

### Where to apply

Replace each raw RPH fetch with `fetchWithCache`:

```js
// Event metadata
const eventData = await fetchWithCache(
        `event:${event_id}`,
        () => fetchRphEvent(event_id),
        60,
        ctx
);

// Standings
const standings = await fetchWithCache(
        `standings:${round_id}`,
        () => fetchRphStandings(round_id),
        60,
        ctx
);

// Match history (Full mode)
const matches = await fetchWithCache(
        `matches:${round_id}`,
        () => fetchRphMatches(round_id),
        300,
        ctx
);
```

### Skip cache when `override_round_id` is present

Testing mode should always fetch fresh data:

```js
const useCache = !body.override_round_id;

const standings = useCache
        ? await fetchWithCache(`standings:${round_id}`, () => fetchRphStandings(round_id), 60, ctx)
        : await fetchRphStandings(round_id);
```

### Pass `ctx` through

The Worker handler receives `(request, env, ctx)` — `ctx` must be passed down to
any function that calls `fetchWithCache` so `ctx.waitUntil` is available.

```js
export default {
  async fetch(request, env, ctx) {
    // pass ctx into route handlers
  }
};
```

---

## Skip Cache — UI Checkbox + Server-Side Cooldown

### UI

Add a **"Skip cache"** checkbox beside the [Fetch] button:

```
Event ID  [__________] [Fetch]  ☐ Skip cache
```

Label: `Skip cache` with a tooltip: *"Use during active tournaments to get the
latest results. Shared with other users — at most one RPH call per 10 seconds."*

**Auto-enable when event is live:**
When the `/safe-to-id/event` response shows `event_lifecycle_status === "EVENT_IN_PROGRESS"`,
automatically check the skip cache box. The user can uncheck it if they want.

### Why a checkbox beats `?nocache=1` in the URL

During a tournament on a phone, editing a URL is error-prone. A visible checkbox
is one tap. It's also self-documenting — users can see they're in "fresh data" mode.

### Server-side force refresh cooldown

If multiple friends all check "Skip cache" simultaneously, each would independently
hit RPH — defeating the purpose of caching. The worker prevents this with a
**force refresh cooldown**:

- First user to skip cache → fetches from RPH, stores result with normal TTL,
  also stores a short-lived "fresh marker" (10 second TTL)
- Any subsequent skip cache request within 10 seconds → finds the fresh marker,
  returns that result instead of hitting RPH again
- After 10 seconds → next skip cache hits RPH and refreshes the marker

This means skip cache = "at most one RPH call per 10 seconds per endpoint"
regardless of how many concurrent users request it.

```js
const FORCE_REFRESH_COOLDOWN = 10; // seconds

async function fetchWithForceRefresh(cacheKey, fetchFn, ttl, forceRefresh, ctx) {
  const cache = caches.default;
  const cacheRequest = new Request(
          `https://api.gtalorcana.ca/__cache__/${cacheKey}`
  );
  const freshMarker = new Request(
          `https://api.gtalorcana.ca/__fresh__/${cacheKey}`
  );

  if (forceRefresh) {
    // Check if someone already force-refreshed recently
    const recentFresh = await cache.match(freshMarker);
    if (recentFresh) {
      console.log(`[cache] ${cacheKey}: FORCE-HIT (cooldown active)`);
      return await recentFresh.json();
    }

    // Nobody refreshed recently — fetch from RPH
    console.log(`[cache] ${cacheKey}: FORCE-MISS (fetching fresh)`);
    const data = await fetchFn();

    // Store with normal TTL
    ctx.waitUntil(cache.put(cacheRequest, new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${ttl}`,
      },
    })));

    // Store fresh marker with cooldown TTL
    ctx.waitUntil(cache.put(freshMarker, new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${FORCE_REFRESH_COOLDOWN}`,
      },
    })));

    return data;
  }

  // Normal cache path
  const cached = await cache.match(cacheRequest);
  if (cached) {
    console.log(`[cache] ${cacheKey}: HIT`);
    return await cached.json();
  }

  console.log(`[cache] ${cacheKey}: MISS`);
  const data = await fetchFn();
  ctx.waitUntil(cache.put(cacheRequest, new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${ttl}`,
    },
  })));
  return data;
}
```

### Updated cache TTL table

| Data | Cache Key | Normal TTL | Fresh Marker TTL |
|------|-----------|-----------|-----------------|
| Event metadata | `event:{event_id}` | 60s | 10s |
| Round standings | `standings:{round_id}` | 60s | 10s |
| Completed round matches | `matches:{round_id}` | 300s | 10s |
| Current round matches | `matches:current:{round_id}` | 30s | 10s |

### Skip cache is NOT applied when

- `override_round_id` or `override_current_pairings_round_id` is set — testing
  mode always fetches fresh regardless
- The request is for a completed round's match history — that data is immutable,
  skip cache has no benefit

---

## Validation

After implementing, verify caching is working by:

1. Call `POST /safe-to-id/analyze` (Full mode, event `341947`, no override)
2. Note response time
3. Call same request again immediately
4. Second call should be noticeably faster (cache hit)

Check Cloudflare Worker logs — add a log line indicating cache hit vs miss:
```js
console.log(`[cache] ${cacheKey}: ${cached ? 'HIT' : 'MISS'}`);
```

---

## Notes

- The Cache API is scoped to the Cloudflare data centre serving the request.
  Two users in different cities may both get cache misses on first request — this
  is fine and expected. Most tournament players will be in the same city.
- Cache TTL of 60s means standings data is at most 1 minute stale — acceptable
  for tournament use where rounds last 50+ minutes.
- Completed round match data is effectively immutable — 5 minute TTL is
  conservative, could be longer, but 5min is safe.
- Do not cache error responses.