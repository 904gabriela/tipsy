// The cast table, finished: one row per person per story, and a migration that
// is honest or does not run.
//
//   node scripts/check-npc-migration.js
//
// Throwaway databases. A fresh database gets the final table outright; to test
// the migration, the table is put back into its old shape by hand and filled
// with the kinds of rows a real library has: some that resolve, some that do
// not, two that disagree, and one that is the person you play.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { open } from '../src/db/index.js';
import { npcTableShape, npcMigrationReadiness, applyNpcMigration, NpcMigrationError } from '../src/semantics/npc-migration.js';
import { createEntity, declareInSource, setEntrySemantics, setRelation, setSourceRole, bindPersonaEntity, resolveEntryPerson } from '../src/semantics/store.js';
import { applyToStory, sourceRemovalPreview, removeSource } from '../src/import/compose-apply.js';
import { analyzeLibraryDependencies, dependencyKey } from '../src/library/dependencies.js';
import { deleteOneResource } from '../src/library/delete.js';
import { exportStory } from '../src/package/export.js';
import { importPackage } from '../src/package/import.js';

let pass = 0; let fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? `  — ${d}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? `  — ${d}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);
const threw = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const fresh = () => open(join(mkdtempSync(join(tmpdir(), 'tipsy-p9b-')), 'p9b.db'));

const entry = (db, bookId, title, content) =>
  db.saveEntry(bookId, { ord: 100, enabled: true, constant: false, probability: 100, keys: [title], title, content, kind: 'character' });
const approveDefines = (db, entryId, entityId) =>
  setEntrySemantics(db, { entryId, scope: 'entity', category: 'profile', definesEntityId: entityId, origin: 'manual', status: 'approved', confidence: 'high' });

/** Put a fresh database's cast table back into the shape it had before P9b. */
function backToTransitional(db) {
  db.raw.exec('PRAGMA foreign_keys=OFF');
  db.raw.exec('DROP TABLE story_npcs');
  db.raw.exec(`CREATE TABLE story_npcs (
    story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL REFERENCES lore_entries(id) ON DELETE CASCADE,
    role     TEXT NOT NULL DEFAULT 'background',
    ord      INTEGER NOT NULL DEFAULT 0,
    entity_id TEXT REFERENCES lore_entities(id) ON DELETE RESTRICT,
    PRIMARY KEY (story_id, entry_id))`);
  db.raw.exec('CREATE INDEX idx_npc_story ON story_npcs(story_id, role)');
  db.raw.exec('PRAGMA foreign_keys=ON');
  db.npcShape = 'transitional';
}
const legacyRow = (db, storyId, entryId, role, ord, entityId = null) =>
  db.raw.prepare('INSERT INTO story_npcs (story_id, entry_id, role, ord, entity_id) VALUES (?,?,?,?,?)').run(storyId, entryId, role, ord, entityId);

// ------------------------------------------------------------- final schema

section('the final table');
{
  const db = fresh();
  ok('a new database gets the final shape outright', npcTableShape(db) === 'canonical' && db.npcShape === 'canonical');
  const cols = Object.fromEntries(db.raw.prepare('PRAGMA table_info(story_npcs)').all().map((c) => [c.name, c]));
  ok('entity_id is NOT NULL and part of the key', cols.entity_id.notnull === 1 && cols.entity_id.pk > 0);
  ok('story_id is the other half of the key', cols.story_id.notnull === 1 && cols.story_id.pk > 0);
  ok('profile_entry_id is optional', cols.profile_entry_id && cols.profile_entry_id.notnull === 0);
  ok('role and ord kept their defaults', cols.role.dflt_value === "'background'" && cols.ord.dflt_value === '0');
  ok('no column keyed on an entry survives as identity', !cols.entry_id);
  const fks = Object.fromEntries(db.raw.prepare('PRAGMA foreign_key_list(story_npcs)').all().map((f) => [f.from, f]));
  ok('a story takes its cast with it', fks.story_id.table === 'stories' && fks.story_id.on_delete === 'CASCADE');
  ok('a person cannot be deleted from under a cast', fks.entity_id.table === 'lore_entities' && fks.entity_id.on_delete === 'RESTRICT');
  ok('an introducing entry may go; the person stays', fks.profile_entry_id.table === 'lore_entries' && fks.profile_entry_id.on_delete === 'SET NULL');
  ok('the cast index is there', db.raw.prepare("SELECT 1 x FROM sqlite_master WHERE type='index' AND name='idx_npc_story'").get());
  ok('foreign keys check clean', db.raw.prepare('PRAGMA foreign_key_check').all().length === 0);
  ok('a second open changes nothing', (() => { const p = db.raw.location(); db.close(); const again = open(p); const r = npcTableShape(again) === 'canonical' && !again.npcMigration; again.close(); return r; })());
}

// -------------------------------------------------------------- readiness

section('readiness, row by row');
{
  const db = fresh();
  const book = db.createLorebook('Harbour', '');
  const carlo = createEntity(db, { type: 'person', name: 'Carlo Vancetti', aliases: [] });
  const marco = createEntity(db, { type: 'person', name: 'Marco', aliases: [] });
  const lotus = createEntity(db, { type: 'place', name: 'The Black Lotus', aliases: [] });
  const reiko = createEntity(db, { type: 'person', name: 'Reiko', aliases: [] });
  for (const [id, ref] of [[carlo, 'carlo'], [marco, 'marco'], [lotus, 'lotus'], [reiko, 'reiko']]) {
    declareInSource(db, { lorebookId: book, entityId: id, localRef: ref, localName: ref, origin: 'manual', status: 'approved' });
  }
  const eDefines = entry(db, book, 'Carlo Vancetti', 'Runs the docks.'); approveDefines(db, eDefines, carlo);
  const eSubject = entry(db, book, 'Deepest Fear', 'That nobody notices.');
  setEntrySemantics(db, { entryId: eSubject, scope: 'entity', category: 'psychology', origin: 'manual', status: 'approved', confidence: 'high' });
  setRelation(db, { entryId: eSubject, entityId: marco, relation: 'subject', origin: 'manual', status: 'approved' });
  const eProposed = entry(db, book, 'A Guess', 'Maybe Marco.');
  setEntrySemantics(db, { entryId: eProposed, scope: 'entity', category: 'profile', definesEntityId: marco, origin: 'inferred', status: 'proposed', confidence: 'low' });
  const eNothing = entry(db, book, 'Nico', 'Nico drives.');
  db.raw.prepare("INSERT INTO legacy_entry_links (source, entry_id, target_kind, target_id, entry_title, entry_book_id, entry_origin, target_name, derived_origin, recorded_at) VALUES ('entry_character_links',?,'character','x','Nico',?,NULL,'Nico','composer-inferred',0)").run(eNothing, book);
  const ePlace = entry(db, book, 'The Black Lotus', 'A club.'); approveDefines(db, ePlace, lotus);
  const eStale = entry(db, book, 'Marco', 'Marco counts the doors.'); approveDefines(db, eStale, marco);
  db.saveEntry(book, { id: eStale, content: 'Marco counts the doors, and the windows.' });
  const eReiko = entry(db, book, 'Reiko', 'Watchful.'); approveDefines(db, eReiko, reiko);

  ok('defines resolves', resolveEntryPerson(db, eDefines)?.entityId === carlo && resolveEntryPerson(db, eDefines).how === 'defines');
  ok('exactly one approved subject resolves', resolveEntryPerson(db, eSubject)?.entityId === marco && resolveEntryPerson(db, eSubject).how === 'subject');
  // The store allows one approved subject per entry, so "several subjects" is
  // not a state a database can be in; an entry with none is the only other case.
  const eNoSubject = entry(db, book, 'The Weather', 'It rains.');
  setEntrySemantics(db, { entryId: eNoSubject, scope: 'world', category: 'background', origin: 'manual', status: 'approved', confidence: 'high' });
  ok('organised, but not as anybody, does not', resolveEntryPerson(db, eNoSubject) === null);
  ok('a proposal does not', resolveEntryPerson(db, eProposed) === null);
  ok('a legacy link does not', resolveEntryPerson(db, eNothing) === null);
  ok('a place is not a person', resolveEntryPerson(db, ePlace) === null);
  ok('an approved reading whose words moved still resolves, and says so', resolveEntryPerson(db, eStale)?.entityId === marco && resolveEntryPerson(db, eStale).stale === true);

  const persona = db.savePersona({ name: 'Reiko', description: 'You.' });
  bindPersonaEntity(db, persona, reiko);
  const story = db.createStory({ title: 'The Quay', lorebookIds: [book], personaId: persona });
  backToTransitional(db);
  legacyRow(db, story, eDefines, 'supporting', 0);
  legacyRow(db, story, eSubject, 'background', 1);
  legacyRow(db, story, eProposed, 'main', 2);
  legacyRow(db, story, eNothing, 'background', 3);
  legacyRow(db, story, eReiko, 'main', 4);
  legacyRow(db, story, eStale, 'background', 5, marco);   // already backed

  const before = createHash('sha256').update(JSON.stringify(db.raw.prepare('SELECT * FROM story_npcs ORDER BY rowid').all())).digest('hex');
  const r = npcMigrationReadiness(db);
  ok('readiness sees the old shape', r.shape === 'transitional');
  const st = (e) => r.rows.find((x) => x.entryId === e)?.status;
  ok('an already-backed row is ready', st(eStale) === 'backed');
  ok('defines resolves to ready', st(eDefines) === 'resolvable');
  ok('a single subject resolves to ready', st(eSubject) === 'resolvable');
  ok('a proposal is unresolved', st(eProposed) === 'unresolved');
  ok('a legacy link is unresolved', st(eNothing) === 'unresolved');
  ok('the person you play is flagged, not cast', st(eReiko) === 'persona' && r.collisions.length === 1);
  ok('and the count is honest', r.ready === 3 && r.needsDecision === 3, `${r.ready} ready, ${r.needsDecision} need a decision`);
  ok('so it cannot apply', !r.canApply);
  ok('the reasons are in words', r.unresolved.every((x) => /organised|proposed/.test(x.why)) && !/entity_id|NULL|foreign/i.test(r.rows.map((x) => x.why).join(' ')));
  ok('readiness wrote nothing', createHash('sha256').update(JSON.stringify(db.raw.prepare('SELECT * FROM story_npcs ORDER BY rowid').all())).digest('hex') === before);
  ok('and says the same thing twice', JSON.stringify(npcMigrationReadiness(db)) === JSON.stringify(r));
  const e = threw(() => applyNpcMigration(db));
  ok('apply refuses while anything needs a decision', e instanceof NpcMigrationError && /need a decision/.test(e.message), e?.message);
  ok('and touched nothing', npcTableShape(db) === 'transitional' && db.raw.prepare('SELECT COUNT(*) n FROM story_npcs').get().n === 6);
  db.close();
}

// ------------------------------------------------------------- duplicates

section('several rows, one person');
{
  const db = fresh();
  const book = db.createLorebook('Harbour', '');
  const salvatore = createEntity(db, { type: 'person', name: 'Salvatore', aliases: [] });
  const marco = createEntity(db, { type: 'person', name: 'Marco', aliases: [] });
  declareInSource(db, { lorebookId: book, entityId: salvatore, localRef: 's', localName: 'Salvatore', origin: 'manual', status: 'approved' });
  declareInSource(db, { lorebookId: book, entityId: marco, localRef: 'm', localName: 'Marco', origin: 'manual', status: 'approved' });
  const s1 = entry(db, book, 'Salvatore', 'Waits.'); approveDefines(db, s1, salvatore);
  const s2 = entry(db, book, 'Salvatore — later', 'Still waits.'); approveDefines(db, s2, salvatore);
  const s3 = entry(db, book, 'Salvatore — the end', 'Stops waiting.'); approveDefines(db, s3, salvatore);
  const m1 = entry(db, book, 'Marco', 'Counts.'); approveDefines(db, m1, marco);
  const m2 = entry(db, book, 'Marco — later', 'Still counts.'); approveDefines(db, m2, marco);
  const story = db.createStory({ title: 'Agreeing', lorebookIds: [book] });
  const other = db.createStory({ title: 'Disagreeing', lorebookIds: [book] });
  backToTransitional(db);
  legacyRow(db, story, s1, 'supporting', 0);
  legacyRow(db, story, s2, 'supporting', 1);
  legacyRow(db, story, s3, 'supporting', 2);
  legacyRow(db, other, m1, 'supporting', 0);
  legacyRow(db, other, m2, 'background', 1);

  let r = npcMigrationReadiness(db);
  const agree = r.groups.find((g) => g.entityId === salvatore);
  const disagree = r.groups.find((g) => g.entityId === marco);
  ok('three agreeing rows are one group that will merge', agree && agree.rows.length === 3 && !agree.conflict);
  ok('two disagreeing rows are a conflict', disagree && disagree.conflict && disagree.roles.length === 2, JSON.stringify(disagree?.roles));
  ok('a conflict blocks the rebuild', !r.canApply && r.conflicts.length === 1);
  ok('and nobody here picks a winner', threw(() => applyNpcMigration(db)) instanceof NpcMigrationError
    && db.raw.prepare('SELECT COUNT(*) n FROM story_npcs WHERE story_id=?').get(other).n === 2);

  // Somebody decides: the later Marco was the point.
  db.raw.prepare('DELETE FROM story_npcs WHERE story_id=? AND entry_id=?').run(other, m1);
  r = npcMigrationReadiness(db);
  ok('once they agree, it is ready', r.canApply, `${r.needsDecision} need a decision`);
  const done = applyNpcMigration(db);
  ok('the rebuild ran', done.migrated === 2 && done.merged === 2, JSON.stringify(done));
  ok('exactly one Salvatore in that story', db.raw.prepare('SELECT COUNT(*) n FROM story_npcs WHERE story_id=? AND entity_id=?').get(story, salvatore).n === 1);
  const sal = db.raw.prepare('SELECT * FROM story_npcs WHERE story_id=? AND entity_id=?').get(story, salvatore);
  ok('with the part they all agreed on', sal.role === 'supporting');
  ok('and no single entry claimed as the one that introduced them', sal.profile_entry_id === null);
  ok('the entries themselves are untouched', db.listEntries(book).length === 5);
  ok('Marco kept his one remaining entry as provenance', db.raw.prepare('SELECT profile_entry_id p FROM story_npcs WHERE story_id=?').get(other).p === m2);
  ok('the table is final', npcTableShape(db) === 'canonical' && db.raw.prepare('PRAGMA foreign_key_check').all().length === 0);
  ok('applying again is a no-op', applyNpcMigration(db).alreadyMigrated === true);
  db.close();
}

// -------------------------------------------------------------- transaction

section('all or nothing');
{
  const db = fresh();
  const book = db.createLorebook('Harbour', '');
  const carlo = createEntity(db, { type: 'person', name: 'Carlo', aliases: [] });
  declareInSource(db, { lorebookId: book, entityId: carlo, localRef: 'c', localName: 'Carlo', origin: 'manual', status: 'approved' });
  const e1 = entry(db, book, 'Carlo', 'Runs the docks.'); approveDefines(db, e1, carlo);
  const story = db.createStory({ title: 'Interrupted', lorebookIds: [book] });
  backToTransitional(db);
  legacyRow(db, story, e1, 'supporting', 0);
  const before = JSON.stringify(db.raw.prepare('SELECT * FROM story_npcs').all());
  const e = threw(() => applyNpcMigration(db, { afterCopy: () => { throw new Error('the lights went out'); } }));
  ok('a failure after the copy rolls the whole thing back', !!e && /lights/.test(e.message));
  ok('the old table is exactly as it was', npcTableShape(db) === 'transitional' && JSON.stringify(db.raw.prepare('SELECT * FROM story_npcs').all()) === before);
  ok('no half-built table is left behind', !db.raw.prepare("SELECT 1 x FROM sqlite_master WHERE name='story_npcs_rebuilt'").get());
  ok('foreign keys are back on', db.raw.prepare('PRAGMA foreign_keys').get().foreign_keys === 1);
  ok('and it can still be done properly', applyNpcMigration(db).migrated === 1 && npcTableShape(db) === 'canonical');
  db.close();
}

// ----------------------------------------------------------------- runtime

section('on the final table, day to day');
{
  const db = fresh();
  const book = db.createLorebook('Harbour', '');
  const other = db.createLorebook('Second Harbour', '');
  const carlo = createEntity(db, { type: 'person', name: 'Carlo Vancetti', aliases: [] });
  const lotus = createEntity(db, { type: 'place', name: 'The Black Lotus', aliases: [] });
  declareInSource(db, { lorebookId: book, entityId: carlo, localRef: 'carlo', localName: 'Carlo Vancetti', origin: 'manual', status: 'approved' });
  declareInSource(db, { lorebookId: other, entityId: carlo, localRef: 'carlo', localName: 'Carlo Vancetti', origin: 'manual', status: 'approved' });
  declareInSource(db, { lorebookId: book, entityId: lotus, localRef: 'lotus', localName: 'The Black Lotus', origin: 'manual', status: 'approved' });
  const eCarlo = entry(db, book, 'Carlo Vancetti', 'Runs the docks.'); approveDefines(db, eCarlo, carlo);
  const eCarlo2 = entry(db, other, 'Carlo at the club', 'Drinks alone.'); approveDefines(db, eCarlo2, carlo);
  const eLotus = entry(db, book, 'The Black Lotus', 'A club.'); approveDefines(db, eLotus, lotus);
  const eRaw = entry(db, book, 'Nico', 'Nico drives.');
  const story = db.createStory({ title: 'The Quay', lorebookIds: [book, other] });

  // Composition writes identity.
  applyToStory(db, story, { casting: [{ entryId: eCarlo, entryIds: [eCarlo], role: 'supporting' }] });
  let rows = db.raw.prepare('SELECT * FROM story_npcs WHERE story_id=?').all(story);
  ok('Composition writes the person, with the entry as provenance', rows.length === 1 && rows[0].entity_id === carlo && rows[0].profile_entry_id === eCarlo && rows[0].role === 'supporting');
  ok('a place cannot be cast', /not a person/.test(threw(() => applyToStory(db, story, { casting: [{ entryId: eLotus, role: 'background' }] }))?.message || ''));
  ok('an unorganised person cannot be cast, and is told why', /does not know who/.test(threw(() => applyToStory(db, story, { casting: [{ entryId: eRaw, role: 'background' }] }))?.message || ''));
  ok('nothing was written by either refusal', db.raw.prepare('SELECT COUNT(*) n FROM story_npcs WHERE story_id=?').get(story).n === 1);
  // Changing the part through another entry updates the person, never adds a row.
  applyToStory(db, story, { casting: [{ entryId: eCarlo2, entryIds: [eCarlo2], role: 'main' }] });
  rows = db.raw.prepare('SELECT * FROM story_npcs WHERE story_id=?').all(story);
  ok('another entry about the same person updates them, not a second row', rows.length === 1 && rows[0].role === 'main');
  ok('and the first introduction is kept', rows[0].profile_entry_id === eCarlo);

  // The person outlives the entry that introduced them.
  db.deleteEntry(eCarlo);
  rows = db.raw.prepare('SELECT * FROM story_npcs WHERE story_id=?').all(story);
  ok('deleting the introducing entry leaves the person in the cast', rows.length === 1 && rows[0].entity_id === carlo && rows[0].role === 'main');
  ok('with provenance cleared', rows[0].profile_entry_id === null);
  ok('and the cast still names them by who they are', db.storyNpcs(story)[0].name === 'Carlo Vancetti');

  // Source removal: a person stays while another source still carries them.
  const pv = sourceRemovalPreview(db, story, book, () => ({ casting: [], sections: [] }));
  ok('removing one of two sources says nobody leaves the cast', pv.castLeaving.length === 0, JSON.stringify(pv.castLeaving));
  removeSource(db, story, book);
  ok('and nobody did', db.raw.prepare('SELECT COUNT(*) n FROM story_npcs WHERE story_id=?').get(story).n === 1);
  const pv2 = sourceRemovalPreview(db, story, other, () => ({ casting: [], sections: [] }));
  ok('removing the last one says Carlo leaves', pv2.castLeaving.some((c) => c.name === 'Carlo Vancetti'));
  removeSource(db, story, other);
  ok('and that is the explicit decision that removes him', db.raw.prepare('SELECT COUNT(*) n FROM story_npcs WHERE story_id=?').get(story).n === 0);
  ok('the person survives all of it', !!db.raw.prepare('SELECT 1 x FROM lore_entities WHERE id=?').get(carlo));

  // Entity deletion is refused under a cast.
  db.raw.prepare('INSERT OR IGNORE INTO story_lorebooks (story_id,lorebook_id) VALUES (?,?)').run(story, other);
  db.setStoryNpc(story, { entityId: carlo, role: 'background', profileEntryId: eCarlo2 });
  ok('a person cannot be deleted from under a cast', threw(() => db.raw.prepare('DELETE FROM lore_entities WHERE id=?').run(carlo)) !== null);

  // Library cleanup still knows a cast stands on a source.
  const dep = analyzeLibraryDependencies(db, [{ kind: 'source', id: other }]).get(dependencyKey('source', other));
  ok('cleanup sees the source a cast member stands on', dep.used && dep.reasons.some((r) => /Somebody in The Quay/.test(r.text)), dep.reasons.map((r) => r.text).join('; '));
  // And an unused card for the same person does not take the NPC.
  const card = db.writeCharacter({ name: 'Carlo Vancetti', description: 'A card.' });
  db.raw.prepare('UPDATE characters SET entity_id=? WHERE id=?').run(carlo, card);
  deleteOneResource(db, 'character', card);
  ok('deleting an unused card of theirs leaves the cast alone', db.raw.prepare('SELECT COUNT(*) n FROM story_npcs WHERE story_id=?').get(story).n === 1);
  db.close();
}

// ------------------------------------------------------------------ packages

section('a package says who is cast');
{
  const db = fresh();
  const book = db.createLorebook('Harbour', '');
  setSourceRole(db, { lorebookId: book, role: 'mixed', origin: 'manual', status: 'approved', confidence: 'high' });
  const sal = createEntity(db, { type: 'person', name: 'Salvatore', aliases: [] });
  declareInSource(db, { lorebookId: book, entityId: sal, localRef: 'salvatore', localName: 'Salvatore', origin: 'manual', status: 'approved' });
  const e = entry(db, book, 'Salvatore', 'Waits by the car.'); approveDefines(db, e, sal);
  const card = db.writeCharacter({ name: 'Lead', description: '' });
  const story = db.createStory({ title: 'Cast', characterIds: [card], lorebookIds: [book] });
  db.setStoryNpc(story, e, 'supporting');
  const exported = exportStory(db, story);
  const out = exported.package;
  const npc = out.stories[0].npcs[0];
  // Package v1 was frozen with `{ source, entry, role }`, and it stays that
  // way: who somebody is comes from the entry's own semantics on import.
  ok('the wire shape is the frozen one, unchanged', JSON.stringify(Object.keys(npc).sort()) === '["entry","role","source"]', JSON.stringify(npc));
  ok('naming the entry that introduced them', npc.source && npc.entry && npc.role === 'supporting');
  ok('and nothing was exported that v1 has no word for', exported.warnings.length === 0, JSON.stringify(exported.warnings));
  const db2 = fresh();
  const r = importPackage(db2, out, { decisions: {}, filename: 'cast.json' });
  const sid = Object.values(r.stories)[0];
  const row = db2.raw.prepare('SELECT * FROM story_npcs WHERE story_id=?').get(sid);
  ok('the import writes identity, not an entry', row && row.entity_id === Object.values(r.entities)[0] && row.role === 'supporting');
  ok('with the entry kept as provenance', row.profile_entry_id !== null);
  const again = exportStory(db2, sid).package;
  ok('and it round-trips', JSON.stringify(again.stories[0].npcs) === JSON.stringify(out.stories[0].npcs));
  // Somebody whose introducing entry is gone cannot be named in v1. That is
  // said out loud rather than dropped in silence.
  db2.deleteEntry(row.profile_entry_id);
  const after = exportStory(db2, sid);
  ok('a cast member v1 cannot name is reported, not silently lost',
    after.warnings.some((w) => /has no way to name them/.test(w.message)), JSON.stringify(after.warnings.map((w) => w.message)));
  ok('and they are still in the cast', db2.raw.prepare('SELECT COUNT(*) n FROM story_npcs WHERE story_id=?').get(sid).n === 1);
  db.close(); db2.close();
}

// ------------------------------------------------------- startup is not consent

section('opening the app never rebuilds the table');
{
  const db = fresh();
  const book = db.createLorebook('Harbour', '');
  const carlo = createEntity(db, { type: 'person', name: 'Carlo', aliases: [] });
  declareInSource(db, { lorebookId: book, entityId: carlo, localRef: 'c', localName: 'Carlo', origin: 'manual', status: 'approved' });
  const e1 = entry(db, book, 'Carlo', 'Runs the docks.'); approveDefines(db, e1, carlo);
  const story = db.createStory({ title: 'Ready', lorebookIds: [book] });
  backToTransitional(db);
  legacyRow(db, story, e1, 'supporting', 0);
  const path = db.raw.location();
  const before = createHash('sha256').update(JSON.stringify(db.raw.prepare('SELECT * FROM story_npcs ORDER BY rowid').all())).digest('hex');
  const ddlBefore = db.raw.prepare("SELECT sql FROM sqlite_master WHERE name='story_npcs'").get().sql;
  db.close();

  // A database that COULD be rebuilt, opened the way starting Nexus opens it.
  const again = open(path);
  ok('readiness says it could be rebuilt', again.npcMigration?.canApply === true, JSON.stringify(again.npcMigration));
  ok('but the table is untouched', npcTableShape(again) === 'transitional'
    && again.raw.prepare("SELECT sql FROM sqlite_master WHERE name='story_npcs'").get().sql === ddlBefore);
  ok('and not one row was written',
    createHash('sha256').update(JSON.stringify(again.raw.prepare('SELECT * FROM story_npcs ORDER BY rowid').all())).digest('hex') === before);
  ok('the app runs on the old table through the compatibility layer', again.npcShape === 'transitional'
    && again.storyNpcs(story).length === 1 && again.storyNpcs(story)[0].entry_id === e1);
  // Opening it repeatedly still changes nothing.
  again.close();
  const third = open(path);
  ok('opening it again changes nothing either', npcTableShape(third) === 'transitional'
    && createHash('sha256').update(JSON.stringify(third.raw.prepare('SELECT * FROM story_npcs ORDER BY rowid').all())).digest('hex') === before);
  // Only an explicit apply does it.
  const done = applyNpcMigration(third);
  ok('an explicit apply rebuilds it', done.migrated === 1 && npcTableShape(third) === 'canonical');
  ok('and the cast survived the rebuild', third.storyNpcs(story)[0]?.entity_id === carlo);
  third.close();
  const fourth = open(path);
  ok('afterwards there is nothing pending', npcTableShape(fourth) === 'canonical' && fourth.npcMigration === null);
  fourth.close();
}

// ------------------------------------------------------------ persona safety

section('who you play, when nobody has said who that is');
const personaCase = ({ bind, withRows }) => {
  const db = fresh();
  const book = db.createLorebook('Harbour', '');
  const carlo = createEntity(db, { type: 'person', name: 'Carlo', aliases: [] });
  const reiko = createEntity(db, { type: 'person', name: 'Reiko', aliases: [] });
  for (const [id, ref] of [[carlo, 'c'], [reiko, 'r']]) {
    declareInSource(db, { lorebookId: book, entityId: id, localRef: ref, localName: ref, origin: 'manual', status: 'approved' });
  }
  const eCarlo = entry(db, book, 'Carlo', 'Runs the docks.'); approveDefines(db, eCarlo, carlo);
  const eReiko = entry(db, book, 'Reiko', 'Watchful.'); approveDefines(db, eReiko, reiko);
  const persona = db.savePersona({ name: 'Reiko', description: 'You.' });
  if (bind) bindPersonaEntity(db, persona, bind === 'same' ? reiko : carlo);
  const story = db.createStory({ title: 'Played', lorebookIds: [book], personaId: persona });
  backToTransitional(db);
  if (withRows) legacyRow(db, story, bind === 'same' ? eReiko : eCarlo, 'main', 0);
  const r = npcMigrationReadiness(db);
  return { db, r, story };
};
{
  // A. the persona is known, and is nobody in the cast.
  const a = personaCase({ bind: 'other', withRows: true });
  // bound to Carlo, and the cast row IS Carlo: that is a collision. Use a
  // separate case for "known and different".
  a.db.close();

  const known = (() => {
    const db = fresh();
    const book = db.createLorebook('Harbour', '');
    const carlo = createEntity(db, { type: 'person', name: 'Carlo', aliases: [] });
    const reiko = createEntity(db, { type: 'person', name: 'Reiko', aliases: [] });
    for (const [id, ref] of [[carlo, 'c'], [reiko, 'r']]) declareInSource(db, { lorebookId: book, entityId: id, localRef: ref, localName: ref, origin: 'manual', status: 'approved' });
    const eCarlo = entry(db, book, 'Carlo', 'Runs the docks.'); approveDefines(db, eCarlo, carlo);
    const persona = db.savePersona({ name: 'Reiko', description: 'You.' });
    bindPersonaEntity(db, persona, reiko);
    const story = db.createStory({ title: 'Played', lorebookIds: [book], personaId: persona });
    backToTransitional(db);
    legacyRow(db, story, eCarlo, 'main', 0);
    return { db, r: npcMigrationReadiness(db) };
  })();
  ok('A. persona known and different from the cast: safe', known.r.canApply
    && known.r.personaUnverified.length === 0 && known.r.collisions.length === 0, JSON.stringify(known.r.needsDecision));
  ok('   and the rebuild runs', applyNpcMigration(known.db).migrated === 1);
  known.db.close();

  // B. the persona is known, and IS somebody in the cast.
  const same = personaCase({ bind: 'same', withRows: true });
  ok('B. persona known and in the cast: a collision, blocked', !same.r.canApply
    && same.r.collisions.length === 1 && same.r.personaUnverified.length === 0);
  ok('   and the reason names them', /who you play in this story/.test(same.r.collisions[0].why), same.r.collisions[0].why);
  ok('   and apply refuses', threw(() => applyNpcMigration(same.db)) instanceof NpcMigrationError);
  same.db.close();

  // C. a persona with no identity at all, and legacy rows to canonicalise.
  const unknown = personaCase({ bind: null, withRows: true });
  ok('C. persona with no identity and legacy rows: unverifiable, blocked', !unknown.r.canApply
    && unknown.r.personaUnverified.length === 1 && unknown.r.collisions.length === 0, JSON.stringify(unknown.r.needsDecision));
  ok('   and it says nobody can prove it either way',
    /has not been joined to an identity yet/.test(unknown.r.personaUnverified[0].why)
    && /cannot prove that none of this cast is you/.test(unknown.r.personaUnverified[0].why), unknown.r.personaUnverified[0].why);
  ok('   it is not called unresolved, and no identity was guessed',
    unknown.r.unresolved.length === 0 && unknown.r.personaUnverified[0].resolved?.name === 'Carlo');
  const e = threw(() => applyNpcMigration(unknown.db));
  ok('   apply refuses, saying why', e instanceof NpcMigrationError && /persona has no identity yet/.test(e.message), e?.message);
  ok('   and nothing was rebuilt', npcTableShape(unknown.db) === 'transitional');
  // Once somebody says who they play, and it is not the cast, it is safe.
  const reiko = unknown.db.raw.prepare("SELECT id FROM lore_entities WHERE canonical_name='Reiko'").get().id;
  const persona = unknown.db.raw.prepare('SELECT persona_id p FROM stories WHERE id=?').get(unknown.story).p;
  bindPersonaEntity(unknown.db, persona, reiko);
  const after = npcMigrationReadiness(unknown.db);
  ok('   joining the persona to an identity settles it', after.canApply && after.personaUnverified.length === 0);
  unknown.db.close();

  // D. a persona with no identity, and no legacy cast rows at all.
  const empty = personaCase({ bind: null, withRows: false });
  ok('D. persona with no identity but no cast rows: nothing to block', empty.r.canApply
    && empty.r.personaUnverified.length === 0 && empty.r.rows.length === 0);
  empty.db.close();
}

// ------------------------------------------- provenance never owns membership

section('a profile entry is where somebody was read about, not whether they are here');
{
  const db = fresh();
  const bookA = db.createLorebook('Patrick Lore', '');
  const bookB = db.createLorebook('Second Harbour', '');
  const carlo = createEntity(db, { type: 'person', name: 'Carlo Vancetti', aliases: [] });
  for (const b of [bookA, bookB]) declareInSource(db, { lorebookId: b, entityId: carlo, localRef: 'carlo', localName: 'Carlo Vancetti', origin: 'manual', status: 'approved' });
  const profile = entry(db, bookA, 'Carlo Vancetti', 'Runs the west docks.'); approveDefines(db, profile, carlo);
  const alsoCarlo = entry(db, bookB, 'Carlo at the club', 'Drinks alone.'); approveDefines(db, alsoCarlo, carlo);
  const card = db.writeCharacter({ name: 'Lead', description: '' });
  const story = db.createStory({ title: 'The Quay', characterIds: [card], lorebookIds: [bookA, bookB] });
  db.setStoryNpc(story, profile, 'supporting');

  const row0 = db.raw.prepare('SELECT * FROM story_npcs WHERE story_id=?').get(story);
  ok('cast, with the entry as provenance', row0.entity_id === carlo && row0.role === 'supporting' && row0.profile_entry_id === profile);
  const inCast = () => db.storyNpcs(story);
  ok('the cast read model names them', inCast().length === 1 && inCast()[0].name === 'Carlo Vancetti');

  // Only the provenance entry goes.
  db.deleteEntry(profile);
  const row1 = db.raw.prepare('SELECT * FROM story_npcs WHERE story_id=?').get(story);
  ok('deleting only the profile entry leaves the row', !!row1);
  ok('the person is unchanged', row1.entity_id === carlo);
  ok('the part is unchanged', row1.role === 'supporting');
  ok('the provenance is cleared', row1.profile_entry_id === null);
  ok('and the cast read model still names them', inCast().length === 1 && inCast()[0].name === 'Carlo Vancetti' && inCast()[0].role === 'supporting');
  ok('with no entry to point at, and that is fine', inCast()[0].entry_id === null);

  // Now the whole source that held the provenance, deleted as a library action.
  db.setStoryNpc(story, { entityId: carlo, role: 'supporting', profileEntryId: alsoCarlo });
  ok('provenance can be given again by another entry', db.raw.prepare('SELECT profile_entry_id p FROM story_npcs WHERE story_id=?').get(story).p === alsoCarlo);
  // bookB is attached to the story, so deleting it is refused — take it out of
  // the story first, which is the explicit decision, then delete the library
  // resource. The cast row must survive the FK cascade either way.
  const refused = threw(() => deleteOneResource(db, 'source', bookB));
  ok('a source a story reads cannot just be deleted', !!refused, refused?.message);
  db.raw.prepare('DELETE FROM story_lorebooks WHERE story_id=? AND lorebook_id=?').run(story, bookB);
  deleteOneResource(db, 'source', bookB);
  const row2 = db.raw.prepare('SELECT * FROM story_npcs WHERE story_id=?').get(story);
  ok('deleting the source that held the provenance does not cascade the cast row away', !!row2);
  ok('they are still the same person in the same part', row2.entity_id === carlo && row2.role === 'supporting');
  ok('and the provenance went with the source', row2.profile_entry_id === null);
  ok('the person themselves survives', !!db.raw.prepare('SELECT 1 x FROM lore_entities WHERE id=?').get(carlo));
  ok('and the cast read model is unchanged', inCast().length === 1 && inCast()[0].name === 'Carlo Vancetti' && inCast()[0].role === 'supporting');
  db.close();
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exit(fail ? 1 : 0);
