// What is in a story's unfinished business that would not be there today.
//
//   DB_PATH=... node scripts/check-legacy-threads.js "<story>"
//
// Reads only. It proposes and never applies: a promise recorded badly is
// still a promise, and the difference between noise and a debt is a judgement
// somebody has to make on purpose.

import { open } from '../src/db/index.js';
import * as memory from '../src/memory/index.js';
import { normalizeStatus, isOpen, STATUS, threadWords, findThread } from '../src/memory/state.js';

const db = open(process.env.DB_PATH);
const want = process.argv[2] || '';
const story = db.listStories().find((s) => s.title.toLowerCase().includes(want.toLowerCase()));
if (!story) { console.log(`No story matching "${want}".`); process.exit(1); }
const state = memory.stateAt(db, db.getStory(story.id).head_id);
const threads = Object.entries(state.threads).map(([id, t]) => ({ id, ...t }));

console.log(`${story.title}\n  ${threads.length} threads, ${threads.filter(isOpen).length} still owed\n`);

// ---- what the statuses actually say
const raw = new Map();
for (const t of threads) raw.set(t.status, (raw.get(t.status) || 0) + 1);
console.log('statuses as stored:');
for (const [s, n] of [...raw].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${String(n).padStart(4)}  ${JSON.stringify(String(s).slice(0, 54))}  →  ${normalizeStatus(s)}`);
}
const offEnum = [...raw.keys()].filter((s) => !Object.values(STATUS).includes(s));
console.log(`\n  ${offEnum.length} of those are not in the vocabulary, and would be normalised on a rebuild.`);

// ---- the same matter, recorded more than once
console.log('\nlikely the same matter, recorded more than once:');
const groups = [];
const placed = new Set();
for (const t of threads) {
  if (placed.has(t.id)) continue;
  const group = [t];
  placed.add(t.id);
  const others = {};
  for (const o of threads) if (!placed.has(o.id)) others[o.id] = o;
  let hit;
  while ((hit = findThread(others, t))) {
    group.push(others[hit]);
    placed.add(hit);
    delete others[hit];
  }
  if (group.length > 1) groups.push(group);
}
groups.sort((a, b) => b.length - a.length);
for (const g of groups.slice(0, 8)) {
  console.log(`  ${g.length} copies — "${String(g[0].text).slice(0, 62)}…"`);
}
const collapsed = groups.reduce((n, g) => n + g.length - 1, 0);
console.log(`  ${groups.length} groups, ${collapsed} rows would fold into one another.`);

// ---- what the current extractor is told is not unfinished business
//
// Taken from the extractor's own instructions rather than invented here, so
// the two can never drift apart.
const NOT_BUSINESS = [
  [/\bwhat .* (will |would )?wear\b|\bwhich (dress|outfit|clothes)\b/i, 'what somebody will wear'],
  [/\bwhat .* will say\b/i, 'what somebody will say next'],
  [/\bwhether .* is ready to\b/i, 'whether somebody is ready'],
  [/\bhow .* will react\b/i, 'how somebody will react'],
  [/\bwhether .* agrees to come\b/i, 'whether somebody comes along'],
  [/\bwhat happens (next|now)\b/i, 'what happens next, which is the scene moving'],
];
console.log('\nwould not be recorded as unfinished business today:');
let noise = 0;
for (const t of threads) {
  const why = NOT_BUSINESS.find(([rx]) => rx.test(t.text || ''));
  if (!why) continue;
  noise++;
  console.log(`  [${normalizeStatus(t.status).padEnd(8)}] ${String(t.text).slice(0, 58)}`);
  console.log(`             — the extractor names this as ${why[1]}`);
}
if (!noise) console.log('  (none)');

// ---- what must survive whatever else happens
const KEEPS = /\bpromis|\bswore|\bowes?\b|\bwill (call|tell|explain|teach|take|bring|show|come back|return)\b|\bsecret\b|\bdebt\b/i;
const keep = threads.filter((t) => isOpen(t) && KEEPS.test(t.text || ''));
console.log(`\ngenuine promises, debts and secrets still owed: ${keep.length}`);
for (const t of keep.slice(0, 8)) console.log(`  ${String(t.text).slice(0, 66)}`);

console.log(`\nproposed, not applied:`);
console.log(`  normalise ${offEnum.length} status values`);
console.log(`  fold ${collapsed} duplicate rows into ${groups.length} matters`);
console.log(`  review ${noise} entries that today would not be recorded at all`);
console.log(`  keep ${keep.length} promises/debts untouched`);
db.close();
