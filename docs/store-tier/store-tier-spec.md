# Store Tier Tracker — Build Spec

## Overview

Build a web tool at `gtalorcana.ca/store-tier` that reports how a store is tracking against
Ravensburger's store tier metrics for Disney Lorcana.

The user enters a store (by name search or Play Hub store ID), picks a date window, and the tool
reports the four numbers that matter:

| Metric | Definition |
|--------|------------|
| **Events** | Lorcana events run by the store in the window |
| **Unique Fans** | Distinct registered players across those events |
| **Event Tickets** | Total registrations across those events (a player counts once per event) |
| **Prerelease** | Whether at least one prerelease event is scheduled in the window |

A static HTML page calls a **new** Cloudflare Worker that reads the public Ravensburger Play Hub
(RPH) API and does the counting. Same architecture as `safe-to-id`.

---

## Context

### The program

Ravensburger is standing up a store tier program measured on event activity. Targets:

| Tier | Events | Unique Fans | Event Tickets |
|------|--------|-------------|---------------|
| Standard | 25 | 25 | 250 |
| Legendary | 50 | 50 | 500 |

Measurement window is **4 Lorcana sets — roughly one year**.

### The quick launch

There is a short qualifying window ahead of the full program:

- **Window:** Sept 1 2026 → Nov 1 2026
- **Targets:** 8 events, 8 unique players, 80 event tickets, **1 prerelease event scheduled**

### Why this tool exists

Nobody outside Ravensburger has a dashboard for these numbers. Two audiences:

1. **Store owners / TOs** who want to know where they stand without waiting on a rep.
2. **Players** who want to know how much their local store still needs — "we're 12 tickets short,
   bring a friend Monday" is a concrete ask a community can act on.

Everything the tool needs is already public on the Play Hub, so a store does not have to opt in or
share anything for its numbers to be visible.

> ⚠️ **This is an unofficial estimate.** These are *our* counts from public RPH data, not
> Ravensburger's official tally. The UI must say so — see [Disclaimer](#disclaimer).

---

## Data source — verified against the live RPH API

Base: `https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2` (same base `safe-to-id` uses)

All four endpoints below were probed live on 2026-08-18 and returned public data with **no auth**.

### 1. Store search — `GET /game-stores/?game=1&search={query}`

Powers the store picker. `game=1` is Disney Lorcana — but see quirk 6: **the filter is not
actually applied**, so filter and dedupe client-side.

```
GET /game-stores/?game=1&search=Battlefield   → 10 results
```

Each result carries the Play Hub store UUID plus the nested store record:

```json
{
  "id": "a0e90d74-96de-4451-8988-9fe031fd146b",
  "game": { "id": 1, "name": "Disney Lorcana", "slug": "disney-lorcana" },
  "store": {
    "id": 1468,
    "name": "Enter The Battlefield Oakville",
    "full_address": "2172 Speers Road, Oakville, ON, L6L 2X8, CA",
    "city": "Oakville",
    "website": "https://www.etboakville.com"
  }
}
```

### 2. Store lookup — `GET /game-stores/{uuid}/`

Direct fetch when the user pastes a Play Hub store ID (the UUID in the store's Play Hub URL).

**There are two store IDs and they are not interchangeable:**

| ID | Example | Used for |
|----|---------|----------|
| `game_store_id` (UUID) | `a0e90d74-96de-4451-8988-9fe031fd146b` | `tcg.ravensburgerplay.com/stores/{uuid}`, `/game-stores/{uuid}/` |
| `store.id` (integer) | `1468` | the `store_id` filter on `/events/` |

The tool accepts the UUID (what a user can actually copy from Play Hub) and resolves it to the
integer via this endpoint.

### 3. Store events — `GET /events/?store_id={store.id}&page_size=100&page=N`

Returns every event for the store, all games, past and future. Paginate on `next_page_number`.

**Use `store_id=`, not `store=`.** Both filters work, but they return different sets — `store_id`
is a strict superset. For store 1468: `store=` → 108 events, `store_id=` → 132, and the 24 extras
included a real Lorcana event (`167003`) that `store=` dropped.

Filter client-side on:
- `e.game === 1` (Lorcana only — store 1468 runs 90 non-Lorcana events alongside 18 Lorcana ones)
- `e.start_datetime` within the window

### 4. Event registrations — `GET /events/{id}/registrations/?page_size=100`

The source of truth for both tickets and unique fans. Public for **upcoming** events too, so the
quick-launch window can be tracked live as signups come in.

```json
{
  "count": 73,
  "results": [
    {
      "id": 1831887,
      "user": { "id": 37198, "best_identifier": "Aaron B" },
      "registration_status": "COMPLETE",
      "is_guest": false,
      "registration_completed_datetime": "2026-01-19T21:16:11+00:00"
    }
  ]
}
```

- **Tickets** for an event = `count`
- **Unique fans** = union of `user.id` across all events in the window

---

## Known RPH data quirks

These are verified, not assumed. Each one will produce wrong numbers if ignored.

### 1. `registered_user_count` on the event list is not the ticket count

Event `341947` reports `registered_user_count: 8` but has **73** registrations and
`starting_player_count: 73`. The field appears to drift after an event completes.

**Always count tickets from `/events/{id}/registrations/`**, never from the list payload. This is
what forces a per-event fetch, and it drives the whole worker design below.

### 2. `event_status` is always `SCHEDULED`

All 108 events for store 1468 report `event_status: "SCHEDULED"`, including ones from a year ago.
The real state lives in `display_status` on the **detail** payload (`"complete"`, `"inProgress"`)
and in `settings.event_lifecycle_status`. Do not filter on `event_status`.

Since the event list gives no usable status, use `start_datetime` vs. now to split past from
upcoming.

### 3. `event_type` is always `LOCALS` — there is no prerelease flag

Every event for store 1468 is typed `LOCALS`, including
`"Monday Evening Attack of the Vine! Prerelease (Sealed)"`. `event_format` is `OTHER`.

The only real signals for a prerelease are:
- `gameplay_format.name === "Sealed"` (detail payload only, not on the list)
- the event **name** matching `/pre-?release/i`

**Detection rule:** name match on the list payload, since that is free. Optionally confirm with a
detail fetch on candidates. Because this is a heuristic, the UI must let the user override — see
[Prerelease handling](#prerelease-handling).

### 4. Date filters are not supported on `/events/`

`start_datetime__gte`, `start_datetime_after`, `start_date`, and `start_after` are all silently
ignored — the count comes back unchanged. Fetch all pages for the store and filter in code.

### 5. Pagination defaults to 25

Always pass `page_size=100` and follow `next_page_number`.

### 6. `game=` is not honoured on `/game-stores/` — results duplicate per store

`GET /game-stores/?game=1&search=Enter The Battlefield` returns **five** records: three for store
1467 and two for 1468, carrying `game.id` 1, 3, and 134. RPH keeps one game-store record per game
a store carries, each with its own UUID, and the `game=` filter is silently ignored.

Filter to `gs.game.id === 1` and dedupe by `store.id`, otherwise the picker shows the same store
three times and may hand back a non-Lorcana UUID.

### 7. The store timezone only exists on the event **detail** payload

Neither `/game-stores/` nor the `/events/` list carries `store.timezone`, and the event-level
`timezone` field is `null`. Only `GET /events/{id}/` has it (`store.timezone: "America/Toronto"`).

Since window edges are the entire point of this tool, spend one extra (cached) subrequest on any
event from the store to resolve the timezone, rather than defaulting to UTC and mis-binning late
evening events.

---

## Metric definitions

The RPH data does not define these for us, and the choices are debatable. Pin them down here,
state them in the UI, and keep them adjustable.

### An event counts if
- `game === 1` (Disney Lorcana)
- `start_datetime` falls within `[from, to)` — half-open, so a Nov 1 event is excluded from a
  window ending Nov 1
- It has **at least 1 registration** (default on; toggleable)

Store 1468 has `851643 "(Newmarket) Wednesday Evening Lorcana"` with 0 registrations — a scheduled
placeholder. Counting empty events would inflate the event total against a target that is clearly
meant to measure real play.

### A ticket counts if
- It is a registration on a counted event

Three statuses have been observed live: `COMPLETE`, `ELIMINATED` (a standings state on a finished
event, not a cancellation), and `DROPPED` (a player who dropped mid-event — 13 of them across Face
to Face Games' year). **All three count as tickets** — someone who registered and dropped still
took a seat. No cancelled or refunded status has turned up yet.

The worker returns a tally of every `registration_status` it saw, and the UI lists anything that
isn't `COMPLETE`/`ELIMINATED` under Excluded as "counted as tickets despite status: 13 DROPPED".
An unknown state surfaces rather than silently changing a number.

### A unique fan is
- A distinct `user.id` across all counted events

`is_guest: true` registrations, and any registration with no `user` object, cannot be deduplicated
— no stable identity. Count them as **tickets but not unique fans**, and report the guest count
separately so the number is explainable. These are real and not rare: Face to Face Games had **23
guest tickets** across a year, which is why unique fans (64) sits so far below tickets (493).

### The 4-set window

The program measures over **4 sets (~1 year)**, which is not the same as 365 days — Lorcana ships
roughly every 3 months, so 4 sets is 11–12 months and the boundaries move.

**A span is COMPLETE once the set after it has released** — only then have all four of its sets
finished their cycle. The newest span is normally *in progress*: three finished sets plus however
much of the current set has happened so far, which reads worse than the store's actual pace.

Both are legitimate — a complete window is comparable and closed, a live one shows where you stand
today — so the UI offers a **dropdown of every 4-set span**, newest first, and **defaults to the
newest complete one**. In-progress spans are labelled as such and run to today.

Spans are numbered by mainline set number (Fabled is 9, Wilds Unknown is 12), matching how players
refer to them.

As of 2026-08-20 the default is `Sets 9–12: Fabled → Wilds Unknown`, `2025-08-29 → 2026-07-24`.

Window choice moves the numbers a lot. Face to Face Games:

| Window | Events | Fans | Tickets | Verdict |
|--------|--------|------|---------|---------|
| Rolling 365 days | 62 | 72 | 519 | Legendary met |
| Sets 9–12 (complete) | 55 | 71 | 469 | Standard met — 31 tickets short of Legendary |
| Sets 10–13 (in progress) | 45 | 47 | 373 | Standard met — 5 events / 3 fans / 127 tickets short |

The rolling year was flattering and wrong; the in-progress span understates a store mid-cycle. The
complete span is the honest default.

**Set dates are hardcoded** in `LORCANA_SETS` in `store-tier/index.html`. RPH exposes no set or
season data — `/sets/`, `/seasons/`, `/payout-seasons/`, and `/products/` all 404, `?search=` is
ignored on `/events/`, and `payout_active_seasons` is empty on every event checked. The list must be
updated by hand as sets are announced; the UI shows a staleness warning when no set has released in
over 150 days.

Two things to watch when adding a set:

1. **Use wide release dates, not prerelease weekends.** Several published set lists conflate them —
   Winterspell prereleased 2026-02-13 and released 2026-02-20, and at least one widely-cited list
   records the prerelease date as the release date.
2. **Exclude Illumineer's Quest standalones** (Deep Trouble, Palace Heist, The Great Hunny Rescue).
   They are not part of the set cadence and would shorten the window if counted.

Whether Ravensburger bounds its own window on release dates, prerelease dates, or something else
entirely is unknown — see open question 5.

### Timezone

`start_datetime` is UTC. The store's local timezone is in `store.timezone`
(e.g. `America/Toronto`). A Friday-night event at 7pm ET is `2026-09-05T23:00:00+00:00` — same day
either way — but a late event can cross midnight UTC and land in the wrong month.

**Compare dates in the store's local timezone**, not UTC. This matters most at window edges
(Sept 1, Nov 1).

---

## Architecture

Follows the existing multi-tool layout:

```
store-tier/
  index.html          ← page (shared.css → tools.css → inline <style>)
worker/store-tier/
  index.js            ← new Worker, does NOT touch worker/safe-to-id
  wrangler.toml
docs/store-tier/
  store-tier-spec.md  ← this file
```

### Worker deployment

```toml
name = "gta-lorcana-store-tier"
main = "index.js"
compatibility_date = "2025-09-27"

[observability]
[observability.logs]
enabled = true
invocation_logs = true

[env.production]
routes = [
  { pattern = "api.gtalorcana.ca/store-tier/*", zone_name = "gtalorcana.ca" },
]
```

`safe-to-id` is already scoped to `api.gtalorcana.ca/safe-to-id/*`, so the two workers coexist
without route conflicts. CORS allowlist and JSON error shape (`{"error": "..."}`) copy
`worker/safe-to-id/index.js`.

### The subrequest problem

A year-long window means one registrations fetch per event. Store 1468 has 14 Lorcana events in a
year — fine — but a busy store running weeklies could have 100+. Cloudflare caps subrequests per
request (50 on free, 1000 on paid), and a single blocking call that fans out 100+ times is fragile
and slow either way.

**Design: chunked, client-orchestrated.** Two routes instead of one, so the page can show real
progress and no single request fans out far.

---

## Worker API

### `GET /store-tier/stores?q={query}`

Store typeahead. Proxies `/game-stores/?game=1&search={q}`, trimmed to what the UI needs.

```json
{
  "stores": [
    {
      "game_store_id": "a0e90d74-96de-4451-8988-9fe031fd146b",
      "store_id": 1468,
      "name": "Enter The Battlefield Oakville",
      "address": "2172 Speers Road, Oakville, ON, L6L 2X8, CA",
      "timezone": "America/Toronto"
    }
  ]
}
```

Also accepts a bare UUID as `q` → resolves via `/game-stores/{uuid}/` and returns the single match.
Cache 1 hour.

### `GET /store-tier/events?store={uuid|store_id}&from=YYYY-MM-DD&to=YYYY-MM-DD`

Resolves the store, pages the event list, filters to Lorcana in-window, returns the event skeleton
**without** ticket counts.

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
      "url": "https://tcg.ravensburgerplay.com/events/824107"
    }
  ]
}
```

Cache 5 minutes.

### `POST /store-tier/tickets`

Body: `{ "event_ids": [824107, 775281, ...] }` — **max 20 per call**, client chunks and calls in
sequence, updating a progress bar between chunks.

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

Returning raw `user_ids` lets the **client** union across chunks — the worker stays stateless and
never has to hold the whole window in memory.

> `user_ids` are RPH numeric IDs only. Do not return names, emails, or profile pictures — the tool
> reports counts, not a roster of who plays where.

**Caching:** past events are immutable → `Cache-Control: public, max-age=86400`. Upcoming events
still take signups → `max-age=300`. This is the difference between a year-long lookup costing 100
RPH calls every time and costing them once a day.

---

## UI

Match the existing tool pages (`shared.css` → `tools.css` → inline `<style>`, dark theme default,
Cinzel/Lora, `.card` / `.btn` / `.field` patterns). Add the page to the tools nav wherever
`safe-to-id` and `lore-counter` are linked.

### Input card

1. **Store** — text input with typeahead against `/store-tier/stores`, showing name + city.
   Accepts a pasted Play Hub store UUID directly. Selected store shown as a chip with its address.
2. **Window** — preset buttons plus a custom range:
   - **Quick Launch** (Sept 1 – Nov 1 2026) — *default*, targets 8 / 8 / 80 / 1 prerelease
   - **4-Set Window** — the real program window (see below) — targets 25 / 25 / 250 and 50 / 50 / 500
   - **Custom** — two date inputs; tier targets shown but flagged as non-standard window
3. **Run** button.

Remember the last store in `localStorage` — this is a tool people will check repeatedly.

### Results

**Verdict line** first — the one sentence a store owner actually wants:

```
Needs 12 more events to reach STANDARD
Standard met — needs 3 more events, 7 more tickets for Legendary
Legendary met — all targets cleared
```

**Four progress cards**, one per metric, each showing `current / target`, a filled bar, and the gap:

```
┌────────────────────────┐  ┌────────────────────────┐
│ EVENTS                 │  │ UNIQUE FANS            │
│ 14 / 25                │  │ 113 / 25   ✓           │
│ ████████░░░░░░  56%    │  │ ██████████ 100%        │
│ 11 more needed         │  │ Target met             │
└────────────────────────┘  └────────────────────────┘
```

For the Full Program window, show Standard and Legendary as two markers on the same bar rather
than two sets of cards.

**Prerelease card** is boolean: the matched event name and date, or "None found in window" with the
manual override.

**Event table** below — the receipts, so a store can audit our math:

| Date | Event | Tickets | |
|------|-------|---------|---|
| 2026-09-13 | Attack of the Vine! Set Championship | 6 | ↗ |

Each row links to the Play Hub event page. Excluded events (0 registrations, non-Lorcana) shown in
a collapsed "Excluded (N)" section with the reason, so exclusions are visible rather than silent.

**Progress feedback** during the run: "Counting tickets… 40 / 132 events" — a year-long window is a
multi-second operation and must not look frozen.

### Prerelease handling

Since detection is a name heuristic, render it as a checkbox the user can tick with a note:
*"We look for 'prerelease' in the event name. If your prerelease is named differently, tick this
box."* The override is display-only and stored in `localStorage`.

### Disclaimer

Persistent, above the results, not dismissable:

> **Unofficial.** These numbers are counted from public Ravensburger Play Hub data by GTA Lorcana.
> They are not Ravensburger's official tier tally and may differ from what your store rep sees.
> Program targets are based on information available as of August 2026 and may change.

### Share

"Copy summary" button producing Discord-ready plain text — this is how the numbers actually reach a
community:

```
Enter The Battlefield Oakville — Quick Launch (Sept 1 – Nov 1 2026)
Events 1/8 · Unique Fans 6/8 · Tickets 6/80 · Prerelease ✗
Unofficial — counted from public Play Hub data · gtalorcana.ca/store-tier
```

---

## Worked example (live data, 2026-08-18)

Prototype run against store 1468 (Enter The Battlefield Oakville), Lorcana only:

**Window 2025-09-01 → 2026-09-01 (full-program shape):**

```
210881 | 2025-10-18 |  8 |     Saturday Afternoon Fabled - Set Championship
320771 | 2026-01-10 | 10 |     ETB Oakville Whispers in the Well - Set Champ
341947 | 2026-02-28 | 73 |     Lorcana $2500 Mystery Wheel Tournament
382206 | 2026-02-07 | 32 |     GTA Lorcana League Top 32
504878 | 2026-05-16 | 50 |     Slab Sharks x ETB Mystery Wheel Tournament
514925 | 2026-05-02 | 26 |     GTA Lorcana League Winterspell Season Champio
698842 | 2026-07-05 | 10 |     ETB Oakville Wilds Unknown Set Championship
775281 | 2026-08-22 | 28 |     ETB x Slab Sharks Enchanted Duos Tournament
785283 | 2026-07-20 | 13 | PRE Monday Evening Attack of the Vine! Prerelease
805316 | 2026-07-27 |  5 |     Monday Evening Weekly Play (Constructed)
805624 | 2026-08-03 |  6 |     Monday Evening Weekly Play (Constructed)
845727 | 2026-08-10 |  6 |     Monday Evening Weekly Play (Constructed)
851643 | 2026-08-12 |  0 |     (Newmarket) Wednesday Evening Lorcana
864928 | 2026-08-17 |  7 |     Monday Evening Weekly Play (Constructed)

EVENTS 14 · UNIQUE FANS 113 · TICKETS 274 · PRERELEASE yes
```

Against Standard (25 / 25 / 250): **tickets and fans clear the bar, event count does not** — 14 of
25. That is exactly the kind of actionable gap this tool exists to surface: the store needs more
*events*, not more *players*.

**Window 2026-09-01 → 2026-11-01 (quick launch):** 1 event, 6 fans, 6 tickets, no prerelease — but
the window has not started yet, so this is a pure forward-looking signup snapshot. Expect it to
grow as events get scheduled.

**Face to Face Games (store 1536), same 12-month window** — the busy-store case, and the one that
exercises chunking, guests, and drops:

```
EVENTS 58 · UNIQUE FANS 64 · TICKETS 493 · PRERELEASE yes
68 events in window, 10 with 0 registrations, 23 guest tickets, 13 DROPPED
4 ticket calls, 1.4s
```

Note how far unique fans (64) sits below tickets (493): a weekly-play store sees the same ~60
people every Tuesday. **Unique Fans is the hardest target for a store that already has a healthy
regular scene**, and the easiest for a store running one-off big events. Worth saying out loud to
anyone reading their numbers.

Use all three as regression fixtures.

---

## Open questions

These affect correctness and none of them can be answered from the API. Flag them in the UI where
relevant rather than pretending they are settled.

1. **Does Ravensburger count what we count?** Our ticket count is *registrations*, which may differ
   from RB's internal count (paid tickets? checked-in players? `starting_player_count`?). For event
   `341947` registrations (73) matches `starting_player_count` (73) but not `registered_user_count`
   (8). Worth asking a store rep to confirm against a known store's official numbers.
2. **Are non-Lorcana events excluded from Lorcana tiers?** Assumed yes (`game === 1`). If the
   program counts all Play Hub activity, store 1468 goes from 14 events to 108.
3. **Do multi-location stores share one store ID?** Store 1468 lists a "(Newmarket)" event under
   Oakville, suggesting one Play Hub store may span locations. If tiers are per-location, our
   per-store-ID count over-reports.
4. **Does "prerelease scheduled" mean scheduled, or run?** Spec assumes *scheduled in the window*,
   matching the wording. A scheduled-but-cancelled prerelease would still count under our rule.
5. **Where exactly does the 4-set window start?** We use the wide release date of the 4th-most-recent
   set. RB could just as well bound it on prerelease weekends (a week earlier each time) or on
   internal quarters. Prerelease dates are in `LORCANA_SETS` where known, so switching the boundary
   is a one-line change if we learn otherwise.
6. **Online events** — `event_is_online` exists on the payload. Currently counted. Unclear whether
   RB counts them toward a physical store's tier.

---

## Build status

| Phase | State |
|-------|-------|
| 1. Worker + routes (`/stores`, `/events`, `/tickets`, caching, CORS) | ✅ built, tested locally |
| 2. Page shell + store typeahead + window presets | ✅ built |
| 3. Chunked fetch + progress + unique-fan union | ✅ built, tested to 68 events / 4 chunks |
| 4. Results — verdict, metric cards, event table, excluded, disclaimer | ✅ built |
| 5. Copy summary + prerelease override | ✅ built |
| 6. Deploy worker (`wrangler deploy --env production`) | ⬜ not done |
| 7. Link from the main site | ⬜ deliberately not done — see below |

Neither `safe-to-id` nor `lore-counter` is linked from `index.html`; the tools are unlisted and
shared by URL. This page follows that pattern. Adding it to the site nav is a publishing decision,
not a build step.

**Not yet verified:** mobile layout (browser resize did not take effect during testing). The page
uses the same `tools.css` patterns as the other tool pages, a single-column grid below 520px, and
an `overflow-x: auto` wrapper on the event table — but it has not been seen on a real phone.
