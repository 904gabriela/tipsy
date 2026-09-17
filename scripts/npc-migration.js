// The cast table, checked and — only when clean — rebuilt.
//
//   node scripts/npc-migration.js check  [DB_PATH=...]
//   node scripts/npc-migration.js apply  [DB_PATH=...]
//
// `check` writes nothing and says where every row stands. `apply` refuses
// unless check is clean, and then does the whole rebuild in one transaction.
// Neither asks a provider anything.

import { open } from '../src/db/index.js';
import { npcMigrationReadiness, applyNpcMigration, NpcMigrationError } from '../src/semantics/npc-migration.js';

const mode = process.argv[2];
const path = process.env.DB_PATH || 'data/tipsy.db';
if (!['check', 'apply'].includes(mode)) { console.error('usage: node scripts/npc-migration.js check|apply'); process.exit(2); }

const db = open(path);
const r = npcMigrationReadiness(db);
const pad = (s, w) => String(s ?? '').slice(0, w).padEnd(w);

if (r.alreadyMigrated || r.shape === 'missing') {
  console.log(`The cast table is already in its final shape (${path}). Nothing to do.`);
  db.close(); process.exit(0);
}

console.log(`Cast table: ${r.shape}   rows: ${r.rows.length}`);
console.log(`  Ready: ${r.ready}   Needs decision: ${r.needsDecision}`);
if (r.groups.length) console.log(`  Same person, several rows: ${r.groups.length} group(s), ${r.conflicts.length} in conflict`);
if (r.collisions.length) console.log(`  Rows that are the persona: ${r.collisions.length}`);
if (r.notPeople.length) console.log(`  Rows pointing at something that is not a person: ${r.notPeople.length}`);
console.log('');
for (const row of r.rows) {
  console.log(`  ${pad(row.status, 11)} ${pad(row.story, 26)} ${pad(row.entry || '(entry gone)', 22)} ${pad(row.role, 11)} ${row.why}`);
}
for (const g of r.groups) {
  console.log(`\n  ${g.conflict ? 'CONFLICT' : 'will merge'}: ${g.name} in ${g.story} — ${g.rows.length} rows, roles ${g.roles.join(' / ')}`);
}
console.log('');

if (mode === 'check') {
  console.log(r.canApply ? 'Ready to apply.' : 'Not ready: the rows marked above need a decision first. Nothing was changed.');
  db.close(); process.exit(r.canApply ? 0 : 1);
}

try {
  const done = applyNpcMigration(db);
  console.log(`Rebuilt: ${done.migrated} cast rows${done.merged ? `, ${done.merged} merged into them` : ''}. Foreign keys clean.`);
  db.close(); process.exit(0);
} catch (e) {
  console.error(e instanceof NpcMigrationError ? e.message : e.stack);
  db.close(); process.exit(1);
}
