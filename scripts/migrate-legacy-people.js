// Move files that were imported as people, but are not people, to where they
// belong.
//
//   node scripts/migrate-legacy-people.js            dry run: says what it would do
//   node scripts/migrate-legacy-people.js --apply    does it, in one transaction
//
// DB_PATH picks the database, as everywhere else. Back the database up first.
//
// Before the semantic classifier existed every card became a Character, so
// scenario packs and campaign worlds sit in the People shelf and the character
// picker. This re-reads each one with today's classifier and moves only what
// it is sure about:
//
//   - high confidence Scenario or World, and
//   - not used by any story (a story's cast is never rewritten here).
//
// Anything medium or low stays exactly where it is, for a person to decide.
//
// What moves is rebuilt the same way a fresh import builds it, from the card
// file kept on the character row. The book that came inside the card is not
// copied: the existing book is re-attached to the new Scenario or World, so its
// entries, their ids, and anything pointing at them survive. Exact duplicates
// — the same file imported twice, matched by a hash of the stored file, never
// by title — become one resource. A duplicate's own copy of the book is removed
// only if it is identical entry for entry and nothing uses it; otherwise it is
// kept and attached as well.
//
// No provenance is invented: these arrived before import records existed, and
// they still have none. Running it twice creates nothing the second time.

import { createHash } from 'node:crypto';
import { open } from '../src/db/index.js';
import { normalizeCard } from '../src/import/card.js';
import { classifyCard } from '../src/import/semantics.js';
import { planFor, applyPlan } from '../src/import/plan.js';

const APPLY = process.argv.includes('--apply');
const db = open(process.env.DB_PATH || 'data/tipsy.db');
const q = (sql, ...a) => db.raw.prepare(sql).all(...a);
const one = (sql, ...a) => db.raw.prepare(sql).get(...a);
const hash = (s) => createHash('sha256').update(String(s)).digest('hex');

const TABLE = { scenario: 'scenarios', framework: 'frameworks' };
const WORD = { scenario: 'Scenario', framework: 'World', character: 'Character' };

/** A book's content, entry by entry, without ids or timestamps. */
function bookPrint(bookId) {
  return hash(JSON.stringify(q(
    `SELECT title, content, keys, secondary_keys, enabled, constant, ord, position, depth, probability, kind
     FROM lore_entries WHERE lorebook_id=? ORDER BY display_index, title`, bookId)));
}

/** Whether anything at all points at a book or its entries. */
function bookInUse(bookId) {
  const n = (sql) => one(sql, bookId).n;
  return n(`SELECT COUNT(*) n FROM story_lorebooks WHERE lorebook_id=?`)
    + n(`SELECT COUNT(*) n FROM resource_lorebooks WHERE lorebook_id=?`)
    + n(`SELECT COUNT(*) n FROM story_npcs WHERE entry_id IN (SELECT id FROM lore_entries WHERE lorebook_id=?)`)
    + n(`SELECT COUNT(*) n FROM entry_character_links WHERE entry_id IN (SELECT id FROM lore_entries WHERE lorebook_id=?)`)
    + n(`SELECT COUNT(*) n FROM entry_entry_links WHERE entry_id IN (SELECT id FROM lore_entries WHERE lorebook_id=?)`)
    + n(`SELECT COUNT(*) n FROM entry_entry_links WHERE about_id IN (SELECT id FROM lore_entries WHERE lorebook_id=?)`)
    + n(`SELECT COUNT(*) n FROM personas WHERE from_entry IN (SELECT id FROM lore_entries WHERE lorebook_id=?)`) > 0;
}

// ------------------------------------------------------------------ read
const report = { move: [], stay: [], review: [], blocked: [] };
const groups = new Map();

for (const c of q(`SELECT id, name, original, avatar FROM characters ORDER BY name COLLATE NOCASE`)) {
  let card = null;
  try { card = normalizeCard(JSON.parse(c.original), c.name); } catch { /* typed by hand, or not a card */ }
  if (!card) { report.stay.push({ c, why: 'written in the app, not imported from a card' }); continue; }

  const verdict = classifyCard(card, { format: card.spec });
  const row = { c, card, verdict };
  if (verdict.role === 'character' && verdict.confidence === 'high') { report.stay.push({ ...row, why: 'high confidence Character' }); continue; }
  if (verdict.confidence !== 'high') { report.review.push({ ...row, why: `${verdict.confidence} confidence ${WORD[verdict.role] || verdict.role}` }); continue; }

  const stories = one(`SELECT COUNT(*) n FROM story_characters WHERE character_id=?`, c.id).n;
  if (stories) { report.blocked.push({ ...row, why: `used by ${stories} ${stories === 1 ? 'story' : 'stories'}` }); continue; }

  const key = hash(c.original);
  if (!groups.has(key)) groups.set(key, { key, role: verdict.role, members: [] });
  groups.get(key).members.push(row);
}
report.move = [...groups.values()];

const before = {
  characters: one(`SELECT COUNT(*) n FROM characters`).n,
  scenarios: one(`SELECT COUNT(*) n FROM scenarios`).n,
  frameworks: one(`SELECT COUNT(*) n FROM frameworks`).n,
  lorebooks: one(`SELECT COUNT(*) n FROM lorebooks`).n,
  entries: one(`SELECT COUNT(*) n FROM lore_entries`).n,
};

console.log(APPLY ? 'Applying.\n' : 'Dry run. Nothing will be changed. Add --apply to do it.\n');
console.log(`Move (${report.move.reduce((n, g) => n + g.members.length, 0)} people-shelf items → ${report.move.length} resources):`);
for (const g of report.move) {
  const [first] = g.members;
  const books = g.members.flatMap((m) => q(`SELECT id, name FROM lorebooks WHERE from_character=?`, m.c.id));
  console.log(`  → ${WORD[g.role].padEnd(9)} ${first.c.name}${g.members.length > 1 ? `  (×${g.members.length}, identical files)` : ''}${books.length ? `  · ${books.length} embedded book${books.length > 1 ? 's' : ''}` : ''}`);
}
for (const [label, list] of [['Stay a Character', report.stay], ['Left for review', report.review], ['Not moved, in use', report.blocked]]) {
  console.log(`\n${label} (${list.length}):`);
  for (const r of list) console.log(`  · ${r.c.name}  — ${r.why}`);
}

// ----------------------------------------------------------------- write
if (APPLY && report.move.length) {
  const done = db.transaction(() => {
    const out = [];
    for (const g of report.move) {
      const [primary, ...dupes] = g.members;
      const card = { ...primary.card, lorebook: null };        // the book already exists; do not make another
      const stored = JSON.stringify(primary.card._original ?? null);

      // Already moved by an earlier run that stopped part way: use that one.
      let id = one(`SELECT id FROM ${TABLE[g.role]} WHERE original=?`, stored)?.id || null;
      if (!id) {
        const plan = planFor(card, primary.verdict);
        id = applyPlan(db, { card, plan, importId: null }).primary.id;
        // Copies of the same file did not all keep its picture; any one that did is enough.
        const avatar = g.members.map((m) => m.c.avatar).find(Boolean);
        if (avatar) db.raw.prepare(`UPDATE ${TABLE[g.role]} SET avatar=? WHERE id=?`).run(avatar, id);
      }

      let keptPrint = null;
      let removedBooks = 0;
      let attachedBooks = 0;
      for (const m of [primary, ...dupes]) {
        for (const b of q(`SELECT id FROM lorebooks WHERE from_character=?`, m.c.id)) {
          // Detach first: deleting the character would otherwise take its book with it.
          db.raw.prepare(`UPDATE lorebooks SET from_character=NULL WHERE id=?`).run(b.id);
          const print = bookPrint(b.id);
          if (keptPrint && print === keptPrint && !bookInUse(b.id)) {
            db.deleteLorebook(b.id);
            removedBooks++;
          } else {
            db.linkLorebook(g.role, id, b.id);
            keptPrint = keptPrint || print;
            attachedBooks++;
          }
        }
        db.setStartingPoints('character', m.c.id, []);
        db.deleteCharacter(m.c.id);
      }
      out.push({ name: primary.c.name, role: g.role, id, merged: g.members.length, attachedBooks, removedBooks });
    }
    return out;
  });

  const after = {
    characters: one(`SELECT COUNT(*) n FROM characters`).n,
    scenarios: one(`SELECT COUNT(*) n FROM scenarios`).n,
    frameworks: one(`SELECT COUNT(*) n FROM frameworks`).n,
    lorebooks: one(`SELECT COUNT(*) n FROM lorebooks`).n,
    entries: one(`SELECT COUNT(*) n FROM lore_entries`).n,
  };
  console.log('\nDone:');
  for (const d of done) console.log(`  ${WORD[d.role]} ${d.name}: ${d.merged} merged into one, ${d.attachedBooks} book(s) attached, ${d.removedBooks} identical unused copy(ies) removed`);
  console.log('\n           before  after');
  for (const k of Object.keys(before)) console.log(`  ${k.padEnd(10)} ${String(before[k]).padStart(5)}  ${String(after[k]).padStart(5)}`);
} else if (APPLY) {
  console.log('\nNothing to move.');
}

db.close();
