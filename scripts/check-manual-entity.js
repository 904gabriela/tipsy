// Somebody can say what an entry introduces, and make the thing it introduces.
//
// The analyser will not always find a person a source plainly has. It refuses
// to introduce one on thin evidence, and it is right to: an entry carrying an
// unfamiliar name is sometimes that person's own entry and sometimes guidance
// about somebody else entirely, and nothing in the text tells the two apart.
// So the decision is a person's, and this checks that the decision survives:
// that it writes one entity and not two, that saying it twice changes nothing,
// and that a person made this way can be used again afterwards — which matters
// because reading the source a second time will still not discover them.
//
//   node scripts/check-manual-entity.js
//
// Throwaway databases. No real library is read, and no real name appears.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../src/db/index.js';
import { analyzeSource } from '../src/conversion/analyze.js';
import { applyReview } from '../src/conversion/apply.js';
import { declarationsOf, currentEntity } from '../src/semantics/store.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
};
const tmp = () => join(mkdtempSync(join(tmpdir(), 'nexus-manual-')), 'x.db');
const count = (db, table) => db.raw.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;

// A source with a cast, and one entry whose subject the analyser will not
// settle. Nothing here is shaped to force a particular reading.
const build = () => {
  const db = open(tmp());
  const book = db.createLorebook('HARBOUR CANON LOREBOOK', '');
  const add = (e) => db.saveEntry(book, {
    order: 100, enabled: true, constant: false, probability: 100,
    keys: e.keys, kind: e.kind, title: e.title, content: e.content,
  });
  for (const name of ['Aurelio Fontana', 'Renata Salk', 'Carlo Vancetti']) {
    add({
      kind: 'character', title: name, keys: [name, name.split(' ')[1]],
      content: `${name} has worked the harbour since before the new law. ${name} is careful, quiet, `
        + `and owed favours by everyone in the district. People bring ${name} their disputes.`,
    });
  }
  add({
    kind: 'note', title: 'Ottavia Ferri', keys: ['north gate'],
    content: 'Aurelio Fontana wants the north gate contract and Renata Salk means to stop him. '
      + 'The counting house has not ruled, and the tide tables say it must by the evening bell.',
  });
  return { db, book };
};

// What the screen would send: every entity it knows, plus the one decision.
const decisionsFor = (draft, entryRef, entity) => ({
  role: null,
  entities: [
    ...draft.entities.map((x) => ({ ref: x.ref, type: x.type, name: x.name, aliases: x.aliases, decision: 'new', proposedBy: 'deterministic-conversion' })),
    entity,
  ],
  entries: [(() => {
    const e = draft.entries.find((x) => x.ref === entryRef);
    return {
      ref: e.ref, entryId: e.entryId, hash: e.hash, approve: true, confidence: e.confidence,
      scope: 'entity', category: 'profile', defines: entity.ref, subject: null, related: [],
      displayPath: null, proposedBy: 'manual', reviewAction: 'edited',
    };
  })()],
  matches: [],
  evidence: {},
});

const MADE = { ref: 'ottavia-ferri', type: 'person', name: 'Ottavia Ferri', aliases: [], decision: 'new', proposedBy: 'manual' };

console.log('A  a person somebody made, and the entry that introduces them');
let keep = null;
{
  const { db, book } = build();
  const draft = analyzeSource(db, book, {});
  const entry = draft.entries.find((e) => e.title === 'Ottavia Ferri');
  ok('the analyser did not introduce them by itself',
    !draft.entities.some((x) => x.name === 'Ottavia Ferri'), `${draft.entities.length} proposed, none of that name`);

  const before = { ents: count(db, 'lore_entities'), decs: count(db, 'source_entities') };
  const result = applyReview(db, book, decisionsFor(draft, entry.ref, MADE));

  ok('one person was made', count(db, 'lore_entities') - before.ents === 1,
    `${before.ents} → ${count(db, 'lore_entities')}`);
  const made = db.raw.prepare("SELECT * FROM lore_entities WHERE canonical_name='Ottavia Ferri'").all();
  ok('of the kind that was asked for', made.length === 1 && made[0].type === 'person', made[0]?.type);
  const dec = db.raw.prepare('SELECT * FROM source_entities WHERE lorebook_id=? AND entity_id=?').get(book, made[0].id);
  ok('the source declares them', !!dec);
  ok('under the ref the screen chose', dec?.local_ref === 'ottavia-ferri', dec?.local_ref);
  ok('and records that a person said so', JSON.parse(dec?.evidence || '{}').proposedBy === 'manual',
    JSON.parse(dec?.evidence || '{}').proposedBy);

  const sem = db.raw.prepare('SELECT * FROM entry_semantics WHERE entry_id=?').get(entry.entryId);
  ok('the entry is recorded as introducing them', sem?.defines_entity_id === made[0].id);
  ok('as their profile', sem?.category === 'profile' && sem?.scope === 'entity', `${sem?.scope}/${sem?.category}`);
  ok('nothing is also recorded as being about somebody',
    !db.raw.prepare("SELECT 1 FROM entry_relations WHERE entry_id=? AND relation='subject'").get(entry.entryId));
  const ev = JSON.parse(sem?.evidence || '{}');
  ok('the reading is a person\'s, decided in review', ev.proposedBy === 'manual' && ev.decidedIn === 'review',
    `${ev.proposedBy} / ${ev.decidedIn} / ${ev.reviewAction}`);
  ok('and says they edited it', ev.reviewAction === 'edited');
  ok('apply reported the entity', !!result.entities['ottavia-ferri']);
  keep = { db, book, entryId: entry.entryId, entityId: made[0].id };
}

console.log('\nB  saying it a second time makes nothing new');
{
  const { db, book } = keep;
  const draft = analyzeSource(db, book, {});
  const entry = draft.entries.find((e) => e.entryId === keep.entryId);
  const before = { ents: count(db, 'lore_entities'), decs: count(db, 'source_entities') };
  applyReview(db, book, decisionsFor(draft, entry.ref, MADE));
  ok('no second person', count(db, 'lore_entities') === before.ents, `${before.ents} → ${count(db, 'lore_entities')}`);
  ok('no second declaration', count(db, 'source_entities') === before.decs);
  const sem = db.raw.prepare('SELECT * FROM entry_semantics WHERE entry_id=?').get(keep.entryId);
  ok('and it still points at the same person', sem.defines_entity_id === keep.entityId);
}

console.log('\nC  and they can be used again, though reading it again never finds them');
{
  const { db, book } = keep;
  const draft = analyzeSource(db, book, {});
  ok('the analyser still does not introduce them',
    !draft.entities.some((x) => x.name === 'Ottavia Ferri'));
  const declared = declarationsOf(db, book).filter((x) => x.status === 'approved');
  const mine = declared.find((x) => x.local_ref === 'ottavia-ferri');
  ok('but the source still says who they are', !!mine);
  ok('with the kind kept', currentEntity(db, mine.entity_id)?.type === 'person');
  ok('and the name kept', currentEntity(db, mine.entity_id)?.canonical_name === 'Ottavia Ferri');

  // A second entry pointed at the same person, the way the screen would: the
  // declaration supplies the ref, so nothing is made twice.
  const other = draft.entries.find((e) => e.title === 'Carlo Vancetti');
  const before = count(db, 'lore_entities');
  applyReview(db, book, {
    role: null,
    entities: [
      ...draft.entities.map((x) => ({ ref: x.ref, type: x.type, name: x.name, aliases: x.aliases, decision: 'new', proposedBy: 'deterministic-conversion' })),
      { ref: mine.local_ref, type: 'person', name: mine.local_name, aliases: [], decision: 'existing', entityId: mine.entity_id, proposedBy: 'manual' },
    ],
    entries: [{
      ref: other.ref, entryId: other.entryId, hash: other.hash, approve: true, confidence: other.confidence,
      scope: 'entity', category: 'personality', defines: null, subject: mine.local_ref, related: [],
      displayPath: null, proposedBy: 'manual', reviewAction: 'edited',
    }],
    matches: [],
    evidence: {},
  });
  ok('using them again makes nobody new', count(db, 'lore_entities') === before, `${before} → ${count(db, 'lore_entities')}`);
  const rel = db.raw.prepare("SELECT entity_id FROM entry_relations WHERE entry_id=? AND relation='subject'").get(other.entryId);
  ok('and the other entry is about that same person', rel?.entity_id === keep.entityId);
}

console.log('\nD  the shapes Apply refuses, so the screen can never build them');
{
  const { db, book } = build();
  const draft = analyzeSource(db, book, {});
  const entry = draft.entries.find((e) => e.title === 'Ottavia Ferri');
  const base = decisionsFor(draft, entry.ref, MADE);
  const refused = (change, why) => {
    const d = JSON.parse(JSON.stringify(base));
    change(d);
    let threw = null;
    try { applyReview(db, book, d); } catch (err) { threw = err.message; }
    ok(why, !!threw, threw ? threw.slice(0, 70) : 'it was ACCEPTED');
  };
  refused((d) => { d.entries[0].subject = MADE.ref; }, 'introducing something and being about something at once');
  refused((d) => { d.entries[0].scope = 'world'; }, 'introducing something while being nobody\'s');
  refused((d) => { d.entities.pop(); }, 'introducing something this review does not have');
  refused((d) => { d.entities[d.entities.length - 1].type = 'creature'; }, 'a kind of thing that does not exist');
  refused((d) => { d.entities[d.entities.length - 1].name = '   '; }, 'something with no name');
}

console.log('\nE  a thing nobody points at is never made');
{
  const { db, book } = build();
  const draft = analyzeSource(db, book, {});
  const before = count(db, 'lore_entities');
  applyReview(db, book, {
    role: null,
    entities: [{ ref: 'nobody-points-here', type: 'place', name: 'The Empty Wharf', aliases: [], decision: 'new', proposedBy: 'manual' }],
    entries: [],
    matches: [],
    evidence: {},
  });
  ok('drafting something and saving nothing that uses it writes nothing',
    count(db, 'lore_entities') === before, `${before} → ${count(db, 'lore_entities')}`);
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exitCode = fail ? 1 : 0;
