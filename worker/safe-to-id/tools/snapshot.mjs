// Snapshot an event for later debugging: every raw RPH response the worker reads,
// plus the worker's /event and /analyze output for every player.
//
// Usage: node worker/safe-to-id/tools/snapshot.mjs <event_id> [top_cut ...]
//   e.g. node worker/safe-to-id/tools/snapshot.mjs 755724 4 8
//
// Writes worker/safe-to-id/fixtures/event-<id>/<timestamp>/.

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const RPH_BASE = 'https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2';
const WORKER = process.env.WORKER ?? 'https://api.gtalorcana.ca';

const eventId = process.argv[2];
const topCuts = process.argv.slice(3).map(Number);
if (!/^\d+$/.test(eventId ?? '')) {
  console.error('Usage: node snapshot.mjs <event_id> [top_cut ...]');
  process.exit(1);
}
if (topCuts.length === 0) topCuts.push(8);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.join(import.meta.dirname, '..', 'fixtures', `event-${eventId}`, stamp);
fs.mkdirSync(path.join(dir, 'rph'), { recursive: true });
fs.mkdirSync(path.join(dir, 'worker'), { recursive: true });

const save = (rel, data) => fs.writeFileSync(path.join(dir, rel), JSON.stringify(data, null, 2));

async function getJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

// ── Raw RPH data ─────────────────────────────────────────────────────────────

const event = await getJson(`${RPH_BASE}/events/${eventId}/`);
save('rph/event.json', event);
if (event.status !== 200) throw new Error(`RPH event returned ${event.status}`);

const rounds = event.body.tournament_phases.flatMap(p =>
  (p.rounds ?? []).map(r => ({ phase: p.round_type, id: r.id, round_number: r.round_number, status: r.status })));

for (const r of rounds) {
  const tag = `${r.phase.toLowerCase()}-r${r.round_number}-${r.id}`;
  save(`rph/standings-${tag}.json`, await getJson(`${RPH_BASE}/tournament-rounds/${r.id}/standings`));
  const pages = [];
  for (let page = 1; page; ) {
    const res = await getJson(`${RPH_BASE}/tournament-rounds/${r.id}/matches/paginated/?page=${page}&page_size=100`);
    pages.push(res);
    page = res.body?.next_page_number ?? null;
  }
  save(`rph/matches-${tag}.json`, pages);
}

// ── Worker output ────────────────────────────────────────────────────────────

const workerEvent = await getJson(`${WORKER}/safe-to-id/event?id=${eventId}`);
save('worker/event.json', workerEvent);
const players = workerEvent.body.players ?? [];
const totalSwissRounds = workerEvent.body.total_swiss_rounds;

const summary = [];
for (const topCut of topCuts) {
  for (const p of players) {
    for (const depth of ['simple', 'full']) {
      const request = { event_id: Number(eventId), total_swiss_rounds: totalSwissRounds, top_cut: topCut, player_id: p.id, depth };
      const res = await getJson(`${WORKER}/safe-to-id/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://gtalorcana.ca' },
        body: JSON.stringify(request),
      });
      save(`worker/analyze-top${topCut}-${depth}-${p.id}.json`, { request, ...res });
      const b = res.body;
      summary.push({
        top_cut: topCut, depth, player: p.name, player_id: p.id, http: res.status,
        error: b?.error,
        record: b?.current_record, points: b?.current_points, match_done: b?.target_match_done ?? false,
        verdict: b?.id_one_round?.verdict, source: b?.id_one_round?.verdict_source,
        makes_cut_pct: b?.id_one_round?.makes_cut_pct,
        rank: b?.simulation ? `${b.simulation.best_rank}-${b.simulation.worst_rank}` : undefined,
        unknown_results: b?.simulation?.unknown_results,
      });
    }
  }
}

let commit = null;
try { commit = execSync('git rev-parse HEAD', { cwd: import.meta.dirname }).toString().trim(); } catch {}
save('manifest.json', {
  event_id: Number(eventId), event_name: event.body.name, captured_at: new Date().toISOString(),
  worker: WORKER, repo_commit: commit, top_cuts: topCuts, rounds, players, summary,
});

console.log(dir);
console.table(summary.map(({ player_id, ...s }) => s));
