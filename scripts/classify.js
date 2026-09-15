// Gives every entry a type, once. Existing types are left alone.
import { open } from '../src/db/index.js';
import { classifyEntry, KINDS } from '../src/engine/classify.js';

const db = open(process.env.DB_PATH || 'data/tipsy.db');
const force = process.argv.includes('--all');
let touched = 0;
const tally = {};

for (const b of db.listLorebooks()) {
  for (const e of db.listEntries(b.id)) {
    if (!force && e.kind && e.kind !== 'note') continue;
    const g = classifyEntry(e);
    db.setEntryKind(e.id, g.kind);
    tally[g.kind] = (tally[g.kind] || 0) + 1;
    touched++;
  }
}

console.log(`Typed ${touched} entries.`);
for (const [k, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${KINDS[k].label}`);
}
db.close();
