# DLC Explorer Worker

Powers `gtalorcana.ca/dlc`: a public breakdown of a Disney Lorcana Challenge event, built from the Ravensburger Play Hub (RPH) API. Public data only — no login, no private notes.

**Base URL:** `https://api.gtalorcana.ca`

| Piece | Where | Job |
|-------|-------|-----|
| Worker | `worker/dlc/index.js` | Cron ingest into KV, serves the stored data |
| Slimming | `worker/dlc/slim.js` | Raw RPH record → small stored record (pure) |
| RPH client | `worker/dlc/rph.js` | The three endpoints we read, generic User-Agent |
| Stats | `dlc/stats.js` | Every number on the page (pure; shared by page, CLI, tests) |
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
| `/dlc/matches?id=` | `{ meta, complete, players, rounds }` — the whole match list |
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

A round is walked page by page (a "cycle"). When a cycle that began after the round was `COMPLETE` finishes, the round is marked `final` and never fetched again. A live round gets a new cycle every 10 minutes.

### Why one page per run

Sized for the Workers **free plan**:

| Limit | Free plan | What we use |
|-------|-----------|-------------|
| CPU per run | 10 ms | One 200-match page is ~1.9 MB of JSON to parse |
| Subrequests per run | 50 | 3 at most |
| KV writes per day | 1,000 | About 5 per live-round cycle; nothing when no round is live |

CPU is the tight one and has **not been measured on Cloudflare yet** — only locally. If the logs show "exceeded CPU time limit", lower `MATCH_PAGE_SIZE` in `index.js`. On a paid plan, raise it to 1000 and a round lands in one run.

An 817-match round takes 5 runs (5 minutes) to store. A fresh deploy mid-event has to walk every finished round, so seed it instead (below).

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
node --test worker/dlc/stats.test.js

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

Re-running refreshes the event; rounds already saved as final are kept as they are. Tests only assert numbers for final rounds.

### Seeding KV from a fixture

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
