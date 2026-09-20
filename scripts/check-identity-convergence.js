// Saying two people are one, and knowing when Nexus cannot.
//
// A source being organised for the first time can be told that somebody in it
// is a person another source already established: nothing of its own stands in
// the way, so the declaration and the readings are written together and there
// is one person, not two.
//
// Once BOTH sources have their own, that same sentence means something much
// larger — rewriting approved readings, relations, story bindings, exclusions
// and more, in one migration. Nexus cannot do that yet. What it must never do
// is pretend: the decision used to be accepted and quietly dropped when no
// reading happened to use the person, and to fail on a raw database constraint
// when one did. Both are silence about a decision somebody made.
//
//   node scripts/check-identity-convergence.js
//
// Throwaway databases. No real library is read, and no real name appears.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../src/db/index.js';
import { analyzeSource } from '../src/conversion/analyze.js';
import { applyReview, ReviewError } from '../src/conversion/apply.js';
import { areDistinct, distinguish } from '../src/semantics/store.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
};

const PEOPLE = ['Aurelio Fontana', 'Renata Salk', 'Carlo Vancetti', 'Marco Durante'];
const build = () => {
  const db = open(join(mkdtempSync(join(tmpdir(), 'nexus-conv-')), 'x.db'));
  const make = (title) => {
    const id = db.createLorebook(title, '');
    const add = (e) => db.saveEntry(id, { order: 100, enabled: true, constant: false, probability: 100, ...e });
    for (const n of PEOPLE) {
      add({ keys: [n, n.split(' ')[1]], kind: 'character', title: n,
        content: `${n} keeps the books for three families and the patience of none of them. `
          + `He is careful, quiet, and owed favours by everyone in the district. ${n} has worked the harbour since he was fourteen.` });
    }
    for (const [t, c] of [
      ['03 WORLD — Tides and the harbour law', 'The harbour is governed by tide tables and an older set of customs.'],
      ['03 WORLD — The counting house', 'The counting house holds the ledgers, a strong room, and the long gallery.'],
    ]) add({ kind: 'rule', title: t, keys: ['harbour'], content: c });
    for (let i = 0; i < 26; i++) {
      add({ kind: 'direction', title: `02 NARRATION — how scenes are told ${i}`, keys: [`narration ${i}`],
        content: 'Keep scenes in the present tense and close on one person at a time.' });
    }
    return id;
  };
  return { db, A: make('HARBOUR ONE'), B: make('HARBOUR TWO') };
};

const entityRows = (draft) => draft.entities.map((x) => ({
  ref: x.ref, type: x.type, name: x.name, aliases: x.aliases, decision: 'new', proposedBy: 'deterministic-conversion',
}));
const entryRow = (e) => ({
  ref: e.ref, entryId: e.entryId, hash: e.hash, approve: true, confidence: e.confidence,
  scope: e.proposal.scope, category: e.proposal.category, defines: e.proposal.defines,
  subject: e.proposal.subject, related: e.proposal.related || [], displayPath: null,
  proposedBy: 'deterministic-conversion', reviewAction: 'preselected',
});
const identifying = (draft) => draft.entries.filter((e) => e.proposal && (e.proposal.defines || e.proposal.subject));
const payload = (draft, entries, matches = []) => ({
  role: null, entities: entityRows(draft), entries: entries.map(entryRow), matches, evidence: {},
});
const organise = (db, book) => {
  const draft = analyzeSource(db, book, {});
  applyReview(db, book, payload(draft, identifying(draft)));
  return draft;
};
const declOf = (db, book, ref) => db.raw.prepare('SELECT entity_id FROM source_entities WHERE lorebook_id=? AND local_ref=?').get(book, ref)?.entity_id;
const snap = (db) => JSON.stringify(['lore_entities', 'source_entities', 'entry_semantics', 'entry_relations', 'entity_distinctions']
  .map((t) => [t, db.raw.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c]));
const refFor = (draft, name) => draft.entities.find((x) => x.name === name)?.ref;
// What a refusal must look like: a stated problem, never a database error.
const refusal = (run) => {
  try { run(); return { refused: false }; } catch (err) {
    return { refused: true, isReview: err instanceof ReviewError, message: err.message, problems: err.problems || [], raw: /SQLITE|constraint failed/i.test(err.message) };
  }
};

console.log('1  a source being organised for the first time can be told who somebody already is');
{
  const { db, A, B } = build();
  organise(db, A);
  const entA = declOf(db, A, 'aurelio-fontana');
  const draftB = analyzeSource(db, B, {});
  const ref = refFor(draftB, 'Aurelio Fontana');
  const before = db.raw.prepare('SELECT COUNT(*) c FROM lore_entities').get().c;
  applyReview(db, B, payload(draftB, identifying(draftB), [{ entity: ref, entityId: entA, decision: 'same' }]));
  ok('it is accepted', true);
  ok('the second source declares the first one\'s person', declOf(db, B, 'aurelio-fontana') === entA);
  const sem = db.raw.prepare(`SELECT s.defines_entity_id FROM entry_semantics s JOIN lore_entries e ON e.id=s.entry_id
    WHERE e.lorebook_id=? AND e.title='Aurelio Fontana'`).get(B);
  ok('and its newly approved reading names that same person', sem?.defines_entity_id === entA);
  const made = db.raw.prepare("SELECT COUNT(*) c FROM lore_entities WHERE canonical_name='Aurelio Fontana'").get().c;
  ok('nobody was made twice', made === 1, `${made} of that name`);
  ok('the other people were still made', db.raw.prepare('SELECT COUNT(*) c FROM lore_entities').get().c > before);
  db.close();
}

console.log('\n2  once both already have their own, it is refused — with nothing ticked');
{
  const { db, A, B } = build();
  organise(db, A);
  organise(db, B);
  const entA = declOf(db, A, 'aurelio-fontana');
  const entB = declOf(db, B, 'aurelio-fontana');
  ok('they really are two', entA !== entB);
  const before = snap(db);
  const draftB = analyzeSource(db, B, {});
  const ref = refFor(draftB, 'Aurelio Fontana');
  const r = refusal(() => applyReview(db, B, payload(draftB, [], [{ entity: ref, entityId: entA, decision: 'same' }])));
  ok('it is refused rather than accepted and dropped', r.refused, r.message?.slice(0, 60));
  ok('as a stated problem', r.isReview && r.problems.length > 0, JSON.stringify(r.problems[0] || {}).slice(0, 110));
  ok('in words about the real limitation', /already has its own/i.test(r.problems[0]?.message || ''));
  ok('and nothing in the library moved', snap(db) === before);
  db.close();
}

console.log('\n3  and the same refusal when readings are re-approved');
{
  const { db, A, B } = build();
  organise(db, A);
  organise(db, B);
  const entA = declOf(db, A, 'aurelio-fontana');
  const before = snap(db);
  const draftB = analyzeSource(db, B, {});
  const ref = refFor(draftB, 'Aurelio Fontana');
  const uses = draftB.entries.filter((e) => e.proposal && (e.proposal.defines === ref || e.proposal.subject === ref));
  ok('there are readings that name them', uses.length > 0, `${uses.length}`);
  const r = refusal(() => applyReview(db, B, payload(draftB, uses, [{ entity: ref, entityId: entA, decision: 'same' }])));
  ok('it is refused', r.refused);
  ok('no database error escapes', !r.raw, r.message?.slice(0, 70));
  ok('it is the same stated problem', r.isReview && /already has its own/i.test(r.problems[0]?.message || ''));
  ok('and nothing in the library moved', snap(db) === before);
  db.close();
}

console.log('\n4  a pair already kept apart is not quietly rejoined');
{
  const { db, A, B } = build();
  organise(db, A);
  organise(db, B);
  const entA = declOf(db, A, 'aurelio-fontana');
  const entB = declOf(db, B, 'aurelio-fontana');
  distinguish(db, entA, entB);
  const before = snap(db);
  const draftB = analyzeSource(db, B, {});
  const ref = refFor(draftB, 'Aurelio Fontana');
  const r = refusal(() => applyReview(db, B, payload(draftB, [], [{ entity: ref, entityId: entA, decision: 'same' }])));
  ok('it is refused', r.refused && r.isReview);
  ok('and says they were kept apart before', /kept as separate identities/i.test(r.problems[0]?.message || ''),
    (r.problems[0]?.message || '').slice(0, 80));
  ok('the earlier decision is untouched', areDistinct(db, entA, entB));
  ok('and nothing in the library moved', snap(db) === before);
  db.close();
}

console.log('\n5  saying it of somebody this source already declares is not an error');
{
  const { db, A, B } = build();
  organise(db, A);
  const entA = declOf(db, A, 'aurelio-fontana');
  const d1 = analyzeSource(db, B, {});
  applyReview(db, B, payload(d1, identifying(d1), [{ entity: refFor(d1, 'Aurelio Fontana'), entityId: entA, decision: 'same' }]));
  ok('both sources now declare the one person', declOf(db, B, 'aurelio-fontana') === entA);
  const before = snap(db);
  const d2 = analyzeSource(db, B, {});
  const r = refusal(() => applyReview(db, B, payload(d2, [], [{ entity: refFor(d2, 'Aurelio Fontana'), entityId: entA, decision: 'same' }])));
  ok('saying it again is not refused', !r.refused, r.problems?.[0]?.message?.slice(0, 70) || '');
  ok('and changes nothing', snap(db) === before);
  db.close();
}

console.log('\n6  keeping them apart still writes one decision, and only about that pair');
{
  const { db, A, B } = build();
  organise(db, A);
  organise(db, B);
  const entA = declOf(db, A, 'aurelio-fontana');
  const entB = declOf(db, B, 'aurelio-fontana');
  const entC = declOf(db, B, 'renata-salk');
  const d = analyzeSource(db, B, {});
  const ref = refFor(d, 'Aurelio Fontana');
  applyReview(db, B, payload(d, [], [{ entity: ref, entityId: entA, decision: 'separate' }]));
  ok('one decision is written', db.raw.prepare('SELECT COUNT(*) c FROM entity_distinctions').get().c === 1);
  ok('and it is about that pair', areDistinct(db, entA, entB));
  applyReview(db, B, payload(analyzeSource(db, B, {}), [], [{ entity: ref, entityId: entA, decision: 'separate' }]));
  ok('saying it twice is still one decision', db.raw.prepare('SELECT COUNT(*) c FROM entity_distinctions').get().c === 1);
  ok('A apart from B says nothing about A and C', !areDistinct(db, entA, entC));
  ok('nor about B and C', !areDistinct(db, entB, entC));
  db.close();
}

console.log('\n7  deciding later decides nothing');
{
  const { db, A, B } = build();
  organise(db, A);
  organise(db, B);
  const entA = declOf(db, A, 'aurelio-fontana');
  const before = snap(db);
  const d = analyzeSource(db, B, {});
  applyReview(db, B, payload(d, [], [{ entity: refFor(d, 'Aurelio Fontana'), entityId: entA, decision: 'later' }]));
  ok('nothing is written', snap(db) === before);
  ok('and no decision was recorded either way', db.raw.prepare('SELECT COUNT(*) c FROM entity_distinctions').get().c === 0);
  db.close();
}

console.log('\n8  nothing about this phase joins identities');
{
  const { db, A, B } = build();
  organise(db, A);
  organise(db, B);
  ok('no entity was ever merged', db.raw.prepare('SELECT COUNT(*) c FROM lore_entities WHERE merged_into_id IS NOT NULL').get().c === 0);
  const entA = declOf(db, A, 'aurelio-fontana');
  const entB = declOf(db, B, 'aurelio-fontana');
  const d = analyzeSource(db, B, {});
  refusal(() => applyReview(db, B, payload(d, [], [{ entity: refFor(d, 'Aurelio Fontana'), entityId: entA, decision: 'same' }])));
  ok('a refused join leaves both declarations where they were',
    declOf(db, A, 'aurelio-fontana') === entA && declOf(db, B, 'aurelio-fontana') === entB);
  ok('and still no merge', db.raw.prepare('SELECT COUNT(*) c FROM lore_entities WHERE merged_into_id IS NOT NULL').get().c === 0);
  db.close();
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exitCode = fail ? 1 : 0;
