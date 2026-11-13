// Fetch every submitted decklist for an event into the event's fixture folder.
//
// Usage: node worker/dlc/tools/decklists.mjs <event_id>
//
// Run tools/snapshot.mjs first. Writes into worker/dlc/fixtures/event-<id>/:
//   cards.json   [{ n: "Name - Version", t: type, c: ink cost, ink: [...], song: 1? }]
//   decks.json   { [playerId]: { ink: "amber,emerald", cards: [[cardIndex, quantity], ...] } }
// and fills in players.json ink pairs that RPH's match data left empty.
//
// A raw decklist is ~27 KB (card text, image URLs); a slimmed one is ~200 bytes.
// Cards are identified by full name, so reprints of the same card count as one.
// Decks already saved are not fetched again.

import fs from 'fs';
import path from 'path';
import { fetchRegistrationsPage, fetchDeck } from '../rph.js';
import { slimDeck, cardIndexOf } from '../slim.js';
import { fixtureDir } from './fixture.mjs';

const eventId = process.argv[2];
if (!/^\d+$/.test(eventId ?? '')) {
  console.error('Usage: node worker/dlc/tools/decklists.mjs <event_id>');
  process.exit(1);
}
const dir = fixtureDir(eventId);
const file = name => path.join(dir, name);
const load = (name, fallback) => (fs.existsSync(file(name)) ? JSON.parse(fs.readFileSync(file(name), 'utf8')) : fallback);
if (!fs.existsSync(file('event.json'))) {
  console.error(`No fixture for event ${eventId} — run tools/snapshot.mjs first`);
  process.exit(1);
}

const CONCURRENCY = 4;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, tries = 4) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries || /\b40[34]\b/.test(e.message)) throw e;
      await sleep(1000 * i);
    }
  }
}

// ── Registrations: player id -> deck id ──────────────────────────────────────
const regs = [];
for (let page = 1; page; ) {
  const data = await withRetry(() => fetchRegistrationsPage(eventId, page, 250));
  regs.push(...(data.results ?? []));
  page = data.next_page_number ?? null;
}
const wanted = regs.filter(r => r.deck_id && r.user?.id != null).map(r => ({ player: r.user.id, deck: r.deck_id }));
console.log(`${regs.length} registrations, ${wanted.length} with a decklist`);

// ── Decks ────────────────────────────────────────────────────────────────────
const cards = load('cards.json', []);
const cardIndex = cardIndexOf(cards);
const decks = load('decks.json', {});

const todo = wanted.filter(w => !decks[w.player]);
let done = 0, failed = 0;
async function worker() {
  for (;;) {
    const job = todo.shift();
    if (!job) return;
    try {
      decks[job.player] = slimDeck(await withRetry(() => fetchDeck(job.deck)), cards, cardIndex);
    } catch (e) {
      failed++;
      console.log(`  deck for player ${job.player} failed: ${e.message}`);
    }
    if (++done % 100 === 0) console.log(`  ${done} fetched`);
    await sleep(150);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// ── Fill in ink pairs the match data did not have ────────────────────────────
const players = load('players.json', {});
let filled = 0;
for (const [pid, deck] of Object.entries(decks)) {
  if (players[pid] && !players[pid].ink && deck.ink) { players[pid].ink = deck.ink; filled++; }
}

fs.writeFileSync(file('cards.json'), JSON.stringify(cards));
fs.writeFileSync(file('decks.json'), JSON.stringify(decks));
fs.writeFileSync(file('players.json'), JSON.stringify(players));
console.log(`${Object.keys(decks).length} decks, ${cards.length} distinct cards, ${failed} failed, ${filled} ink pairs filled in`);
