/**
 * Capture RPH API responses as fixture files for local mock testing.
 *
 * Usage:
 *   node capture-fixtures.js <event_id>
 *
 * Saves JSON files to ./fixtures/ that mock-server.js will serve.
 */

const fs   = require('fs');
const path = require('path');

const RPH_BASE    = 'https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2';
const FIXTURES    = path.join(__dirname, 'fixtures');

const eventId = process.argv[2];
if (!eventId) {
  console.error('Usage: node capture-fixtures.js <event_id>');
  process.exit(1);
}

async function rphFetch(url) {
  const res = await fetch(url, {
    headers: { Origin: 'https://gtalorcana.ca' },
  });
  if (!res.ok) throw new Error(`RPH ${res.status} for ${url}`);
  return res.json();
}

function save(filename, data) {
  const filepath = path.join(FIXTURES, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  console.log(`  saved ${filename}`);
}

async function main() {
  if (!fs.existsSync(FIXTURES)) fs.mkdirSync(FIXTURES);

  console.log(`Capturing event ${eventId}...`);
  const eventData = await rphFetch(`${RPH_BASE}/events/?id=${eventId}`);
  save(`event-${eventId}.json`, eventData);

  const event = eventData.results?.[0];
  if (!event) { console.error('Event not found in response'); process.exit(1); }

  const phases    = event.tournament_phases ?? [];
  const swiss     = phases.find(p => p.round_type === 'SWISS') ?? phases[0];
  const rounds    = swiss?.rounds ?? [];

  console.log(`\nFound ${rounds.length} rounds:`);

  for (const r of rounds) {
    console.log(`\nRound ${r.round_number} — ${r.status} (id: ${r.id})`);

    // Always capture matches
    const matches = await rphFetch(`${RPH_BASE}/tournament-rounds/${r.id}/matches`);
    save(`round-${r.id}-matches.json`, matches);

    // Capture standings for completed rounds
    if (r.status === 'COMPLETE') {
      const standings = await rphFetch(`${RPH_BASE}/tournament-rounds/${r.id}/standings`);
      save(`round-${r.id}-standings.json`, standings);
    }
  }

  console.log('\nDone! Round ID reference:');
  for (const r of rounds) {
    console.log(`  Round ${r.round_number} (${r.status}): ${r.id}`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
