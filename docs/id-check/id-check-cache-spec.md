# ID Check Tool — Caching Follow-up

## Context

This task adds Cloudflare Cache API to the existing `worker/id-check/index.js`.
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

## Validation

After implementing, verify caching is working by:

1. Call `POST /id-check/analyze` (Full mode, event `341947`, no override)
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
