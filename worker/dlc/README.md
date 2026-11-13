# DLC Explorer Worker

Powers `gtalorcana.ca/dlc`: a public breakdown of a Disney Lorcana Challenge event, built from the Ravensburger Play Hub (RPH) API. Public data only — no login, no private notes.

**Base URL:** `https://api.gtalorcana.ca`

| Piece | Where | Job |
|-------|-------|-----|
| Worker | `worker/dlc/index.js` | Cron ingest into KV, serves the stored data |
| Slimming | `worker/dlc/slim.js` | Raw RPH record → small stored record (pure) |
| RPH client | `worker/dlc/rph.js` | The endpoints we read, generic User-Agent |
| Stats | `dlc/stats.js` | Every number on the page (pure; shared by page, CLI, tests) |
| Archetypes | `dlc/archetypes.js` | Groups decklists into archetypes (pure; shared by page, CLI, tests) |
| Page | `dlc/index.html` | Not linked from the main nav |

The Worker computes no stats. The page downloads one match list per event and filters it in the browser, so every view (single round, a phase, whole event) is the same code over the same data.

---

## Tracked events

Only event IDs listed in `TRACKED_EVENTS` (`wrangler.toml`) are ingested or served. To add a DLC, add its ID there and deploy.

Nothing about an event's shape is hardcoded. Phases, round counts, which phase is the top cut, and when a round exists all come from `GET /events/{id}/`. RPH creates a phase's rounds lazily, so an upcoming phase simply has none yet.

---

## Routes

All `GET`, cached at the edge for 30 seconds.

| Route | Returns |
|-------|---------|
| `/dlc/events` | Tracked events: `id`, `name`, `start`, `player_count`, `complete`, `rounds_stored` |
| `/dlc/event?id=` | Event structure plus ingest progress per round |
| `/dlc/matches?id=` | `{ meta, complete, decklists, players, rounds }` — the whole match list |
| `/dlc/decks?id=` | `{ complete, cards, chunks }` — every public decklist; 404 until some are stored |
| `/dlc/standings?id=&round=` | `{ round, rows }` after one completed round |

Errors are `{"error": "..."}`: 400 bad ID, 404 untracked event or nothing stored yet.

### Stored records

```
players   { "7681": { "h": "Moxi93", "ink": "amber,emerald" } }
match     { "id": 8860024, "t": 1, "d": 1, "p": [7681, 38799], "w": 38799, "g": [2, 0, 0] }
standing  { "r": 1, "p": 15100, "pts": 15, "rec": "5-0-0", "omw": 0.72, "gw": 0.8333, "ogw": 0.639 }
```

Match fields: `t` table, `d` 1 when complete, `p` player IDs, `w` winner or null, `g` `[winner's games, loser's games, drawn]`, optional `k` = `bye` | `loss` | `id` | `ud`.

A round is about 60 KB stored, against 7.7 MB raw.

---

## Ingest

The cron runs every minute and does **one page of RPH data per run**:

1. Read each tracked event's structure (small) and note which rounds need work.
2. Pick one job: finalise a completed round first, then standings, then refresh the live round that has waited longest.
3. Fetch one page, slim it, merge it into the stored round.

A round is walked page by page (a "cycle"). When a cycle that began after the round was `COMPLETE` finishes, the round is marked `final` and never fetched again. A live round gets a new cycle every 15 minutes.

### Why one page per run

Sized for the Workers **free plan**:

| Limit | Free plan | What we use |
|-------|-----------|-------------|
| CPU per run | 10 ms | One 100-match page is ~0.95 MB of JSON to parse |
| Subrequests per run | 50 | 3 at most |
| KV writes per day | 1,000 | About 10 per live-round cycle; one per 15 decklists; one an hour per event while waiting for decklists |

CPU is the tight one: a 200-match page measured 18 ms on Cloudflare, so the page size is 100. If the logs show "exceeded CPU time limit", lower `MATCH_PAGE_SIZE` in `index.js` further. On a paid plan, raise it to 1000 and a round lands in one run.

An 817-match round takes 9 runs (9 minutes) to store. A fresh deploy mid-event has to walk every finished round, so seed it instead (below).

---

## Decklists and archetypes

RPH publishes decklists some time after an event starts. Registrations then carry a `deck_id`, and `/deckbuilder/decks/{id}/` returns the list. The cron looks for them at the lowest priority, so they never delay match data:

1. **Waiting:** read the first registration page once an hour. No deck ids, no work.
2. **Scan:** read every registration page (250 rows each) and note each player's deck id.
3. **Fetch:** 15 decklists per run, slimmed from ~27 KB to ~200 bytes each. One KV write per run.
4. While the event is running, scan again every 3 hours for late lists. A pass that starts after every phase is complete is the last one.

```
cards   [{ "n": "Aurora - Holding Court", "t": "Character", "c": 3, "ink": ["amber"], "song": 1? }]
deck    { "ink": "amber,emerald", "cards": [[cardIndex, quantity], ...] }
```

A card is identified by its full name, so reprints count as one card. Where the match data has no ink label (Bangkok 2026 had none), the page takes the ink pair from the decklist.

**Archetypes are computed in the browser, and nobody labels them.** Inside one ink pair: the distance between two lists is the number of cards they do not share; lists merge closest first (average linkage); merging stops at 35 cards; a group needs 5 lists. An archetype is named after the cards that most set it apart. The 35 comes from Bangkok 2026, where lists in the big ink pairs were either under ~28 cards apart or over 40.

The page's **Group by** control swaps each player's ink pair for their archetype label, so the matrix, meta, conversion and standings all work per archetype with any round filter. Best of stays by ink pair.

```bash
node worker/dlc/tools/decklists.mjs <event_id>               # save decklists into the fixture folder
node worker/dlc/tools/archetypes.mjs <event_id> --matrix     # archetypes and their matchup matrix
```

---

## RPH data quirks

- **`/tournament-rounds/{id}/matches` returns 401** — use `/matches/paginated/`. `page_size` up to 1000 works.
- **Player records are live, not per-round.** `user_event_status.matches_won` etc. and `registration_status` on a round-1 match show today's values. History is rebuilt from match results; drops are inferred from who is never paired again.
- **Standings: use `points` and `match_record`.** `record` is live.
- **Names collide.** `player.best_identifier` is "First L" and two different people share it. Everything is keyed on `player.id`; the page shows the handle (`user_event_status.best_identifier`).
- **Image URLs are signed and expire in 24h.** None are stored — ink pairs are kept as names (`amber,emerald`).
- **An awarded loss is a one-player match** with `match_is_loss: true` and no winner. It looks like a bye but is a loss. Getting this wrong was the only mismatch against RPH standings.
- **Some players have no ink label** (73 of 1,633 at London, mostly no-shows). They appear as "Unknown".
- **Draws** have no winner and games such as 1-1-1 or 1-1-0; RPH credits `players[0]` with `games_won_by_winner`.

---

## How the numbers are defined

- **Counted matches:** finished, two players, not an awarded loss. Byes, awarded losses and unfinished matches are reported as "left out".
- **Win rate:** wins ÷ (wins + losses). Draws count toward the sample size shown in a cell but not the rate.
- **Mirrors:** counted on the matrix diagonal, excluded from every win rate.
- **Meta share:** distinct players on the ink pair ÷ distinct players paired in the selection.
- **Conversion:** a player advanced if they appear in the next phase's pairings.
- **Left after round N:** paired in round N and never again. At the end of a phase that mostly means missing the cut.

---

## Local development

```bash
# tests (stats + slimming, against the saved London fixture)
node --test worker/dlc/stats.test.js worker/dlc/archetypes.test.js

# stats in the terminal, no network
node worker/dlc/tools/stats.mjs 1254364
node worker/dlc/tools/stats.mjs 1254364 --scope round:3 --games --top 8
node worker/dlc/tools/stats.mjs 1254364 --player moxi --standings 16

# Worker + page
cd worker/dlc && npx wrangler dev --port 8787 --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"     # one cron run
npx http-server . -p 8000        # from the repo root, then open http://localhost:8000/dlc/
```

### Fixtures

`fixtures/event-<id>/` holds one event exactly as KV stores it.

```bash
node worker/dlc/tools/snapshot.mjs <event_id>
```

Run `tools/decklists.mjs <event_id>` afterwards to add the decklists. Re-running refreshes the event; rounds already saved as final are kept as they are. Tests only assert numbers for final rounds.

### Seeding KV from a fixture

A finished event should be seeded before its ID is added to `TRACKED_EVENTS`. Otherwise the cron walks all of its rounds first, and finished rounds take priority over a live event's refresh. Saved decklists are seeded too.

```bash
node worker/dlc/tools/seed.mjs <event_id>
npx wrangler kv bulk put fixtures/seed-<event_id>.json --binding DLC --local                    # wrangler dev
npx wrangler kv bulk put fixtures/seed-<event_id>.json --binding DLC --env production --remote  # live
```

---

## Deploy

`.github/workflows/dlc-deploy.yml` runs the tests and deploys on pushes to `main` that touch the Worker code. Before the first deploy the KV namespace must exist and its ID must be in `wrangler.toml`:

```bash
cd worker/dlc && npx wrangler kv namespace create DLC --env production
```

---

## Milestone 2 (not built)

Decklists, card inclusion rates, archetype splits within an ink pair, archetype-level matrix. Blocked on finding out how RPH exposes decklists once a phase with `show_decklists: true` is under way — `registrations[].deck_id` was null throughout Phase 1.
