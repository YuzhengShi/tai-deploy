// What the current outbound filter (src/router.ts formatOutbound, from the orchestrator's dist/) does to replies students really got:
// every turn of the saved scenario runs, each reply as it reached the student, passed through the filter again. A reply that changes is
// either a leak the old filter let through (a true positive) or a false positive; every changed one is printed in full.
//   node replay_filter.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';

const { formatOutbound } = await import(path.join(os.homedir(), 'tai-eval/tai/dist/router.js'));
const dir = path.join(os.homedir(), 'tai-eval/results');
const files = fs.readdirSync(dir).filter((f) => /^scenarios-.*\.json$/.test(f) && !f.startsWith('scenarios-partial')).sort();

let turns = 0;
const changed = [];
const byModel = {};
for (const f of files) {
  let runs;
  try {
    runs = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  } catch {
    continue;
  }
  for (const r of runs) {
    for (const [i, t] of (r.turns || []).entries()) {
      const before = typeof t.visible === 'string' ? t.visible : '';
      if (!before) continue;
      turns++;
      byModel[r.model] = (byModel[r.model] || 0) + 1;
      const after = formatOutbound(before);
      if (after !== before) changed.push({ file: f, model: r.model, scenario: r.scenario, turn: i + 1, before, after });
    }
  }
}
console.log(`${files.length} result files, ${turns} replies (${Object.entries(byModel).map(([m, n]) => `${m} ${n}`).join(', ')}), ${changed.length} changed by the current filter`);
for (const c of changed) {
  console.log(`\n=== ${c.model} ${c.scenario} turn ${c.turn} (${c.file})`);
  console.log('BEFORE:', JSON.stringify(c.before).slice(0, 900));
  console.log('AFTER :', JSON.stringify(c.after).slice(0, 900));
}
