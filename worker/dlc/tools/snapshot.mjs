// Snapshot an event into slimmed fixtures — the same records the Worker keeps in KV.
//
// Usage: node worker/dlc/tools/snapshot.mjs <event_id>
//
// Writes worker/dlc/fixtures/event-<id>/:
//   event.json              event structure (phases, rounds)
//   players.json            player id -> { h: handle, ink: "amber,emerald" | null }
//   matches-<roundId>.json  { round, status: 'final' | 'partial', matches: [...] }
//   standings-<roundId>.json { round, rows: [...] }
//   manifest.json           when it was captured and what it holds
//
// Re-running overwrites the folder with the event's current state. Rounds that
// were already saved as final are not fetched again.

import fs from 'fs';
import path from 'path';
import { fetchEvent, fetchMatchesPage, fetchStandingsPage } from '../rph.js';
import { slimEvent, slimMatch, slimStanding, mergePlayers, sortMatches } from '../slim.js';

const eventId = process.argv[2];
if (!/^\d+$/.test(eventId ?? '')) {
  console.error('Usage: node worker/dlc/tools/snapshot.mjs <event_id>');
  process.exit(1);
}

const dir = path.join(import.meta.dirname, '..', 'fixtures', `event-${eventId}`);
fs.mkdirSync(dir, { recursive: true });
const file = name => path.join(dir, name);
const load = name => (fs.existsSync(file(name)) ? JSON.parse(fs.readFileSync(file(name), 'utf8')) : null);
const save = (name, data) => fs.writeFileSync(file(name), JSON.stringify(data));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const event = slimEvent(await fetchEvent(eventId));
const players = load('players.json') ?? {};
const summary = [];

for (const phase of event.phases) {
  for (const round of phase.rounds) {
    const row = { phase: phase.name, round: round.number, id: round.id, status: round.status };
    summary.push(row);
    if (!round.pairings) continue;

    const matchesFile = `matches-${round.id}.json`;
    const saved = load(matchesFile);
    if (saved?.status === 'final') {
      row.matches = saved.matches.length;
      row.fetched = 'kept';
    } else {
      const matches = [];
      for (let page = 1; page; ) {
        const data = await fetchMatchesPage(round.id, page, 1000);
        for (const raw of data.results ?? []) {
          const { match, players: entries } = slimMatch(raw);
          matches.push(match);
          mergePlayers(players, entries);
        }
        page = data.next_page_number ?? null;
        await sleep(500);
      }
      save(matchesFile, {
        round: round.id,
        status: round.status === 'COMPLETE' ? 'final' : 'partial',
        updated_at: new Date().toISOString(),
        matches: sortMatches(matches),
      });
      row.matches = matches.length;
      row.fetched = 'yes';
    }

    const standingsFile = `standings-${round.id}.json`;
    if (round.standings && !load(standingsFile)) {
      const rows = [];
      for (let page = 1; page; ) {
        const data = await fetchStandingsPage(round.id, page, 1000);
        rows.push(...(data.results ?? []).map(slimStanding));
        page = data.next_page_number ?? null;
        await sleep(500);
      }
      save(standingsFile, { round: round.id, updated_at: new Date().toISOString(), rows });
      row.standings = rows.length;
    } else if (load(standingsFile)) {
      row.standings = load(standingsFile).rows.length;
    }
  }
}

save('event.json', event);
save('players.json', players);
fs.writeFileSync(file('manifest.json'), JSON.stringify({
  event_id: Number(eventId),
  event_name: event.name,
  captured_at: new Date().toISOString(),
  players: Object.keys(players).length,
  rounds: summary,
}, null, 2));

console.log(dir);
console.table(summary);
