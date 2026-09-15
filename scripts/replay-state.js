// Rebuild one story's derived memory from its canonical messages.
//
//   DB_PATH=... node scripts/replay-state.js "<story title fragment>" [--apply]
//
// Without --apply it refuses to touch anything but a copy: the derived layer
// is message_memory, episodes and snapshots, and rebuilding it never reads or
// writes a single message. The prose is the record; this is only the reading
// of it, and the reading is what went stale.

import { readFileSync, existsSync } from 'node:fs';
import { open } from '../src/db/index.js';
import * as memory from '../src/memory/index.js';

const DB = process.env.DB_PATH;
const want = process.argv[2] || '';
const apply = process.argv.includes('--apply');
if (!DB) { console.log('Set DB_PATH.'); process.exit(1); }
if (!apply && /[\\/]data[\\/]tipsy\.db$/i.test(DB)) {
  console.log('That is the live database. Pass --apply if you really mean it.');
  process.exit(1);
}

const env = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
const apiKey = (/OPENROUTER_API_KEY\s*=\s*(\S+)/.exec(env) || [])[1] || process.env.OPENROUTER_API_KEY;
if (!apiKey) { console.log('No API key.'); process.exit(1); }

const db = open(DB);
const story = db.listStories().find((s) => s.title.toLowerCase().includes(want.toLowerCase()));
if (!story) { console.log(`No story matching "${want}".`); process.exit(1); }
const full = db.getStory(story.id);

const before = memory.stateAt(db, full.head_id);
console.log(`story: ${full.title}`);
console.log(`stored now:  where="${before.scene.where}"  clock="${before.clock.display || ''}"  who=${JSON.stringify(before.scene.who)}`);
console.log(`             ${Object.keys(before.characters).length} characters, ${Object.keys(before.facts).length} facts, ${Object.keys(before.threads).length} threads`);

// The derived layer only. Messages, characters, lorebooks and personas are
// never touched, and running this twice produces the same thing rather than a
// second set of anything.
const path = db.pathTo(full.head_id, 100000);
console.log(`\nclearing the derived layer for ${path.length} messages…`);
db.transaction(() => {
  db.raw.prepare('DELETE FROM message_memory WHERE story_id=?').run(story.id);
  db.raw.prepare('DELETE FROM episodes WHERE story_id=?').run(story.id);
  db.raw.prepare('DELETE FROM state_snapshots WHERE story_id=?').run(story.id);
});

const settings = { ...full.settings };
const cast = (full.characters || []).map((c) => c.name);
const persona = full.persona ? full.persona.name : null;
console.log(`cast: ${cast.join(', ') || '(none)'}   persona: ${persona || '(none)'}\n`);

const moves = [];
let last = '';
let done = 0;
let failed = 0;
const t0 = Date.now();

for (const m of path) {
  if (m.role !== 'assistant') continue;
  try {
    await memory.remember(db, { storyId: story.id, messageId: m.id, apiKey, settings, cast, persona });
    done++;
  } catch (e) {
    failed++;
    if (failed >= 5) { console.log(`stopping: ${failed} failures, last was ${e.message}`); break; }
    continue;
  }
  const mem = db.getMessageMemory(m.id);
  const w = mem?.delta?.scene?.where;
  if (w && w !== last) { moves.push({ depth: m.depth, where: w }); last = w; }
  if (done % 20 === 0) {
    process.stdout.write(`  ${done} exchanges read, ${moves.length} moves, ${Math.round((Date.now() - t0) / 1000)}s\n`);
  }
}

// One last look at the recent window, together rather than one exchange at a
// time. A move nobody narrated is invisible to the sequential pass and plain
// here. It declines rather than guesses, so a rebuild that was already right
// stays right.
let reconciled = null;
try {
  const state = memory.stateAt(db, full.head_id);
  reconciled = await memory.reconcileScene({
    apiKey,
    model: (settings.memory?.model) || 'deepseek/deepseek-v4-flash',
    window: memory.sceneWindow(path, { turns: 8 }),
    state,
    persona,
    providers: settings.memory?.providers || null,
  });
  if (reconciled.applied) {
    db.addOverride(story.id, {
      afterId: full.head_id, path: 'scene/where', value: reconciled.after,
      note: 'read back from the recent scene after a rebuild',
    });
  }
} catch (e) {
  console.log(`\nthe scene check could not run: ${e.message}`);
}

const after = memory.stateAt(db, full.head_id);
console.log(`\n--- where the scene went, as rebuilt today ---`);
for (const mv of moves) console.log(`  depth ${String(mv.depth).padStart(4)} → ${mv.where}`);

if (reconciled) {
  console.log(`\nreading the last 8 messages together: ${reconciled.applied ? `moved to "${reconciled.after}"` : 'no move'} — ${reconciled.reason}`);
}
console.log(`\nOLD stored current location:\n    ${before.scene.where || '(none)'}`);
console.log(`NEW reconstructed location:\n    ${after.scene.where || '(none)'}`);
console.log(`\nclock:      ${before.clock.display || '(none)'}   →   ${after.clock.display || '(none)'}`);
console.log(`present:    ${JSON.stringify(before.scene.who)}   →   ${JSON.stringify(after.scene.who)}`);
console.log(`characters: ${Object.keys(before.characters).length} → ${Object.keys(after.characters).length}`);
console.log(`facts:      ${Object.keys(before.facts).length} → ${Object.keys(after.facts).length}`);
console.log(`threads:    ${Object.keys(before.threads).length} → ${Object.keys(after.threads).length}`);
const openOf = (s) => Object.values(s.threads).filter((t) => t.status === 'open' || t.status === 'in-progress').length;
console.log(`open:       ${openOf(before)} → ${openOf(after)}`);
console.log(`\nread ${done} exchanges, ${failed} failed, in ${Math.round((Date.now() - t0) / 1000)}s`);
db.close();
