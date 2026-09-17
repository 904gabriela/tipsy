// Cleaning a library without losing anything.
//
//   node scripts/check-library-cleanup.js
//
// Throwaway databases and invented material. The promises held here: provenance
// is never ownership, a story's material is never collateral, "unused" means
// nothing is standing on it, a copy is a copy only when it is identical, a
// revision is never a copy, people outlive the sources that mentioned them, and
// nothing at all is written until somebody says delete.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { open } from '../src/db/index.js';
import { analyzeLibraryDependencies, unusedResources, dependencyKey } from '../src/library/dependencies.js';
import { findExactDuplicates, findPossibleVersions, compareSources, sourceFingerprint, redundantCopies } from '../src/library/duplicates.js';
import { previewLibraryDelete, applyLibraryDelete, deleteOneResource, LibraryDeleteError } from '../src/library/delete.js';
import { createEntity, declareInSource, setEntrySemantics, bindCharacterEntity } from '../src/semantics/store.js';
import { createEntityKnowledge, storyMaterialSource } from '../src/semantics/authoring.js';

let pass = 0; let fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? `  — ${d}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? `  — ${d}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);
const threw = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const db = open(join(mkdtempSync(join(tmpdir(), 'tipsy-p9-')), 'p9.db'));
const q = (sql, ...a) => db.raw.prepare(sql).all(...a);
const one = (sql, ...a) => db.raw.prepare(sql).get(...a);

const entry = (bookId, title, content, extra = {}) =>
  db.saveEntry(bookId, { ord: 100, enabled: true, constant: false, probability: 100, keys: [title.toLowerCase()], title, content, kind: 'note', ...extra });
const used = (kind, id) => analyzeLibraryDependencies(db, [{ kind, id }]).get(dependencyKey(kind, id));

// ------------------------------------------------------------------ a library
//
// A card with material that arrived inside it, a source two stories read, a
// source nobody reads, a world holding a source, a scenario, and the managed
// containers P7 and P8 introduced.

const patrickCard = db.writeCharacter({ name: 'Patrick Moretti', description: 'Careful.' });
const embedded = db.createLorebook('Lore that came in with Patrick', '');
entry(embedded, 'The Penthouse', 'The top floor, and the only door on it.');
db.raw.prepare('UPDATE lorebooks SET from_character=? WHERE id=?').run(patrickCard, embedded);

const shared = db.createLorebook('Harbour Files', '');
entry(shared, 'The West Docks', 'They run late.');
const orphan = db.createLorebook('Nobody reads this', '');
entry(orphan, 'A stray note', 'Nothing points at it.');

const patrick = createEntity(db, { type: 'person', name: 'Patrick Moretti', aliases: ['Patrick'] });
declareInSource(db, { lorebookId: shared, entityId: patrick, localRef: 'patrick', localName: 'Patrick Moretti', origin: 'manual', status: 'approved' });
bindCharacterEntity(db, patrickCard, patrick);

const story = db.createStory({ title: 'The Saint', characterIds: [patrickCard], lorebookIds: [shared] });
const idle = db.createStory({ title: 'An Idle Telling' });

const world = (() => {
  const id = `fw-${Date.now()}`;
  db.raw.prepare('INSERT INTO frameworks (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(id, 'The Harbour', Date.now(), Date.now());
  return id;
})();
const worldBook = db.createLorebook('World material', '');
entry(worldBook, 'Tides', 'Twice a day.');
if (world) db.raw.prepare("INSERT OR IGNORE INTO resource_lorebooks (owner_kind,owner_id,lorebook_id) VALUES ('framework',?,?)").run(world, worldBook);

// Managed containers: one story's own material, one person's reusable knowledge.
const material = storyMaterialSource(db, story);
const knowledge = createEntityKnowledge(db, {
  entityId: patrick, title: 'Advanced techniques', content: 'He counts the boats twice.',
  category: 'skill', activation: { mode: 'always', keys: [] },
});

// --------------------------------------------------------------- dependencies

section('what is holding something up, said in words');
ok('a card in a story is in use', used('character', patrickCard).used
  && /In the cast of The Saint/.test(used('character', patrickCard).reasons[0].text), used('character', patrickCard).reasons.map((r) => r.text).join('; '));
ok('a source a story reads is in use', used('source', shared).used
  && /Used by The Saint/.test(used('source', shared).reasons[0].text), used('source', shared).reasons.map((r) => r.text).join('; '));
ok('a source nobody reads is not', !used('source', orphan).used && !used('source', orphan).protected);
if (world) {
  ok('a source inside a world is in use', used('source', worldBook).used
    && /world The Harbour/.test(used('source', worldBook).reasons.map((r) => r.text).join('; ')), used('source', worldBook).reasons.map((r) => r.text).join('; '));
  ok('a world no story uses is not', !used('world', world).used);
}
ok('a story\'s own material is protected', used('source', material).protected
  && /story material for The Saint/i.test(used('source', material).reasons.map((r) => r.text).join('; ')), used('source', material).reasons.map((r) => r.text).join('; '));
ok('knowledge somebody wrote is protected though no story carries it',
  used('source', knowledge.lorebookId).protected
  && /Knowledge you wrote about Patrick Moretti/.test(used('source', knowledge.lorebookId).reasons.map((r) => r.text).join('; ')),
  used('source', knowledge.lorebookId).reasons.map((r) => r.text).join('; '));
ok('material that merely arrived with somebody is NOT held by them',
  !used('source', embedded).used, used('source', embedded).reasons.map((r) => r.text).join('; '));
ok('and the card says it will be left behind, not taken',
  /came in with them and stays/.test(used('character', patrickCard).detaches.join('; ')), used('character', patrickCard).detaches.join('; '));
// A card chosen to stand for somebody in a story — the one the database refuses
// to delete outright, so it must be caught before anything is attempted.
db.raw.prepare('INSERT INTO story_entity_cards (story_id, entity_id, character_id, created_at) VALUES (?,?,?,?)')
  .run(idle, patrick, patrickCard, Date.now());
ok('a card chosen to stand for somebody is in use, by name',
  /Chosen as the card for Patrick Moretti in An Idle Telling/.test(used('character', patrickCard).reasons.map((r) => r.text).join('; ')),
  used('character', patrickCard).reasons.map((r) => r.text).join('; '));
db.raw.prepare('DELETE FROM story_entity_cards WHERE story_id=?').run(idle);

section('select unused takes only what nothing stands on');
{
  const names = unusedResources(db, 'source').map((r) => r.name);
  ok('the source nobody reads is offered', names.includes('Nobody reads this'), names.join(' | '));
  ok('the one a story reads is not', !names.includes('Harbour Files'));
  ok('the story\'s own material is not', !names.includes(db.getLorebook(material).name), names.join(' | '));
  ok('the knowledge somebody wrote is not', !names.some((n) => /Patrick Moretti/.test(n) && /Knowledge/i.test(n)),
    names.join(' | '));
  if (world) ok('a source inside a world is not', !names.includes('World material'));
  ok('material that arrived inside a card IS offered — nothing is standing on it',
    names.includes('Lore that came in with Patrick'));
}

// ------------------------------------------------------------------ deleting

section('nothing is written by looking');
const FINGERPRINT = () => createHash('sha256').update(JSON.stringify([
  q('SELECT * FROM characters ORDER BY id'), q('SELECT * FROM lorebooks ORDER BY id'),
  q('SELECT id,lorebook_id,title FROM lore_entries ORDER BY id'), q('SELECT * FROM stories ORDER BY id'),
  q('SELECT * FROM story_lorebooks ORDER BY story_id,lorebook_id'), q('SELECT * FROM story_characters ORDER BY story_id,character_id'),
  q('SELECT * FROM lore_entities ORDER BY id'), q('SELECT * FROM entry_semantics ORDER BY entry_id'),
  q('SELECT * FROM source_entities ORDER BY lorebook_id,entity_id'), q('SELECT * FROM import_resources ORDER BY import_id,resource_id'),
  q('SELECT * FROM personas ORDER BY id'), q('SELECT * FROM frameworks ORDER BY id'), q('SELECT * FROM scenarios ORDER BY id'),
])).digest('hex');
{
  const before = FINGERPRINT();
  analyzeLibraryDependencies(db, null);
  unusedResources(db, 'source');
  findExactDuplicates(db, 'source');
  findExactDuplicates(db, 'character');
  findPossibleVersions(db);
  previewLibraryDelete(db, [{ kind: 'source', id: orphan }, { kind: 'source', id: shared }]);
  ok('scanning, comparing and previewing write nothing at all', FINGERPRINT() === before);
}

section('a source a story reads is refused');
{
  const pv = previewLibraryDelete(db, [{ kind: 'source', id: shared }]);
  ok('it comes back blocked', pv.counts.blocked === 1 && pv.counts.safe === 0);
  ok('with a reason anybody could read', /Used by The Saint/.test(pv.blocked[0].reasons.join('; ')), pv.blocked[0].reasons.join('; '));
  const e = threw(() => applyLibraryDelete(db, [{ kind: 'source', id: shared }], pv.token, { safeOnly: false }));
  ok('and refusing is the whole answer', e instanceof LibraryDeleteError && /still in use/.test(e.message), e?.message);
  ok('the source is still there', !!db.getLorebook(shared));
  const e2 = threw(() => applyLibraryDelete(db, [{ kind: 'source', id: shared }], pv.token, { safeOnly: true }));
  ok('and skipping everything is not a delete either', e2 instanceof LibraryDeleteError && /can be deleted/.test(e2.message), e2?.message);
}

section('deleting a card leaves what arrived with it');
{
  const beforeEntities = q('SELECT id FROM lore_entities').length;
  const inCast = previewLibraryDelete(db, [{ kind: 'character', id: patrickCard }]);
  ok('while a story is using them, the card is refused', inCast.counts.blocked === 1,
    inCast.blocked.map((b) => b.reasons.join('; ')).join(' | '));
  // Taken out of the story first, the way P9 prefers: remove, then delete.
  db.raw.prepare('DELETE FROM story_characters WHERE character_id=?').run(patrickCard);
  const pv2 = previewLibraryDelete(db, [{ kind: 'character', id: patrickCard }]);
  ok('once no story uses them, the card is safe', pv2.counts.safe === 1, JSON.stringify(pv2.blocked.map((b) => b.reasons)));
  ok('the preview says the person stays', pv2.remains.some((r) => /Patrick Moretti stays/.test(r)), pv2.remains.join('; '));
  ok('and that what arrived with them is left behind',
    pv2.detaches.some((d) => /came in with them and stays/.test(d)), pv2.detaches.join('; '));
  applyLibraryDelete(db, [{ kind: 'character', id: patrickCard }], pv2.token);
  ok('the card is gone', !db.getCharacter(patrickCard));
  ok('the source that arrived inside it survives', !!db.getLorebook(embedded));
  ok('with its entries', db.listEntries(embedded).length === 1);
  ok('and its provenance cleared, not obeyed', one('SELECT from_character f FROM lorebooks WHERE id=?', embedded).f === null);
  ok('the person survives', q('SELECT id FROM lore_entities').length === beforeEntities
    && !!one('SELECT 1 x FROM lore_entities WHERE id=?', patrick));
  ok('and no story changed', !!one('SELECT 1 x FROM story_lorebooks WHERE story_id=? AND lorebook_id=?', story, shared));
}

section('deleting an unused source');
{
  const strayEntity = createEntity(db, { type: 'place', name: 'A Place Declared Twice', aliases: [] });
  declareInSource(db, { lorebookId: orphan, entityId: strayEntity, localRef: 'place', localName: 'A Place Declared Twice', origin: 'manual', status: 'approved' });
  declareInSource(db, { lorebookId: shared, entityId: strayEntity, localRef: 'place', localName: 'A Place Declared Twice', origin: 'manual', status: 'approved' });
  const strayEntry = db.listEntries(orphan)[0].id;
  setEntrySemantics(db, { entryId: strayEntry, scope: 'world', category: 'background', origin: 'manual', status: 'approved', confidence: 'high' });
  const persona = db.savePersona({ name: 'Somebody', description: 'Built from that entry.' });
  db.raw.prepare('UPDATE personas SET from_entry=? WHERE id=?').run(strayEntry, persona);

  const pv = previewLibraryDelete(db, [{ kind: 'source', id: orphan }]);
  ok('it is safe', pv.counts.safe === 1);
  ok('the preview says the place stays', pv.remains.some((r) => /A Place Declared Twice stays/.test(r)), pv.remains.join('; '));
  applyLibraryDelete(db, [{ kind: 'source', id: orphan }], pv.token);
  ok('the source is gone', !db.getLorebook(orphan));
  ok('its entries are gone', !one('SELECT 1 x FROM lore_entries WHERE id=?', strayEntry));
  ok('its semantics went with them', !one('SELECT 1 x FROM entry_semantics WHERE entry_id=?', strayEntry));
  ok('its declarations went with it', !one('SELECT 1 x FROM source_entities WHERE lorebook_id=?', orphan));
  ok('the place itself survives', !!one('SELECT 1 x FROM lore_entities WHERE id=?', strayEntity));
  ok('and is still declared by the other source', !!one('SELECT 1 x FROM source_entities WHERE lorebook_id=? AND entity_id=?', shared, strayEntity));
  ok('a persona built from a deleted entry is unhooked, not broken',
    !!db.getPersona(persona) && one('SELECT from_entry f FROM personas WHERE id=?', persona).f === null);
  ok('and no story changed', !!one('SELECT 1 x FROM story_lorebooks WHERE story_id=? AND lorebook_id=?', story, shared));
}

section('a preview goes stale the moment the library moves');
{
  const spare = db.createLorebook('Spare', '');
  entry(spare, 'One line', 'Nothing much.');
  const pv = previewLibraryDelete(db, [{ kind: 'source', id: spare }]);
  db.raw.prepare('INSERT OR IGNORE INTO story_lorebooks (story_id,lorebook_id) VALUES (?,?)').run(idle, spare);
  const e = threw(() => applyLibraryDelete(db, [{ kind: 'source', id: spare }], pv.token));
  ok('an attachment made meanwhile refuses the apply', e instanceof LibraryDeleteError && /library changed/i.test(e.message), e?.message);
  ok('and nothing was deleted', !!db.getLorebook(spare));
  db.raw.prepare('DELETE FROM story_lorebooks WHERE story_id=? AND lorebook_id=?').run(idle, spare);
  const pv2 = previewLibraryDelete(db, [{ kind: 'source', id: spare }]);
  applyLibraryDelete(db, [{ kind: 'source', id: spare }], pv2.token);
  ok('a fresh preview applies', !db.getLorebook(spare));
  const e2 = threw(() => applyLibraryDelete(db, [{ kind: 'source', id: spare }], pv2.token));
  ok('and the same apply twice is refused, not repeated', e2 instanceof LibraryDeleteError, e2?.message);
}

section('nothing is half done');
{
  const a = db.createLorebook('Rollback A', ''); entry(a, 'x', 'x');
  const b = db.createLorebook('Rollback B', ''); entry(b, 'y', 'y');
  const pv = previewLibraryDelete(db, [{ kind: 'source', id: a }, { kind: 'source', id: b }]);
  const before = q('SELECT id FROM lorebooks').length;
  // Something impossible half way through: the second delete cannot happen.
  const e = threw(() => db.transaction(() => {
    applyLibraryDelete(db, [{ kind: 'source', id: a }, { kind: 'source', id: b }], pv.token);
    throw new Error('the lights went out');
  }));
  ok('an interrupted delete leaves the library exactly as it was',
    e && q('SELECT id FROM lorebooks').length === before && !!db.getLorebook(a) && !!db.getLorebook(b));
  const pv2 = previewLibraryDelete(db, [{ kind: 'source', id: a }, { kind: 'source', id: b }]);
  applyLibraryDelete(db, [{ kind: 'source', id: a }, { kind: 'source', id: b }], pv2.token);
  ok('and doing it properly takes both', !db.getLorebook(a) && !db.getLorebook(b));
}

// ---------------------------------------------------------------- duplicates

section('the same thing twice');
{
  const copy = (name) => {
    const id = db.createLorebook(name, '');
    entry(id, 'Knife range', 'Inside three metres the knife wins.');
    entry(id, 'The rain', 'It rains for most of autumn.');
    return id;
  };
  const A = copy('Combat Reference');
  const B = copy('Combat Reference (1)');
  const C = copy('Combat Reference (2)');
  db.raw.prepare('INSERT OR IGNORE INTO story_lorebooks (story_id,lorebook_id) VALUES (?,?)').run(idle, C);
  const groups = findExactDuplicates(db, 'source').filter((g) => g.ids.includes(A));
  ok('three identical copies are one group of three', groups.length === 1 && groups[0].ids.length === 3,
    JSON.stringify(groups.map((g) => g.ids.length)));
  ok('a different name does not make a different pack', groups[0].ids.includes(B) && groups[0].ids.includes(C));
  const pv = previewLibraryDelete(db, [{ kind: 'source', id: A }, { kind: 'source', id: B }, { kind: 'source', id: C }]);
  ok('the two nobody uses are safe and the attached one is not',
    pv.counts.safe === 2 && pv.counts.blocked === 1 && pv.blocked[0].id === C, JSON.stringify(pv.counts));
  ok('and the blocked one says which story', /Used by An Idle Telling/.test(pv.blocked[0].reasons.join('; ')), pv.blocked[0].reasons.join('; '));

  // Review history is not content. One copy organised, one not: still copies.
  const organised = db.listEntries(A)[0].id;
  setEntrySemantics(db, { entryId: organised, scope: 'world', category: 'reference', origin: 'manual', status: 'approved', confidence: 'high' });
  ok('organising one copy does not make it a different pack',
    sourceFingerprint(db, A) === sourceFingerprint(db, B));
  ok('and the group is still three', findExactDuplicates(db, 'source').filter((g) => g.ids.includes(A))[0].ids.length === 3);

  // Tuning IS content.
  const D = copy('Combat Reference (3)');
  db.saveEntry(D, { id: db.listEntries(D)[0].id, enabled: false });
  ok('one entry switched off makes it a different pack', sourceFingerprint(db, D) !== sourceFingerprint(db, A));
  ok('so it is not in the copies group', !findExactDuplicates(db, 'source').some((g) => g.ids.includes(D) && g.ids.includes(A)));
}

section('empty is not evidence of anything');
{
  // Two packs with nothing in them match on content because there is no content
  // to differ. That is arithmetic, not a finding: they are unrelated sources
  // with unrelated names, and grouping them would invite keeping the wrong one.
  const e1 = db.createLorebook('Mhsssass', '');
  const e2 = db.createLorebook('Mha', '');
  ok('two empty sources are not called copies of each other',
    !findExactDuplicates(db, 'source').some((g) => g.ids.includes(e1) && g.ids.includes(e2)));
  ok('nor is either grouped with anything else',
    !findExactDuplicates(db, 'source').some((g) => g.ids.includes(e1) || g.ids.includes(e2)));
  ok('but both are still ordinary unused things', !used('source', e1).used && !used('source', e2).used);
  const names = unusedResources(db, 'source').map((r) => r.name);
  ok('and cleanup still offers them', names.includes('Mhsssass') && names.includes('Mha'), names.join(' | '));
  // An empty one and a full one with the same name are still worth comparing.
  ok('emptiness does not hide a real difference either',
    sourceFingerprint(db, e1) !== sourceFingerprint(db, shared));
}

section('being one of several copies is not being surplus');
{
  const copy = (name) => { const id = db.createLorebook(name, ''); entry(id, 'Only line', 'The same words.'); return id; };
  const a = copy('Triplet'); const b = copy('Triplet'); const c = copy('Triplet');
  const status = (id) => { const d = used('source', id); return d ? { used: d.used, protected: d.protected } : null; };
  const groups = findExactDuplicates(db, 'source').filter((g) => g.ids.includes(a));
  let t = redundantCopies(groups, status);
  ok('three copies are one group of three members', t.groups === 1 && t.members === 3, JSON.stringify(t));
  ok('of which two are surplus, not three', t.redundant.length === 2, `${t.redundant.length} surplus`);
  ok('and the keeper is not counted as surplus', t.redundant.length + 1 === t.members);

  // Once a story keeps one, the keeper is decided and every spare is spare.
  db.raw.prepare('INSERT OR IGNORE INTO story_lorebooks (story_id,lorebook_id) VALUES (?,?)').run(idle, c);
  t = redundantCopies(findExactDuplicates(db, 'source').filter((g) => g.ids.includes(a)), status);
  ok('a copy a story reads counts as the keeper', t.redundant.length === 2 && !t.redundant.includes(c), JSON.stringify(t.redundant.length));
  ok('and the used one is reported as such, not as surplus', t.blocked.includes(c));
  ok('the numbers still add up', t.redundant.length + t.blocked.length === t.members);
  // Nothing about this stops somebody deleting all the unused ones on purpose.
  const pv = previewLibraryDelete(db, [a, b].map((id) => ({ kind: 'source', id })));
  ok('selecting every spare on purpose is still allowed', pv.counts.safe === 2, JSON.stringify(pv.counts));
  db.raw.prepare('DELETE FROM story_lorebooks WHERE story_id=? AND lorebook_id=?').run(idle, c);
}

section('two cards with one name are two people\'s worth of work');
{
  const one1 = db.writeCharacter({ name: 'Elena', description: 'The lawyer.' });
  const two = db.writeCharacter({ name: 'Elena', description: 'The same name, a different woman.' });
  ok('the same name is not a duplicate', !findExactDuplicates(db, 'character').some((g) => g.ids.includes(one1) && g.ids.includes(two)));
  const three = db.writeCharacter({ name: 'Elena', description: 'The lawyer.' });
  ok('the same card written twice is', findExactDuplicates(db, 'character').some((g) => g.ids.includes(one1) && g.ids.includes(three)));
  // Same person, two cards: still two cards.
  const elena = createEntity(db, { type: 'person', name: 'Elena', aliases: [] });
  bindCharacterEntity(db, one1, elena);
  bindCharacterEntity(db, two, elena);
  ok('two cards for one person are still two cards',
    !findExactDuplicates(db, 'character').some((g) => g.ids.includes(one1) && g.ids.includes(two)));
}

// ------------------------------------------------------------------ versions

section('the same thing later is not the same thing');
{
  const v1 = db.createLorebook('Patrick Lore', '');
  for (let i = 0; i < 30; i++) entry(v1, `Shared ${i}`, `Line ${i}.`);
  entry(v1, 'Only in v1', 'Cut later.');
  entry(v1, 'Rewritten', 'How it read at first.');
  const v2 = db.createLorebook('Patrick Lore', '');
  for (let i = 0; i < 30; i++) entry(v2, `Shared ${i}`, `Line ${i}.`);
  entry(v2, 'Rewritten', 'How it reads now.');
  for (let i = 0; i < 3; i++) entry(v2, `Added ${i}`, `New line ${i}.`);

  ok('they are not called copies', sourceFingerprint(db, v1) !== sourceFingerprint(db, v2)
    && !findExactDuplicates(db, 'source').some((g) => g.ids.includes(v1) && g.ids.includes(v2)));
  const pairs = findPossibleVersions(db).filter((g) => g.ids.includes(v1) && g.ids.includes(v2));
  ok('they are offered as possible versions', pairs.length === 1, JSON.stringify(pairs.map((p) => p.why)));
  const c = compareSources(db, v1, v2);
  ok('the comparison counts what is the same', c.same === 30, `same ${c.same}`);
  ok('what was added', c.added === 3, `added ${c.added}`);
  ok('what was removed', c.removed === 1, `removed ${c.removed}`);
  ok('and what changed, in words', c.changed === 1 && c.details.changed[0].how.includes('the words'),
    JSON.stringify(c.details.changed));
  ok('nothing is named a winner', !('winner' in c) && !('recommended' in c));
  ok('and nothing was merged or deleted by comparing', !!db.getLorebook(v1) && !!db.getLorebook(v2));
}

// ------------------------------------------------------------ import lineage

section('what an import produced, after some of it is deleted');
{
  const imp = db.recordImport({ hash: 'file-one', filename: 'pack.json', source: 'file', format: 'x', spec: 'v2', detectedRole: 'lorebook', chosenRole: 'lorebook', confidence: 'high', analysis: {}, original: '{}' });
  const other = db.recordImport({ hash: 'file-two', filename: 'another.json', source: 'file', format: 'x', spec: 'v2', detectedRole: 'lorebook', chosenRole: 'lorebook', confidence: 'high', analysis: {}, original: '{}' });
  const p1 = db.createLorebook('From file one, part A', ''); entry(p1, 'a', 'a');
  const p2 = db.createLorebook('From file one, part B', ''); entry(p2, 'b', 'b');
  const p3 = db.createLorebook('From file two', ''); entry(p3, 'c', 'c');
  db.settleImport(imp, 'lorebook', [{ kind: 'lorebook', id: p1, part: 'primary' }, { kind: 'lorebook', id: p2, part: 'piece' }]);
  db.settleImport(other, 'lorebook', [{ kind: 'lorebook', id: p3, part: 'primary' }]);

  ok('the file is recognised while its resources live', !!db.importByHash('file-one'));
  const pv = previewLibraryDelete(db, [{ kind: 'source', id: p1 }]);
  applyLibraryDelete(db, [{ kind: 'source', id: p1 }], pv.token);
  ok('deleting one of them leaves the other mapped',
    q('SELECT resource_id FROM import_resources WHERE import_id=?', imp).map((r) => r.resource_id).join() === p2, p2);
  ok('and no dead id is left behind', !one('SELECT 1 x FROM import_resources WHERE resource_id=?', p1));
  ok('the file is still recognised', !!db.importByHash('file-one'));
  ok('the other file is untouched', q('SELECT resource_id FROM import_resources WHERE import_id=?', other).length === 1
    && !!db.importByHash('file-two'));

  const pv2 = previewLibraryDelete(db, [{ kind: 'source', id: p2 }]);
  applyLibraryDelete(db, [{ kind: 'source', id: p2 }], pv2.token);
  ok('once everything it made is gone, the same file can be imported again',
    db.importByHash('file-one') === null);
  ok('but the history of having imported it is kept', !!one('SELECT 1 x FROM imports WHERE id=?', imp));
  ok('and the other file is still recognised', !!db.importByHash('file-two'));
  ok('no stale mapping survived the cleanup', q('SELECT resource_id FROM import_resources WHERE import_id=?', imp).length === 0);
}

section('the old one-tap Delete buttons obey the same rules');
{
  // Every Delete in the app now goes through one authority. These are the calls
  // those buttons make, so a source a story reads cannot vanish out of it by a
  // route that predates any of this.
  const book = db.createLorebook('Read by a story', ''); entry(book, 'A line', 'Words.');
  db.raw.prepare('INSERT OR IGNORE INTO story_lorebooks (story_id,lorebook_id) VALUES (?,?)').run(idle, book);
  const e = threw(() => deleteOneResource(db, 'source', book));
  ok('deleting one used source is refused', e instanceof LibraryDeleteError, e?.message);
  ok('in words, naming the story', /Used by An Idle Telling/i.test(e?.message || ''), e?.message);
  ok('and it is still attached to the story', !!one('SELECT 1 x FROM story_lorebooks WHERE lorebook_id=?', book));
  ok('and still in the library', !!db.getLorebook(book));

  const card = db.writeCharacter({ name: 'Cast somewhere', description: '' });
  db.raw.prepare("INSERT OR IGNORE INTO story_characters (story_id,character_id,role) VALUES (?,?,'main')").run(idle, card);
  const e2 = threw(() => deleteOneResource(db, 'character', card));
  ok('deleting one cast character is refused', e2 instanceof LibraryDeleteError && /In the cast of/i.test(e2.message), e2?.message);

  // The case that used to throw a raw foreign-key error out of the database.
  const bound = db.writeCharacter({ name: 'Bound as a card', description: '' });
  const who = createEntity(db, { type: 'person', name: 'Somebody Bound', aliases: [] });
  db.raw.prepare('INSERT INTO story_entity_cards (story_id, entity_id, character_id, created_at) VALUES (?,?,?,?)')
    .run(idle, who, bound, Date.now());
  const e3 = threw(() => deleteOneResource(db, 'character', bound));
  ok('a card a story chose is refused in words, not by a database error',
    e3 instanceof LibraryDeleteError && !/FOREIGN KEY|constraint/i.test(e3.message), e3?.message);
  ok('and names who it stands for', /Chosen as the card for Somebody Bound/i.test(e3?.message || ''), e3?.message);

  const scene = (() => {
    const id = `sc-${Date.now()}`;
    db.raw.prepare('INSERT INTO scenarios (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(id, 'A situation', Date.now(), Date.now());
    return id;
  })();
  if (scene) {
    db.raw.prepare('UPDATE stories SET scenario_id=? WHERE id=?').run(scene, idle);
    const e4 = threw(() => deleteOneResource(db, 'scenario', scene));
    ok('a scenario a story started from is refused', e4 instanceof LibraryDeleteError, e4?.message);
    ok('and the story is untouched', one('SELECT scenario_id s FROM stories WHERE id=?', idle).s === scene);
    db.raw.prepare('UPDATE stories SET scenario_id=NULL WHERE id=?').run(idle);
  }
  if (world) {
    db.raw.prepare('UPDATE stories SET framework_id=? WHERE id=?').run(world, idle);
    const e5 = threw(() => deleteOneResource(db, 'world', world));
    ok('a world a story uses is refused', e5 instanceof LibraryDeleteError, e5?.message);
    ok('and that story is untouched', one('SELECT framework_id f FROM stories WHERE id=?', idle).f === world);
    db.raw.prepare('UPDATE stories SET framework_id=NULL WHERE id=?').run(idle);
  }
  // Knowledge somebody wrote stays protected on this path too.
  const e6 = threw(() => deleteOneResource(db, 'source', knowledge.lorebookId));
  ok('reusable knowledge is protected from one-tap deletion as well',
    e6 instanceof LibraryDeleteError && /Knowledge you wrote/i.test(e6.message), e6?.message);
  ok('and from the story-material container too',
    threw(() => deleteOneResource(db, 'source', material)) instanceof LibraryDeleteError);

  // And the safe case still works in one call.
  const spare = db.createLorebook('Nobody wants this', ''); entry(spare, 'x', 'x');
  const r = deleteOneResource(db, 'source', spare);
  ok('something nothing stands on still goes in one tap', !db.getLorebook(spare) && r.deleted.length === 1);
}

section('deleting who you play never quietly changes a story');
{
  // The database would empty the slot in every story using it. That is a change
  // to a story nobody asked for, so nothing is allowed to reach that cascade.
  const reiko = db.savePersona({ name: 'Reiko', description: 'You.' });
  const oneStory = db.createStory({ title: 'The Saint', personaId: reiko });
  ok('a persona a story is played as is in use',
    used('persona', reiko).used && /You play as Reiko in The Saint/.test(used('persona', reiko).reasons.map((r) => r.text).join('; ')),
    used('persona', reiko).reasons.map((r) => r.text).join('; '));
  const e = threw(() => deleteOneResource(db, 'persona', reiko));
  ok('deleting it is refused', e instanceof LibraryDeleteError, e?.message);
  ok('and the story still plays as them', one('SELECT persona_id p FROM stories WHERE id=?', oneStory).p === reiko);

  const second = db.createStory({ title: 'A Saint-Like Story', personaId: reiko });
  const e2 = threw(() => deleteOneResource(db, 'persona', reiko));
  ok('with several stories, all of them are named',
    /The Saint/.test(e2?.message || '') && /A Saint-Like Story/.test(e2?.message || ''), e2?.message);
  ok('and none of them changed',
    one('SELECT persona_id p FROM stories WHERE id=?', oneStory).p === reiko
    && one('SELECT persona_id p FROM stories WHERE id=?', second).p === reiko);
  ok('the refusal says nothing about the database',
    !/FOREIGN KEY|constraint|persona_id|row id|SET NULL/i.test(e2?.message || ''), e2?.message);

  // Who they are, and what is written about that person, are not theirs to take.
  const reikoEntity = createEntity(db, { type: 'person', name: 'Reiko Ryuusui', aliases: [] });
  db.raw.prepare('UPDATE personas SET entity_id=? WHERE id=?').run(reikoEntity, reiko);
  const knowledgeOfReiko = createEntityKnowledge(db, {
    entityId: reikoEntity, title: 'Advanced techniques', content: 'She reads a wake like a page.',
    category: 'skill', activation: { mode: 'always', keys: [] },
  });
  // Taken out of both stories first, the way the refusal asks.
  db.raw.prepare('UPDATE stories SET persona_id=NULL WHERE persona_id=?').run(reiko);
  ok('once no story plays as them, it is unused', !used('persona', reiko).used);
  const r = deleteOneResource(db, 'persona', reiko);
  ok('and the persona goes', !db.getPersona(reiko) && r.deleted.length === 1);
  ok('the person they were survives', !!one('SELECT 1 x FROM lore_entities WHERE id=?', reikoEntity));
  ok('the knowledge written about that person survives',
    !!db.getLorebook(knowledgeOfReiko.lorebookId) && db.listEntries(knowledgeOfReiko.lorebookId).length === 1);
  ok('and both stories are still there, untouched but for the slot they emptied themselves',
    !!db.getStory(oneStory) && !!db.getStory(second));
}

section('a persona never points at an entry that is gone');
{
  const book = db.createLorebook('Persona source', '');
  const e = entry(book, 'Reiko', 'Watchful.');
  const persona = db.savePersona({ name: 'Reiko', description: 'You.' });
  db.raw.prepare('UPDATE personas SET from_entry=? WHERE id=?').run(e, persona);
  db.deleteEntry(e);
  ok('deleting the entry unhooks the persona instead of leaving it dangling',
    !!db.getPersona(persona) && one('SELECT from_entry f FROM personas WHERE id=?', persona).f === null);
}

db.close();
console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exit(fail ? 1 : 0);
