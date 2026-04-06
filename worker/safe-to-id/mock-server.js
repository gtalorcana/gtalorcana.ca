/**
 * Local mock RPH server for testing safe-to-id without hitting the real API.
 *
 * Usage:
 *   1. Capture fixtures:  node capture-fixtures.js <event_id>
 *   2. Start mock server: node mock-server.js
 *   3. Start worker:      wrangler dev          (reads .dev.vars → RPH_BASE_OVERRIDE)
 *   4. Open browser:      http://localhost:8787/safe-to-id?dev=1
 *
 * To simulate in-progress matches: edit the relevant round-{id}-matches.json
 * and remove the "winning_player" field (and clear match_is_intentional_draw /
 * match_is_unintentional_draw) from matches you want to appear unfinished.
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT     = 3001;
const FIXTURES = path.join(__dirname, 'fixtures');

const server = http.createServer((req, res) => {
  const url      = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  console.log(`[mock] ${req.method} ${pathname}${url.search}`);

  let fixturePath;

  // GET /events/?id=XXXXX
  if (/\/events\/?$/.test(pathname)) {
    const id = url.searchParams.get('id');
    fixturePath = path.join(FIXTURES, `event-${id}.json`);
  }

  // GET /tournament-rounds/:id/standings
  const standingsMatch = pathname.match(/\/tournament-rounds\/([^/]+)\/standings/);
  if (standingsMatch) {
    fixturePath = path.join(FIXTURES, `round-${standingsMatch[1]}-standings.json`);
  }

  // GET /tournament-rounds/:id/matches
  const matchesMatch = pathname.match(/\/tournament-rounds\/([^/]+)\/matches/);
  if (matchesMatch) {
    fixturePath = path.join(FIXTURES, `round-${matchesMatch[1]}-matches.json`);
  }

  if (!fixturePath || !fs.existsSync(fixturePath)) {
    const missing = fixturePath ? path.basename(fixturePath) : '(no route matched)';
    console.log(`  → 404  missing fixture: ${missing}`);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `No fixture for: ${pathname}` }));
    return;
  }

  const data = fs.readFileSync(fixturePath, 'utf8');
  console.log(`  → 200  ${path.basename(fixturePath)}`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(data);
});

server.listen(PORT, () => {
  console.log(`Mock RPH server on http://localhost:${PORT}`);
  console.log(`Fixtures: ${FIXTURES}`);
  console.log('');
  console.log('Capture fixtures: node capture-fixtures.js <event_id>');
  console.log('Start worker:     wrangler dev');
  console.log('Open:             http://localhost:8787/safe-to-id?dev=1');
});
