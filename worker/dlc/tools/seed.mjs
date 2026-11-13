// Turn a fixture folder into a KV bulk file, so a Worker (local or deployed)
// can start from a snapshot instead of crawling every round one page a minute.
//
// Usage: node worker/dlc/tools/seed.mjs <event_id> [out.json]
// Then:  npx wrangler kv bulk put <out.json> --binding DLC --local          (wrangler dev)
//        npx wrangler kv bulk put <out.json> --binding DLC --env production --remote
//
// Rounds saved as partial are seeded as partial; the cron refreshes them.
// Decklists saved by tools/decklists.mjs are seeded too, as one finished pass.

import fs from 'fs';
import path from 'path';
import { loadFixture } from './fixture.mjs';

const eventId = process.argv[2];
if (!/^\d+$/.test(eventId ?? '')) {
  console.error('Usage: node worker/dlc/tools/seed.mjs <event_id> [out.json]');
  process.exit(1);
}
const { dir, dataset, standings } = loadFixture(eventId);
const out = process.argv[3] ?? path.join(dir, '..', `seed-${eventId}.json`);

const state = { id: Number(eventId), meta: dataset.meta, rounds: {} };
const entries = [];
for (const [rid, val] of Object.entries(dataset.rounds)) {
  state.rounds[rid] = { matches: val.status, n: val.matches.length, cycling: false, cycle_started: 0 };
  entries.push({ key: `event:${eventId}:round:${rid}:matches`, value: JSON.stringify(val) });
}
for (const [rid, val] of Object.entries(standings)) {
  if (!state.rounds[rid]) continue;
  state.rounds[rid].standings = 'final';
  entries.push({ key: `event:${eventId}:round:${rid}:standings`, value: JSON.stringify(val) });
}
const readJson = name => (fs.existsSync(path.join(dir, name)) ? JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) : null);
const decks = readJson('decks.json');
if (decks && Object.keys(decks).length) {
  // One chunk, marked final: the Worker serves it and never looks again.
  state.decks = { status: 'final', chunk: 0, known: Object.keys(decks).length, checked: Date.now() };
  entries.push({ key: `event:${eventId}:decks:0`, value: JSON.stringify({ next: Object.keys(decks).length, decks }) });
  entries.push({ key: `event:${eventId}:cards`, value: JSON.stringify(readJson('cards.json') ?? []) });
}
entries.push({ key: `event:${eventId}:players`, value: JSON.stringify(dataset.players) });
entries.push({ key: `event:${eventId}:state`, value: JSON.stringify(state) });

fs.writeFileSync(out, JSON.stringify(entries));
console.log(`${entries.length} keys -> ${out}`);
