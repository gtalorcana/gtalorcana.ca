// Turn a fixture folder into a KV bulk file, so a Worker (local or deployed)
// can start from a snapshot instead of crawling every round one page a minute.
//
// Usage: node worker/dlc/tools/seed.mjs <event_id> [out.json]
// Then:  npx wrangler kv bulk put <out.json> --binding DLC --local          (wrangler dev)
//        npx wrangler kv bulk put <out.json> --binding DLC --env production --remote
//
// Rounds saved as partial are seeded as partial; the cron refreshes them.

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
entries.push({ key: `event:${eventId}:players`, value: JSON.stringify(dataset.players) });
entries.push({ key: `event:${eventId}:state`, value: JSON.stringify(state) });

fs.writeFileSync(out, JSON.stringify(entries));
console.log(`${entries.length} keys -> ${out}`);
