// Load a fixture folder into the dataset shape GET /dlc/matches returns.

import fs from 'fs';
import path from 'path';

export const fixtureDir = eventId =>
  path.join(import.meta.dirname, '..', 'fixtures', `event-${eventId}`);

const read = (dir, name) => {
  const file = path.join(dir, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
};

// arg is an event id or a path to a fixture folder.
export function loadFixture(arg) {
  const dir = /^\d+$/.test(String(arg)) ? fixtureDir(arg) : path.resolve(String(arg));
  const meta = read(dir, 'event.json');
  if (!meta) throw new Error(`No fixture at ${dir} — run tools/snapshot.mjs first`);

  const rounds = {};
  const standings = {};
  for (const phase of meta.phases) {
    for (const r of phase.rounds) {
      const m = read(dir, `matches-${r.id}.json`);
      if (m) rounds[r.id] = m;
      const s = read(dir, `standings-${r.id}.json`);
      if (s) standings[r.id] = s;
    }
  }
  return { dir, dataset: { meta, players: read(dir, 'players.json') ?? {}, rounds }, standings };
}
