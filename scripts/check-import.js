// Runs the importer over everything in samples/ and reports what it found.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { importFile } from '../src/import/index.js';

const dir = 'samples';
const files = readdirSync(dir).filter((f) => /\.(json|png|charx)$/i.test(f));

let ok = 0, failed = 0;
const byKind = {};
const allNotes = [];

for (const f of files) {
  const bytes = new Uint8Array(readFileSync(join(dir, f)));
  try {
    const r = importFile(f, bytes);
    ok++;
    byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    console.log(`OK   ${r.kind.padEnd(10)} ${String(r.name).slice(0, 44).padEnd(46)} ${r.detail}`);
    for (const n of r.notes) allNotes.push(`       [${n.level}] ${n.text}`);
  } catch (e) {
    failed++;
    console.log(`FAIL              ${f}`);
    console.log(`       ${e.code || e.name}: ${e.message}`);
  }
}

console.log(`\n${ok} read, ${failed} failed.  ${Object.entries(byKind).map(([k, v]) => `${v} ${k}`).join(', ')}`);
if (allNotes.length) {
  console.log('\nNotes raised:');
  console.log(allNotes.join('\n'));
}
