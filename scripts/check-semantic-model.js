// The semantic model, P1: entities, declarations, semantics, relations,
// bindings, distinctions, legacy link evidence, and what outranks `kind`.
//
//   node scripts/check-semantic-model.js
//
// A throwaway database and a throwaway server. No model calls, no real library.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { open } from '../src/db/index.js';
import { composeSource } from '../src/import/compose.js';
import { applyToStory } from '../src/import/compose-apply.js';
import { entryHash, isDirection, organizationState, readsAsWorldContent, PERSON_CATEGORIES } from '../src/semantics/authority.js';
import {
  createEntity, getEntity, declareInSource, declarationsOf, entityUsage, setEntrySemantics, setRelation,
  distinguish, areDistinct, bindCard, semanticViews, sourceOrganization, resolveNpcEntity, setSourceRole, sourceRole,
} from '../src/semantics/store.js';

let pass = 0; let fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? `  — ${d}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? `  — ${d}` : ''}`); }
};
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return !re || re.test(e.message); } };

const dir = mkdtempSync(join(tmpdir(), 'tipsy-semantic-'));
const dbPath = join(dir, 'semantic.db');

// ------------------------------------------------------------------ a library
// Two sources about the same harbour boss. Types are deliberately wrong where
// real imports got them wrong: the rival boss as a note, his family as a character.
let db = open(dbPath);
const phase = db.createLorebook('Harbour — Phase Engine', '');
const embedded = db.createLorebook('Harbour — Embedded Lore', '');
const E = (book, o) => db.saveEntry(book, { order: 100, enabled: true, constant: false, keys: [], ...o });
const ids = {
  carlo: E(phase, { kind: 'note', title: 'Carlo Vancetti', keys: ['Carlo Vancetti', 'Carlo'], content: 'Carlo Vancetti: ambitious, charismatic, volatile.' }),
  family: E(phase, { kind: 'character', title: 'Vancetti Family', keys: ['Vancetti'], content: 'The Vancetti Family, led by Carlo Vancetti, favours spectacle.' }),
  childhood: E(phase, { kind: 'premise', title: 'Childhood', keys: ['childhood'], content: 'Unstable childhood. He learned people vanish.' }),
  pacing: E(phase, { kind: 'note', title: 'Pacing', constant: true, keys: ['pace'], content: 'Keep scenes slow. Never skip a phase.' }),
  voice: E(phase, { kind: 'direction', title: 'Voice', constant: true, keys: ['voice'], content: 'The harbour is cold and the boss is patient.' }),
  plainDirection: E(phase, { kind: 'direction', title: 'Old Rule', constant: true, keys: ['rule'], content: 'Write in the second person.' }),
  proposedDirection: E(phase, { kind: 'note', title: 'Maybe A Rule', constant: true, keys: ['maybe'], content: 'Perhaps end scenes on a question.' }),
  sealed: E(phase, { kind: 'premise', title: 'Late Secret', enabled: false, keys: ['secret'], content: 'Disabled until the last act.' }),
  carloAgain: E(embedded, { kind: 'character', title: 'Carlo Vancetti', keys: ['Carlo Vancetti'], content: 'Carlo Vancetti runs the rival family.' }),
};
const dario = db.writeCharacter({ name: 'Dario Vance', description: 'Dario runs the harbour.', firstMessage: 'The ferry horn sounds.' });
const count = (t) => db.raw.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
const entriesOf = (book) => db.listEntries(book);

console.log('1  an entity belongs to no source and holds no card');
{
  const cols = db.raw.prepare('PRAGMA table_info(lore_entities)').all().map((c) => c.name);
  const fks = db.raw.prepare('PRAGMA foreign_key_list(lore_entities)').all().map((f) => f.table);
  ok('no lorebook or character column on an entity', !cols.includes('lorebook_id') && !cols.includes('character_id'), cols.join(','));
  ok('its only reference is to another entity (merges)', fks.every((t) => t === 'lore_entities'));
  ok('story_npcs gained a nullable entity_id', db.raw.prepare('PRAGMA table_info(story_npcs)').all().some((c) => c.name === 'entity_id' && c.notnull === 0));
  ok('a card binding lives on the story, not the entity', db.raw.prepare('PRAGMA table_info(story_entity_cards)').all().map((c) => c.name).join() === 'story_id,entity_id,character_id,created_at');
}

console.log('\n2  several sources can declare one entity');
const carlo = createEntity(db, { type: 'person', name: 'Carlo Vancetti', aliases: ['Carlo'] });
{
  declareInSource(db, { lorebookId: phase, entityId: carlo, localRef: 'carlo-vancetti', localName: 'Carlo Vancetti', origin: 'converted', status: 'approved' });
  declareInSource(db, { lorebookId: embedded, entityId: carlo, localRef: 'carlo', localName: 'Carlo Vancetti', origin: 'converted', status: 'approved' });
  ok('both sources declare the same entity', declarationsOf(db, phase).some((d) => d.entity_id === carlo) && declarationsOf(db, embedded).some((d) => d.entity_id === carlo));
  ok('each with its own local reference', declarationsOf(db, embedded).find((d) => d.entity_id === carlo).local_ref === 'carlo');
  ok('a source cannot use one local reference for two entities', throws(() => declareInSource(db, { lorebookId: phase, entityId: createEntity(db, { type: 'person', name: 'Someone Else' }), localRef: 'carlo-vancetti', origin: 'converted', status: 'proposed' })));
}

console.log('\n3  deleting a source does not destroy an entity used elsewhere');
{
  const scratch = db.createLorebook('Scratch source', '');
  const scratchEntry = E(scratch, { kind: 'character', title: 'Carlo Vancetti', keys: ['Carlo'], content: 'Carlo Vancetti again.' });
  declareInSource(db, { lorebookId: scratch, entityId: carlo, localRef: 'carlo', origin: 'converted', status: 'approved' });
  setEntrySemantics(db, { entryId: scratchEntry, scope: 'entity', category: 'profile', definesEntityId: carlo, origin: 'converted', status: 'approved' });
  const before = entityUsage(db, carlo);
  db.deleteLorebook(scratch);
  const after = entityUsage(db, carlo);
  ok('the source and its declaration are gone', !db.getLorebook(scratch) && after.sources === before.sources - 1 && after.definedBy === before.definedBy - 1);
  ok('the entity survives, still declared by the other sources', !!getEntity(db, carlo) && after.sources === 2);
  ok('an entity still referenced cannot be deleted out from under its references', throws(() => db.raw.prepare('DELETE FROM lore_entities WHERE id=?').run(carlo), /FOREIGN KEY/));
}

console.log('\n4  "not the same" is one decision whichever way round');
{
  const a = createEntity(db, { type: 'person', name: 'Patrick (The Saint)' });
  const b = createEntity(db, { type: 'person', name: 'Patrick (AU)' });
  distinguish(db, a, b);
  distinguish(db, b, a);
  ok('stored once', db.raw.prepare('SELECT COUNT(*) n FROM entity_distinctions').get().n === 1);
  ok('readable both ways', areDistinct(db, a, b) && areDistinct(db, b, a));
  const [lo, hi] = a < b ? [a, b] : [b, a];
  ok('the reversed pair cannot be written directly', throws(() => db.raw.prepare('INSERT INTO entity_distinctions VALUES (?,?,?)').run(hi, lo, Date.now()), /CHECK/));
  ok('an entity is never distinct from itself', throws(() => distinguish(db, a, a), /Two different/));
}

console.log('\n5–6  one approved subject per entry; many related');
const patrick = createEntity(db, { type: 'person', name: 'Dario Vance' });
const lotus = createEntity(db, { type: 'place', name: 'The Black Lotus' });
{
  for (const [id, ref] of [[patrick, 'dario'], [lotus, 'black-lotus']]) declareInSource(db, { lorebookId: phase, entityId: id, localRef: ref, origin: 'converted', status: 'approved' });
  setEntrySemantics(db, { entryId: ids.childhood, scope: 'entity', category: 'backstory', origin: 'converted', status: 'approved' });
  setRelation(db, { entryId: ids.childhood, entityId: patrick, relation: 'subject', origin: 'converted', status: 'approved' });
  ok('a second approved subject is refused', throws(() => setRelation(db, { entryId: ids.childhood, entityId: carlo, relation: 'subject', origin: 'converted', status: 'approved' }), /already has an approved subject/));
  ok('and the database refuses it even when asked directly', throws(() => db.raw.prepare(`INSERT INTO entry_relations (entry_id,entity_id,relation,origin,status,created_at,updated_at) VALUES (?,?,'subject','converted','approved',1,1)`).run(ids.childhood, carlo), /UNIQUE/));
  setRelation(db, { entryId: ids.childhood, entityId: carlo, relation: 'related', origin: 'converted', status: 'approved' });
  setRelation(db, { entryId: ids.childhood, entityId: lotus, relation: 'related', origin: 'converted', status: 'approved' });
  const v = semanticViews(db, entriesOf(phase)).get(ids.childhood);
  ok('many related entities are allowed', v.subject?.id === patrick && v.related.length === 2);
  ok('a proposed second subject may exist beside the approved one', !throws(() => setRelation(db, { entryId: ids.childhood, entityId: lotus, relation: 'subject', origin: 'converted', status: 'proposed' })));
  ok('an inference cannot be approved as it stands', throws(() => setRelation(db, { entryId: ids.childhood, entityId: carlo, relation: 'related', origin: 'inferred', status: 'approved' }), /inference/)
    && throws(() => setEntrySemantics(db, { entryId: ids.voice, scope: 'world', category: 'rule', origin: 'inferred', status: 'approved' }), /inference/));
  ok('an entry can only be about an entity its own source declares', throws(() => setRelation(db, { entryId: ids.carloAgain, entityId: lotus, relation: 'related', origin: 'converted', status: 'approved' }), /declares/));
  ok('categories are the singular enums only', throws(() => setEntrySemantics(db, { entryId: ids.voice, scope: 'entity', category: 'relationships', origin: 'converted', status: 'approved' }), /not a category/)
    && throws(() => db.raw.prepare(`INSERT INTO entry_semantics (entry_id,scope,category,origin,status,created_at,updated_at) VALUES (?,'world','directions','converted','approved',1,1)`).run(ids.pacing), /CHECK/));
  // skill, ability, equipment, belief, habit: accepted by the store and by the table itself.
  const deep = ['skill', 'ability', 'equipment', 'belief', 'habit'];
  ok('the deep-character categories exist', deep.every((category) => !throws(() => {
    db.raw.prepare(`INSERT INTO entry_semantics (entry_id,scope,category,origin,status,created_at,updated_at) VALUES (?,'entity',?,'manual','proposed',1,1)`).run(ids.voice, category);
    db.raw.prepare('DELETE FROM entry_semantics WHERE entry_id=?').run(ids.voice);
  })) && deep.every((c) => PERSON_CATEGORIES.includes(c)));
  ok("a universe's own words are not categories", ['quirk', 'magic', 'cybernetics'].every((category) =>
    throws(() => setEntrySemantics(db, { entryId: ids.voice, scope: 'entity', category, origin: 'manual', status: 'proposed' }), /not a category/)));
}

console.log('\n7–8, 13  approved semantics outrank kind; unorganised entries fall back; kind is not rewritten');
{
  const legacyDraft = composeSource(entriesOf(phase), {});
  const where = (d, title) => (d.casting.some((r) => r.entryIds.includes(ids[title])) ? 'casting' : d.sections.find((s) => s.items.some((i) => i.entryId === ids[title]))?.id);
  ok('without semantics, the note-typed Carlo is not cast (the legacy reading, unchanged)', where(legacyDraft, 'carlo') !== 'casting', where(legacyDraft, 'carlo'));
  ok('without semantics, the character-typed family sits in Background (unchanged)', where(legacyDraft, 'family') === 'backstory');

  setEntrySemantics(db, { entryId: ids.carlo, scope: 'entity', category: 'profile', definesEntityId: carlo, origin: 'converted', status: 'approved' });
  const family = createEntity(db, { type: 'faction', name: 'Vancetti Family' });
  declareInSource(db, { lorebookId: phase, entityId: family, localRef: 'vancetti-family', origin: 'converted', status: 'approved' });
  setEntrySemantics(db, { entryId: ids.family, scope: 'entity', category: 'profile', definesEntityId: family, origin: 'converted', status: 'approved' });
  setRelation(db, { entryId: ids.family, entityId: carlo, relation: 'related', origin: 'converted', status: 'approved' });

  const draft = composeSource(entriesOf(phase), { semantics: semanticViews(db, entriesOf(phase)) });
  ok('approved: Carlo is cast although typed note', where(draft, 'carlo') === 'casting' && draft.casting.find((r) => r.entryIds.includes(ids.carlo)).name === 'Carlo Vancetti');
  ok('approved: the family is a faction although typed character', where(draft, 'family') === 'factions');
  ok('approved: the family says who it relates to, not a guess', draft.sections.find((s) => s.id === 'factions').items.find((i) => i.entryId === ids.family).about.includes('Carlo Vancetti'));
  ok('approved: Childhood is Background, about Dario', where(draft, 'childhood') === 'backstory' && draft.sections.find((s) => s.id === 'backstory').items.find((i) => i.entryId === ids.childhood).about[0] === 'Dario Vance');
  ok('organised entries get no guessed links', !draft.links.some((l) => [ids.carlo, ids.family, ids.childhood].includes(l.entryId)));
  const kinds = Object.fromEntries(db.raw.prepare('SELECT id, kind FROM lore_entries WHERE id IN (?,?)').all(ids.carlo, ids.family).map((r) => [r.id, r.kind]));
  ok('the stored kinds are untouched: Carlo still note, the family still character', kinds[ids.carlo] === 'note' && kinds[ids.family] === 'character');
}

console.log('\n9  an approved entry that changes keeps its semantics, marked stale');
{
  db.saveEntry(phase, { id: ids.carlo, content: 'Carlo Vancetti: ambitious, charismatic, volatile, and newly reckless.' });
  const v = semanticViews(db, entriesOf(phase)).get(ids.carlo);
  ok('state is recheck', v.state === 'recheck' && v.stale === true && v.authoritative === true);
  const draft = composeSource(entriesOf(phase), { semantics: semanticViews(db, entriesOf(phase)) });
  ok('Carlo is still cast from the last approved semantics, not re-guessed', draft.casting.some((r) => r.entryIds.includes(ids.carlo)));
  const carloRow = draft.casting.find((r) => r.entryIds.includes(ids.carlo));
  ok('and the cast row says the semantics may be stale', carloRow?.semantic?.stale === true && carloRow.semantic.entityId === carlo, JSON.stringify(carloRow?.semantic));
  ok('the source shows NEEDS RECHECK', sourceOrganization(db, phase).display === 'needs_recheck');
}

console.log('\n10–11  old links become evidence, and evidence never blocks deletion');
{
  db.close();
  // Links as the old code wrote them, straight into the retired tables.
  const raw = open(dbPath);
  const card2 = raw.writeCharacter({ name: 'Old Card', description: 'x' });
  const old = raw.createLorebook('Old links book', '');
  const oe = raw.saveEntry(old, { kind: 'note', title: 'Guessed About', content: 'Mentions Dario once.', keys: [] });
  const oe2 = raw.saveEntry(old, { kind: 'note', title: 'Target', content: 'Something.', keys: [] });
  raw.raw.prepare('INSERT INTO entry_character_links VALUES (?,?)').run(oe, card2);
  raw.raw.prepare('INSERT INTO entry_character_links VALUES (?,?)').run(oe, dario);
  raw.raw.prepare('INSERT INTO entry_entry_links VALUES (?,?)').run(oe, oe2);
  const relationsBefore = raw.raw.prepare('SELECT COUNT(*) n FROM entry_relations').get().n;
  const semanticsBefore = raw.raw.prepare('SELECT COUNT(*) n FROM entry_semantics').get().n;
  raw.close();
  db = open(dbPath);   // the migration runs on open
  db.close();
  db = open(dbPath);   // and again: nothing more
  const legacy = db.raw.prepare("SELECT * FROM legacy_entry_links WHERE source IN ('entry_character_links','entry_entry_links')").all();
  ok('each old link is copied once, however often the database is opened', legacy.length === 3, String(legacy.length));
  ok('as legacy evidence only', legacy.every((r) => r.status === 'legacy' && r.derived_origin === 'composer-inferred'));
  ok('with names snapshotted', legacy.some((r) => r.target_name === 'Old Card') && legacy.some((r) => r.target_name === 'Target'));
  ok('nothing was approved or proposed from them', count('entry_relations') === relationsBefore && count('entry_semantics') === semanticsBefore);
  ok('the old tables are intact', count('entry_character_links') === 2 && count('entry_entry_links') === 1);
  ok('the evidence table has no foreign keys', db.raw.prepare('PRAGMA foreign_key_list(legacy_entry_links)').all().length === 0);
  db.deleteCharacter(card2);
  db.deleteLorebook(old);
  ok('the card and source it pointed at can be deleted', !db.getCharacter(card2) && !db.getLorebook(old));
  ok('and the evidence still reads as it was', db.raw.prepare("SELECT COUNT(*) n FROM legacy_entry_links WHERE entry_title='Guessed About'").get().n === 3);
}

console.log('\n12  cast identity is set only when certain');
{
  const sid = db.createStory({ title: 'Harbour', characterIds: [dario], lorebookIds: [phase, embedded] });
  applyToStory(db, sid, { casting: [{ entryId: ids.carloAgain, role: 'supporting' }] });
  let row = db.storyNpcs(sid).find((n) => n.entry_id === ids.carloAgain);
  ok('an entry with no approved profile semantics: entity_id stays NULL', row && row.entity_id === null);
  ok('resolving it finds nothing to guess from', resolveNpcEntity(db, ids.carloAgain) === null);

  const proposedPerson = createEntity(db, { type: 'person', name: 'Proposed Person' });
  const pe = E(embedded, { kind: 'character', title: 'Proposed Person', keys: ['Proposed Person'], content: 'Proposed Person keeps the ledgers.' });
  declareInSource(db, { lorebookId: embedded, entityId: proposedPerson, localRef: 'proposed-person', origin: 'converted', status: 'proposed' });
  setEntrySemantics(db, { entryId: pe, scope: 'entity', category: 'profile', definesEntityId: proposedPerson, origin: 'converted', status: 'approved' });
  ok('an approved profile of a merely proposed declaration: still NULL', resolveNpcEntity(db, pe) === null);

  setEntrySemantics(db, { entryId: ids.carloAgain, scope: 'entity', category: 'profile', definesEntityId: carlo, origin: 'converted', status: 'approved' });
  ok('an approved profile of an approved person declaration resolves', resolveNpcEntity(db, ids.carloAgain) === carlo);
  applyToStory(db, sid, { casting: [{ entryId: ids.carloAgain, role: 'main' }] });
  row = db.storyNpcs(sid).find((n) => n.entry_id === ids.carloAgain);
  ok('re-applying records the entity', row.entity_id === carlo && row.role === 'main');
  applyToStory(db, sid, { casting: [{ entryId: ids.carlo, role: 'supporting' }] });
  const carloRows = db.storyNpcs(sid).filter((n) => n.entity_id === carlo);
  ok('casting the same person through another of their entries does not cast them twice', carloRows.length === 1 && carloRows[0].role === 'supporting', JSON.stringify(db.storyNpcs(sid).map((n) => [n.title, n.entity_id, n.role])));
  ok('the database refuses a second row for the same person', throws(() => db.raw.prepare('INSERT INTO story_npcs (story_id,entry_id,role,ord,entity_id) VALUES (?,?,?,?,?)').run(sid, ids.family, 'main', 9, carlo), /UNIQUE/));
  bindCard(db, { storyId: sid, entityId: patrick, characterId: dario });
  ok('a card binding is per story', db.raw.prepare('SELECT character_id FROM story_entity_cards WHERE story_id=? AND entity_id=?').get(sid, patrick).character_id === dario && getEntity(db, patrick).character_id === undefined);
}

console.log('\n14  a completely unorganised source composes exactly as before');
{
  const plain = db.createLorebook('Plain source', '');
  E(plain, { kind: 'character', title: 'Mira Castell', keys: ['Mira Castell'], content: 'Mira Castell keeps the lighthouse.' });
  E(plain, { kind: 'character', title: 'Vancetti Family', keys: ['Vancetti'], content: 'The Vancetti Family, led by Carlo.' });
  E(plain, { kind: 'place', title: 'The Lighthouse', keys: ['lighthouse'], content: 'Mira Castell’s lighthouse.' });
  E(plain, { kind: 'direction', title: 'Pacing', constant: true, keys: ['pace'], content: 'Slow.' });
  const entries = entriesOf(plain);
  const ctx = { leadCards: [db.getCharacter(dario)], opening: 'The ferry horn sounds.' };
  const before = JSON.stringify(composeSource(entries, ctx));
  const with0 = JSON.stringify(composeSource(entries, { ...ctx, semantics: semanticViews(db, entries) }));
  ok('with no semantics rows, the draft is byte-identical', before === with0);
  ok('its organisation state is unorganized', sourceOrganization(db, plain).coverage === 'unorganized');
}

console.log('\n17  what the Directions tool offers');
{
  setEntrySemantics(db, { entryId: ids.pacing, scope: 'world', category: 'direction', origin: 'converted', status: 'approved' });
  setEntrySemantics(db, { entryId: ids.voice, scope: 'world', category: 'background', origin: 'converted', status: 'approved' });
  setEntrySemantics(db, { entryId: ids.proposedDirection, scope: 'world', category: 'direction', origin: 'converted', status: 'proposed' });
  const entries = entriesOf(phase);
  const views = semanticViews(db, entries);
  const offered = entries.filter((e) => isDirection(e, views.get(e.id))).map((e) => e.title).sort();
  ok('approved direction typed note: offered', offered.includes('Pacing'));
  ok('approved background typed direction: not offered', !offered.includes('Voice'));
  ok('unorganised kind=direction: offered, as today', offered.includes('Old Rule'));
  ok('proposed direction typed note: not offered', !offered.includes('Maybe A Rule'), offered.join(', '));
}

console.log('\n   organisation states');
{
  const org = db.createLorebook('States', '');
  const a = E(org, { kind: 'note', title: 'A', content: 'Alpha.', keys: [] });
  const b = E(org, { kind: 'note', title: 'B', content: 'Beta.', keys: [], enabled: false });
  ok('nothing approved: unorganized', sourceOrganization(db, org).coverage === 'unorganized');
  setEntrySemantics(db, { entryId: a, scope: 'world', category: 'background', origin: 'manual', status: 'approved' });
  ok('one of two approved: partial', sourceOrganization(db, org).coverage === 'partial');
  ok('a disabled entry still counts toward completeness', sourceOrganization(db, org).unresolved === 1);
  setEntrySemantics(db, { entryId: b, scope: 'other', category: 'other', origin: 'manual', status: 'approved' });
  ok('everything approved, disabled included, as world or other: organized', sourceOrganization(db, org).coverage === 'organized');
  const x = createEntity(db, { type: 'item', name: 'The Key' });
  declareInSource(db, { lorebookId: org, entityId: x, localRef: 'key', origin: 'converted', status: 'proposed' });
  ok('a proposed declaration keeps it partial', sourceOrganization(db, org).coverage === 'partial');
  declareInSource(db, { lorebookId: org, entityId: x, localRef: 'key', origin: 'converted', status: 'approved' });
  const c = E(org, { kind: 'note', title: 'C', content: 'Gamma.', keys: [] });
  setEntrySemantics(db, { entryId: c, scope: 'entity', category: 'backstory', origin: 'manual', status: 'approved' });
  ok('scope entity with no subject and nothing defined is not complete', sourceOrganization(db, org).incomplete === 1 && sourceOrganization(db, org).coverage === 'partial');
  setRelation(db, { entryId: c, entityId: x, relation: 'subject', origin: 'manual', status: 'approved' });
  ok('given its subject, the source is organized', sourceOrganization(db, org).coverage === 'organized');
  db.saveEntry(org, { id: a, content: 'Alpha, edited.' });
  const s = sourceOrganization(db, org);
  ok('an edited approved entry: needs recheck shown over organized', s.display === 'needs_recheck' && s.coverage === 'organized' && s.recheck === 1);
  ok('a pure calculation, nothing stored', organizationState([], new Map()).coverage === 'unorganized' && typeof entryHash({ title: 'x', content: 'y', keys: [] }) === 'string');
}

console.log('\n   package role: what a source is FOR, apart from what its entries mean');
{
  // Shaped like a real immersion pack: directives, typed note and rule on import.
  const pack = db.createLorebook('Immersion pack', '');
  const core = E(pack, { kind: 'note', title: 'Immersive Core', constant: true, keys: ['roleplay'], content: 'Stay inside the scene.' });
  const injuries = E(pack, { kind: 'note', title: 'Injuries Persist', keys: ['wound', 'injured'], content: 'Wounds do not heal between scenes.' });
  const omniscient = E(pack, { kind: 'rule', title: 'People Aren’t Omniscient', keys: ['secret'], content: 'Characters only know what they could know.' });
  ok('no role yet: read as world content, exactly as today', readsAsWorldContent(sourceRole(db, pack)) && sourceRole(db, pack).state === 'none');
  setSourceRole(db, { lorebookId: pack, role: 'narrative-framework', origin: 'inferred', status: 'proposed', confidence: 'high' });
  ok('a proposed role is only a suggestion', sourceRole(db, pack).role === null && sourceRole(db, pack).proposed === 'narrative-framework' && readsAsWorldContent(sourceRole(db, pack)));
  ok('an inferred role cannot be approved as it stands', throws(() => setSourceRole(db, { lorebookId: pack, role: 'narrative-framework', origin: 'inferred', status: 'approved' }), /inferred/));
  ok('only the seven roles exist', throws(() => setSourceRole(db, { lorebookId: pack, role: 'frameworks', origin: 'manual', status: 'approved' }), /not a package role/));
  setSourceRole(db, { lorebookId: pack, role: 'narrative-framework', origin: 'manual', status: 'approved' });
  ok('approved: a narrative framework is not read as world content', !readsAsWorldContent(sourceRole(db, pack)) && sourceRole(db, pack).role === 'narrative-framework');
  for (const id of [core, injuries, omniscient]) setEntrySemantics(db, { entryId: id, scope: 'world', category: 'direction', origin: 'manual', status: 'approved' });
  const entries = entriesOf(pack);
  const views = semanticViews(db, entries);
  ok('its entries are directions, however they were typed', entries.every((e) => isDirection(e, views.get(e.id))));
  const keptActivation = db.raw.prepare('SELECT title, kind, constant, keys FROM lore_entries WHERE lorebook_id=? ORDER BY title').all(pack);
  ok('activation and stored kinds are untouched', keptActivation.find((r) => r.title === 'Immersive Core').constant === 1
    && keptActivation.find((r) => r.title === 'Injuries Persist').keys.includes('wound') && keptActivation.find((r) => r.title === 'People Aren’t Omniscient').kind === 'rule');
  const org = sourceOrganization(db, pack);
  ok('organisation state reports the role without depending on it', org.coverage === 'organized' && org.packageRole.role === 'narrative-framework');
  db.deleteLorebook(pack);
  ok('the role goes with its source', db.raw.prepare('SELECT COUNT(*) n FROM source_semantics WHERE lorebook_id=?').get(pack).n === 0);

  // A reference pack: knowledge for when a scene enters its domain. Conditional
  // entries stay conditional; the role changes nothing about activation.
  const ref = db.createLorebook('Field medicine', '');
  const tourniquet = E(ref, { kind: 'note', title: 'Tourniquets', keys: ['bleeding', 'tourniquet'], content: 'Two inches above the wound, tight, note the time.' });
  const shock = E(ref, { kind: 'note', title: 'Shock', keys: ['shock', 'pale'], content: 'Pale, cold, fast pulse: lie them flat, keep them warm.' });
  const bRef = entriesOf(ref).map((e) => [e.title, e.constant, JSON.stringify(e.keys)]);
  setSourceRole(db, { lorebookId: ref, role: 'reference-pack', origin: 'manual', status: 'approved', domains: ['Medical', 'first aid', 'medical'] });
  ok('a reference pack is a role of its own, with domains as plain tags', sourceRole(db, ref).role === 'reference-pack' && JSON.stringify(sourceRole(db, ref).domains) === '["medical","first-aid"]');
  ok('a reference pack is not read as world content either', !readsAsWorldContent(sourceRole(db, ref)));
  for (const id of [tourniquet, shock]) setEntrySemantics(db, { entryId: id, scope: 'world', category: 'reference', origin: 'manual', status: 'approved' });
  const refViews = semanticViews(db, entriesOf(ref));
  ok('reference entries are not offered as directions', entriesOf(ref).every((e) => !isDirection(e, refViews.get(e.id))));
  ok('its entries stay conditional: activation untouched', JSON.stringify(entriesOf(ref).map((e) => [e.title, e.constant, JSON.stringify(e.keys)])) === JSON.stringify(bRef) && entriesOf(ref).every((e) => !e.constant));
  setSourceRole(db, { lorebookId: ref, role: 'mixed', origin: 'manual', status: 'approved' });
  ok('a mixed package is read entry by entry, as today', readsAsWorldContent(sourceRole(db, ref)));
  db.deleteLorebook(ref);
}

// ------------------------------------------------------------ through the server
console.log('\n   routes');
db.close();
const port = 9100 + Math.floor(Math.random() * 80);
const server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), DB_PATH: dbPath }, stdio: 'ignore' });
const base = `http://localhost:${port}`;
const J = (p, b, m = 'GET') => fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
try {
  for (let i = 0; i < 60; i++) { try { await fetch(`${base}/api/library`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const st = await J('/api/stories', { title: 'Directions', characterIds: [dario], lorebookIds: [phase], personaId: null }, 'POST');
  const dirs = (await J(`/api/stories/${st.body.id}/directions`)).body;
  const titles = dirs.entries.map((e) => e.title).sort();
  ok('the Directions route offers approved directions and unorganised kind=direction only', titles.join('|') === 'Old Rule|Pacing', titles.join('|'));
  const org = (await J(`/api/lorebooks/${phase}/organization`)).body;
  ok('the organization route reports coverage and display', ['unorganized', 'partial', 'organized'].includes(org.coverage) && org.display === 'needs_recheck', JSON.stringify(org));

  // Semantics never reach the request: organising and re-typing every entry changes nothing sent.
  const prompt = async () => JSON.stringify((await J(`/api/stories/${st.body.id}/prompt`)).body.messages);
  const before = await prompt();
  const d2 = open(dbPath);
  d2.raw.prepare("UPDATE lore_entries SET kind = CASE kind WHEN 'note' THEN 'character' WHEN 'character' THEN 'place' ELSE 'note' END WHERE lorebook_id=?").run(phase);
  d2.close();
  const flipped = await prompt();
  ok('changing every entry’s kind leaves the provider request byte-identical', before === flipped);
  const bible = (await J(`/api/stories/${st.body.id}/bible`)).body;
  ok('the Story Bible places approved entries by semantics', bible.sections.find((s) => s.id === 'factions')?.items.some((i) => i.id === ids.family) === true);
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* the OS may still hold it briefly */ }
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail) process.exitCode = 1;
