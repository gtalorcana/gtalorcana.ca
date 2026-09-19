// Compare a predicted final table against RPH's actual standings from a later snapshot.
//
// Usage: node worker/safe-to-id/tools/compare.mjs <predictions.json> <outcome label> <snapshot dir> <round id>
//   predictions.json: { "<outcome label>": [{ rank, name, pts, omw, gw, ogw }, ...] }
//
// Prints each player's predicted vs actual rank and tiebreakers, flagging any difference.

import fs from 'fs';
import path from 'path';

const [predFile, label, snapDir, roundId] = process.argv.slice(2);
if (!roundId) {
  console.error('Usage: node compare.mjs <predictions.json> <outcome label> <snapshot dir> <round id>');
  process.exit(1);
}

const predictions = JSON.parse(fs.readFileSync(predFile, 'utf8'));
const predicted = predictions[label];
if (!predicted) {
  console.error(`No outcome "${label}". Available: ${Object.keys(predictions).join(' | ')}`);
  process.exit(1);
}

const rphDir = path.join(snapDir, 'rph');
const file = fs.readdirSync(rphDir).find(f => f.startsWith('standings') && f.includes(roundId));
if (!file) throw new Error(`No standings for round ${roundId} in ${rphDir}`);
const actual = JSON.parse(fs.readFileSync(path.join(rphDir, file), 'utf8')).body.standings;

const pct = x => (x * 100).toFixed(2).padStart(6);
let mismatches = 0;
for (const p of predicted) {
  const a = actual.find(s => s.user_event_status?.best_identifier === p.name);
  if (!a) { console.log(`!  ${p.name}: not in RPH standings`); mismatches++; continue; }
  const same = (x, y) => Math.abs(x - y) < 1e-4;
  const ok = a.rank === p.rank && a.points === p.pts
    && same(a.opponent_match_win_percentage, p.omw) && same(a.game_win_percentage, p.gw)
    && same(a.opponent_game_win_percentage, p.ogw);
  if (!ok) mismatches++;
  console.log(`${ok ? ' ' : '!'} ${p.name.padEnd(18)} rank ${p.rank}/${a.rank}  pts ${p.pts}/${a.points}`
    + `  OMW ${pct(p.omw)}/${pct(a.opponent_match_win_percentage)}`
    + `  GW ${pct(p.gw)}/${pct(a.game_win_percentage)}`
    + `  OGW ${pct(p.ogw)}/${pct(a.opponent_game_win_percentage)}`);
}
console.log(`\n(predicted/actual) — ${mismatches} mismatch${mismatches === 1 ? '' : 'es'}`);
