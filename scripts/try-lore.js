// Runs the real activation engine over a real lorebook and shows what fires.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importFile } from '../src/import/index.js';
import { activate } from '../src/engine/lorebook.js';

const file = process.argv[2] || 'MHA_RP_Optimized_Master_World_Info_v3_9_SillyTavern_Runtime_Optimized.json';
const line = process.argv[3]
  || 'Reiko finds Bakugo on the roof after training. "Kacchan. Aizawa sensei is looking for you."';

const r = importFile(file, new Uint8Array(readFileSync(join('samples', file))));
const entries = r.data.entries.filter((e) => e.enabled);

const res = activate(entries, [{ role: 'user', name: 'Reiko', content: line }], {
  budget: 8000, scanDepth: 2, recursive: true, messageCount: 40,
});

console.log(`book      ${r.name}`);
console.log(`enabled   ${entries.length} of ${r.data.entries.length} entries`);
console.log(`message   "${line.slice(0, 70)}..."`);
console.log(`\nfired     ${res.entries.length} entries, ~${res.tokens.toLocaleString('en-US')} tokens of ${res.budget.toLocaleString('en-US')}${res.overflowed ? '  (BUDGET FULL)' : ''}\n`);

for (const t of res.trace.filter((x) => x.fired)) {
  const e = res.entries.find((x) => x.id === t.id);
  const title = (e.title || e.keys.slice(0, 3).join(', ') || '(untitled)').slice(0, 46);
  console.log(`  + ${title.padEnd(48)} ${String(t.tokens).padStart(5)} tok   ${t.why}`);
}
const blocked = res.trace.filter((x) => !x.fired);
if (blocked.length) {
  console.log(`\n  ${blocked.length} matched but were held back:`);
  const why = {};
  for (const b of blocked) why[b.why] = (why[b.why] || 0) + 1;
  for (const [w, n] of Object.entries(why)) console.log(`    ${String(n).padStart(3)} x  ${w}`);
}
