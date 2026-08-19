# Store Tier Worker

Cloudflare Worker that powers `gtalorcana.ca/store-tier`. Counts a store's Disney Lorcana events,
unique fans, and event tickets from public Ravensburger Play Hub (RPH) data so a store can see how
it is tracking against Ravensburger's tier targets.

**Base URL:** `https://api.gtalorcana.ca`
**Spec:** `docs/store-tier/store-tier-spec.md`

Deployed by `.github/workflows/store-tier-deploy.yml` on any push touching `worker/store-tier/**`,
or manually via the workflow's `workflow_dispatch` trigger.

---

## Routes

### `GET /store-tier/stores?q={name|uuid}`

Store search for the page's typeahead. Accepts a name fragment (2+ characters) or a Play Hub store
UUID pasted from `tcg.ravensburgerplay.com/stores/{uuid}`.

```json
{
  "stores": [
    {
      "game_store_id": "a0e90d74-96de-4451-8988-9fe031fd146b",
      "store_id": 1468,
      "name": "Enter The Battlefield Oakville",
      "address": "2172 Speers Road, Oakville, ON, L6L 2X8, CA",
      "city": "Oakville",
      "website": "https://www.etboakville.com",
      "timezone": null
    }
  ]
}
```

**Note:** RPH ignores the `game=` filter and returns one record per game a store carries, so the
worker filters to Lorcana (`game.id === 1`) and dedupes by `store.id`. Without that, one store
appears three times. `timezone` is null here — it only exists on the event detail payload and is
resolved by the `/events` route.

---

### `GET /store-tier/events?store={uuid|store_id}&from=YYYY-MM-DD&to=YYYY-MM-DD`

Every Lorcana event for the store inside the window, **without** ticket counts. The window is
half-open — `[from, to)` — so a Nov 1 event is excluded from a window ending Nov 1, and dates are
compared in the store's local timezone.

```json
{
  "store": { "store_id": 1468, "name": "Enter The Battlefield Oakville", "timezone": "America/Toronto" },
  "window": { "from": "2026-09-01", "to": "2026-11-01" },
  "events": [
    {
      "id": 824107,
      "name": "Attack of the Vine! Set Championship",
      "start_datetime": "2026-09-13T17:00:00+00:00",
      "local_date": "2026-09-13",
      "is_past": false,
      "prerelease_guess": false,
      "format": "Core Constructed",
      "online": false,
      "registered_user_count": 6,
      "url": "https://tcg.ravensburgerplay.com/events/824107"
    }
  ],
  "excluded": { "non_lorcana": 113, "out_of_window": 18, "test_or_template": 0 }
}
```

**Do not trust `registered_user_count`** — it is returned for reference only and drifts badly after
an event completes (event 341947 reports 8 against 73 actual registrations). Ticket counts come
from `/store-tier/tickets`.

---

### `POST /store-tier/tickets`

Registrations for up to **20 events** per call. The page chunks its event list and calls this
repeatedly, which keeps each request inside the Cloudflare subrequest budget and drives the
progress bar.

**Request:**

```json
{ "events": [{ "id": 824107, "past": false }] }
```

`past` only selects the cache TTL (a finished event's registrations are immutable). For quick curl
checks, `{ "event_ids": [824107, 775281] }` also works and caches as live.

**Response:**

```json
{
  "events": [
    {
      "event_id": 824107,
      "tickets": 6,
      "user_ids": [37198, 41022],
      "guest_tickets": 0,
      "statuses": { "COMPLETE": 6 }
    }
  ]
}
```

- `tickets` — every registration on the event, whatever its status
- `user_ids` — deduplicated RPH user ids, unioned **client-side** across chunks so the worker stays
  stateless. Ids only; no names, emails, or pictures.
- `guest_tickets` — guest / userless registrations. They count as tickets but cannot be deduplicated
  into unique fans, so they are reported separately.
- `statuses` — tally of every `registration_status` seen. `COMPLETE`, `ELIMINATED`, and `DROPPED`
  are all observed in the wild and all count as tickets; anything else surfaces in the UI rather
  than silently changing a number.

A failed event returns `{"event_id": ..., "error": "..."}` with zeroed counts instead of failing the
whole batch.

---

## Caching

| Key | TTL | Why |
|-----|-----|-----|
| `search:{q}`, `gamestore:{uuid}` | 1 hour | store records barely change |
| `events:{store_id}` | 5 min | new events get scheduled mid-window |
| `regs:{event_id}` (past event) | 24 hours | a finished event's registrations are immutable |
| `regs:{event_id}` (upcoming) | 5 min | still taking signups |
| `tz:{store_id}` | 24 hours | store timezone, resolved from one event detail fetch |

Without this, a year-long lookup at a busy store costs 100+ RPH calls on every single run.

---

## Errors

All errors return `{"error": "...message..."}`:

- Missing/invalid store, dates, or body → 400
- Unknown Play Hub store ID → 404
- Unknown route → 404
- RPH failure → 502

---

## Local development

```
npx wrangler dev --port 8787 --local
```

The page auto-targets `http://localhost:8787` when served from localhost or 127.0.0.1.

Known-good test fixtures:

| Store | Window | Expected |
|-------|--------|----------|
| `1468` Enter The Battlefield Oakville | 2025-09-01 → 2026-09-01 | ~13 events, ~121 fans, ~275 tickets, prerelease yes |
| `1536` Face to Face Games | 2025-09-01 → 2026-09-01 | ~58 events, ~64 fans, ~493 tickets, prerelease yes |

Counts drift as registrations change — treat them as ballpark, not assertions.
