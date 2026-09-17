// Knowledge that travels with a person, and knowledge that stays in one story.
//
//   node scripts/check-reuse.js
//
// Throwaway databases. The promises held here: a person's reusable knowledge is
// theirs whatever kind of resource represents them, a story reads it only when
// it carries it, using it across stories is a copy and never a move, the same
// fact never arrives twice, two people with one name stay two people, and
// nothing at all is written by looking.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { open } from '../src/db/index.js';
import {
  reusableSourcesFor, reuseState, attachPreview, attachReusable, detachReusable,
  promotePreview, promoteToReusable, promotionOf,
} from '../src/semantics/reuse.js';
import {
  createEntityKnowledge, updateEntityKnowledge, deleteEntityKnowledge,
  entityKnowledgeSource, storyMaterialSource, AuthoringError,
} from '../src/semantics/authoring.js';
import {
  createEntity, declareInSource, setEntrySemantics, setRelation, setSourceRole,
  bindCharacterEntity, bindPersonaEntity,
} from '../src/semantics/store.js';
import { entityProfile } from '../src/semantics/profile.js';
import { analyzeLibraryDependencies, unusedResources, dependencyKey } from '../src/library/dependencies.js';
import { previewLibraryDelete, deleteOneResource, LibraryDeleteError } from '../src/library/delete.js';

let pass = 0; let fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? `  — ${d}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? `  — ${d}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);
const threw = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const fresh = () => open(join(mkdtempSync(join(tmpdir(), 'tipsy-p10-')), 'p10.db'));

/** An imported source about one person, organised the way Review leaves it. */
function importedAbout(db, entityId, name, titles) {
  const id = db.createLorebook(name, '');
  declareInSource(db, { lorebookId: id, entityId, localRef: 'x', localName: 'x', origin: 'converted', status: 'approved' });
  for (const t of titles) {
    const e = db.saveEntry(id, { title: t, content: `${t}, as imported.`, keys: [t.toLowerCase()], ord: 100, enabled: true, constant: false, probability: 100, kind: 'note' });
    setEntrySemantics(db, { entryId: e, scope: 'entity', category: 'backstory', origin: 'converted', status: 'approved', confidence: 'high' });
    setRelation(db, { entryId: e, entityId, relation: 'subject', origin: 'converted', status: 'approved' });
  }
  setSourceRole(db, { lorebookId: id, role: 'entity-material', origin: 'converted', status: 'approved', confidence: 'high', subjectEntityId: entityId });
  return id;
}

const FINGERPRINT = (db) => createHash('sha256').update(JSON.stringify([
  db.raw.prepare('SELECT * FROM story_lorebooks ORDER BY story_id, lorebook_id').all(),
  db.raw.prepare('SELECT * FROM story_entry_exclusions ORDER BY story_id, entry_id').all(),
  db.raw.prepare('SELECT id, lorebook_id, title, content, keys, enabled, constant, original FROM lore_entries ORDER BY id').all(),
  db.raw.prepare('SELECT * FROM lorebooks ORDER BY id').all(),
  db.raw.prepare('SELECT * FROM source_semantics ORDER BY lorebook_id').all(),
  db.raw.prepare('SELECT * FROM entry_semantics ORDER BY entry_id').all(),
  db.raw.prepare('SELECT * FROM entry_relations ORDER BY entry_id, entity_id, relation').all(),
  db.raw.prepare('SELECT * FROM lore_entities ORDER BY id').all(),
  db.raw.prepare('SELECT * FROM characters ORDER BY id').all(),
  db.raw.prepare('SELECT * FROM personas ORDER BY id').all(),
  db.raw.prepare('SELECT * FROM story_npcs ORDER BY story_id, entity_id').all(),
])).digest('hex');

// ============================================== one model, three kinds of resource

section('reusable knowledge belongs to the person, not to the kind of resource');
{
  const db = fresh();
  // A character, a persona, and somebody with no card at all.
  const patrick = createEntity(db, { type: 'person', name: 'Patrick Moretti', aliases: [] });
  const reiko = createEntity(db, { type: 'person', name: 'Reiko Ryuusui', aliases: [] });
  const carlo = createEntity(db, { type: 'person', name: 'Carlo Vancetti', aliases: [] });
  const card = db.writeCharacter({ name: 'Patrick Moretti', description: 'Careful.' });
  bindCharacterEntity(db, card, patrick);
  const persona = db.savePersona({ name: 'Reiko', description: 'You.' });
  bindPersonaEntity(db, persona, reiko);

  for (const [who, what] of [[patrick, 'Control and Vulnerability'], [reiko, 'Fluid Domain'], [carlo, 'The West Docks']]) {
    createEntityKnowledge(db, { entityId: who, title: what, content: `${what}, in general.`, category: 'psychology', activation: { mode: 'always', keys: [] } });
  }
  for (const [label, who] of [['a character', patrick], ['a persona', reiko], ['somebody with no card', carlo]]) {
    const st = reuseState(db, who);
    ok(`${label} has reusable knowledge of their own`, st.total === 1 && st.entries === 1, JSON.stringify({ total: st.total, entries: st.entries }));
  }
  ok('and it is all one container each, marked as theirs',
    [patrick, reiko, carlo].every((who) => reusableSourcesFor(db, who)[0].managed));
  ok('no card was made for the person who had none', db.listCharacters().length === 1);
  ok('the persona is not cast anywhere', db.raw.prepare('SELECT COUNT(*) n FROM story_npcs').get().n === 0);
  db.close();
}

section('only an approved subject makes a source reusable knowledge');
{
  const db = fresh();
  const patrick = createEntity(db, { type: 'person', name: 'Patrick', aliases: [] });
  // Proposed role: not reusable.
  const proposed = db.createLorebook('Maybe Patrick', '');
  declareInSource(db, { lorebookId: proposed, entityId: patrick, localRef: 'p', localName: 'Patrick', origin: 'converted', status: 'approved' });
  setSourceRole(db, { lorebookId: proposed, role: 'entity-material', origin: 'inferred', status: 'proposed', confidence: 'low', subjectEntityId: patrick });
  ok('a merely proposed reading does not make it reusable', reusableSourcesFor(db, patrick).length === 0);
  // Approved, but a mixed pack that merely mentions him.
  const mixed = db.createLorebook('A world with Patrick in it', '');
  declareInSource(db, { lorebookId: mixed, entityId: patrick, localRef: 'p', localName: 'Patrick', origin: 'converted', status: 'approved' });
  setSourceRole(db, { lorebookId: mixed, role: 'mixed', origin: 'converted', status: 'approved', confidence: 'high' });
  ok('a mixed pack that mentions him is not his knowledge', reusableSourcesFor(db, patrick).length === 0);
  // Reusable-and-story-owned is not a state the store will even record.
  const story = db.createStory({ title: 'A Telling' });
  const owned = db.createLorebook('A story\'s own material', '');
  declareInSource(db, { lorebookId: owned, entityId: patrick, localRef: 'p', localName: 'Patrick', origin: 'manual', status: 'approved' });
  ok('a source cannot be both reusable and one story\'s own',
    /not both/.test(threw(() => setSourceRole(db, {
      lorebookId: owned, role: 'entity-material', origin: 'manual', status: 'approved',
      confidence: 'high', subjectEntityId: patrick, ownerStoryId: story,
    }))?.message || ''));
  // And a story's own material — mixed, owned — is never reusable.
  const material = storyMaterialSource(db, story);
  createEntityKnowledge(db, { entityId: patrick, storyId: story, title: 'Only here', content: 'x', category: 'habit', activation: { mode: 'always', keys: [] } });
  ok('material a story owns is not reusable', !reusableSourcesFor(db, patrick).some((x) => x.id === material));
  // And a card's provenance is not a subject.
  const card = db.writeCharacter({ name: 'Patrick', description: '' });
  const embedded = db.createLorebook('Came in with Patrick', '');
  db.raw.prepare('UPDATE lorebooks SET from_character=? WHERE id=?').run(card, embedded);
  ok('arriving inside a card does not make it his knowledge', reusableSourcesFor(db, patrick).length === 0);
  ok('an unbound card offers nothing, and is not name-matched',
    reuseState(db, patrick).total === 0 && db.getCharacter(card).entity_id === undefined | db.getCharacter(card).entity_id === null);
  db.close();
}

// ============================================================== attaching

section('a story reads what somebody knows only when it carries it');
{
  const db = fresh();
  const patrick = createEntity(db, { type: 'person', name: 'Patrick', aliases: [] });
  const card = db.writeCharacter({ name: 'Patrick', description: '' });
  bindCharacterEntity(db, card, patrick);
  createEntityKnowledge(db, { entityId: patrick, title: 'Deepest Fear', content: 'That nobody notices.', category: 'psychology', activation: { mode: 'keys', keys: ['fear'] } });
  createEntityKnowledge(db, { entityId: patrick, title: 'Always true', content: 'He counts the boats.', category: 'habit', activation: { mode: 'always', keys: [] } });
  const book = db.createLorebook('A world', '');
  db.saveEntry(book, { title: 'The harbour', content: 'Wet stone.', keys: ['harbour'], ord: 100, enabled: true, constant: false, probability: 100, kind: 'note' });
  const story = db.createStory({ title: 'The Saint', characterIds: [card], lorebookIds: [book] });
  const other = db.createStory({ title: 'Another Telling', characterIds: [card], lorebookIds: [book] });

  const before = FINGERPRINT(db);
  const st0 = reuseState(db, patrick, { storyId: story });
  ok('the profile says it exists but is not used here', st0.state === 'none-here' && st0.available === 1 && st0.entriesAvailable === 2, JSON.stringify(st0.state));
  const pv = attachPreview(db, patrick, story);
  ok('the preview names what would be attached', pv.willAttach.length === 1 && pv.willAttach[0].entries === 2 && /Knowledge/.test(pv.willAttach[0].name));
  ok('and looking wrote nothing', FINGERPRINT(db) === before);
  ok('none of it reaches the story yet', !db.entriesForStory(story).some((e) => e.title === 'Always true'));

  const sourcesBefore = db.getStory(story).lorebookIds.length;
  const r = attachReusable(db, { entityId: patrick, storyId: story });
  ok('attaching is one ordinary source attachment', r.attached.length === 1
    && db.getStory(story).lorebookIds.length === sourcesBefore + 1);
  ok('no source was copied', db.raw.prepare('SELECT COUNT(*) n FROM lorebooks').get().n === 2, `${db.raw.prepare('SELECT COUNT(*) n FROM lorebooks').get().n} sources`);
  ok('no entry was copied', db.raw.prepare('SELECT COUNT(*) n FROM lore_entries').get().n === 3);
  ok('no card and no person was made', db.listCharacters().length === 1 && db.raw.prepare('SELECT COUNT(*) n FROM lore_entities').get().n === 1);
  ok('the story now reads it', db.entriesForStory(story).some((e) => e.title === 'Always true'));
  ok('and the profile says it is used here', reuseState(db, patrick, { storyId: story }).state === 'all');
  ok('attaching again changes nothing', (() => {
    const n = db.getStory(story).lorebookIds.length;
    const again = attachReusable(db, { entityId: patrick, storyId: story });
    return again.attached.length === 0 && again.alreadyHere === 1 && db.getStory(story).lorebookIds.length === n;
  })());
  ok('attaching did not make anything always-on that was not',
    db.raw.prepare("SELECT constant FROM lore_entries WHERE title='Deepest Fear'").get().constant === 0);
  ok('the keyword entry stays out until its words appear',
    !db.entriesForStory(story).filter((e) => e.constant).some((e) => e.title === 'Deepest Fear'));
  ok('the other story is untouched', !db.getStory(other).lorebookIds.includes(reusableSourcesFor(db, patrick)[0].id));

  // Detaching.
  attachReusable(db, { entityId: patrick, storyId: other });
  const d = detachReusable(db, { entityId: patrick, storyId: story });
  ok('detaching removes only the attachment', d.detached.length === 1
    && !db.getStory(story).lorebookIds.includes(d.detached[0].id));
  ok('the source and its entries remain', !!db.getLorebook(d.detached[0].id) && db.listEntries(d.detached[0].id).length === 2);
  ok('what anybody approved about them remains', db.raw.prepare('SELECT COUNT(*) n FROM entry_semantics').get().n === 2);
  ok('the person, the card and the story remain', !!db.getCharacter(card) && !!db.getStory(story)
    && !!db.raw.prepare('SELECT 1 x FROM lore_entities WHERE id=?').get(patrick));
  ok('the other story still has it', db.getStory(other).lorebookIds.includes(d.detached[0].id));
  ok('and detaching what is not here is refused, in words',
    /not using any reusable knowledge about Patrick/.test(threw(() => detachReusable(db, { entityId: patrick, storyId: story }))?.message || ''));
  db.close();
}

section('two people with one name stay two people');
{
  const db = fresh();
  const a = createEntity(db, { type: 'person', name: 'Patrick Moretti', aliases: ['Patrick'] });
  const b = createEntity(db, { type: 'person', name: 'Patrick Moretti', aliases: ['Patrick'] });
  createEntityKnowledge(db, { entityId: a, title: 'A-only fact', content: 'True of A.', category: 'backstory', activation: { mode: 'always', keys: [] } });
  createEntityKnowledge(db, { entityId: b, title: 'B-only fact', content: 'True of B.', category: 'backstory', activation: { mode: 'always', keys: [] } });
  const story = db.createStory({ title: 'An AU' });
  attachReusable(db, { entityId: a, storyId: story });
  const titles = db.entriesForStory(story).map((e) => e.title);
  ok('attaching one never brings the other', titles.includes('A-only fact') && !titles.includes('B-only fact'), titles.join(', '));
  ok('and asking for the other one by id does nothing for this one',
    threw(() => detachReusable(db, { entityId: b, storyId: story })) instanceof AuthoringError);
  ok('their knowledge is two separate containers',
    reusableSourcesFor(db, a)[0].id !== reusableSourcesFor(db, b)[0].id);
  db.close();
}

section('several sources about one person, never merged');
{
  const db = fresh();
  const patrick = createEntity(db, { type: 'person', name: 'Patrick', aliases: [] });
  createEntityKnowledge(db, { entityId: patrick, title: 'Written by hand', content: 'x', category: 'habit', activation: { mode: 'always', keys: [] } });
  const psych = importedAbout(db, patrick, 'Imported Patrick Psychology', ['Fear', 'Anger']);
  const hist = importedAbout(db, patrick, 'Imported Patrick History', ['The fire', 'The trial', 'The debt']);
  const st = reuseState(db, patrick);
  ok('three sources, six entries, counted together', st.total === 3 && st.entries === 6, JSON.stringify({ total: st.total, entries: st.entries }));
  ok('and told apart by how they got here', st.sources.filter((s) => s.managed).length === 1 && st.sources.filter((s) => !s.managed).length === 2);
  const story = db.createStory({ title: 'Some of it' });
  attachReusable(db, { entityId: patrick, storyId: story, sourceIds: [psych] });
  const partial = reuseState(db, patrick, { storyId: story });
  ok('a story may take some and not others', partial.state === 'some' && partial.usedHere === 1 && partial.entriesUsedHere === 2);
  ok('nothing was merged', db.listEntries(psych).length === 2 && db.listEntries(hist).length === 3
    && db.listEntries(entityKnowledgeSource(db, patrick, { create: false })).length === 1);
  attachReusable(db, { entityId: patrick, storyId: story });
  ok('and Use all takes the rest', reuseState(db, patrick, { storyId: story }).state === 'all');
  db.close();
}

// ============================================================== promotion

/** Patrick, a story, and one fact written for that story only. */
function promotionFixture() {
  const db = fresh();
  const patrick = createEntity(db, { type: 'person', name: 'Patrick Moretti', aliases: [] });
  const elena = createEntity(db, { type: 'person', name: 'Elena', aliases: [] });
  const card = db.writeCharacter({ name: 'Patrick Moretti', description: 'Careful.' });
  bindCharacterEntity(db, card, patrick);
  const story = db.createStory({ title: "The Saint's Shadow", characterIds: [card] });
  const written = createEntityKnowledge(db, {
    entityId: patrick, storyId: story,
    title: 'Control and Vulnerability',
    content: 'He needs the room to be his before he can be anything else in it.',
    category: 'psychology', displayPath: ['Psychology'],
    relatedEntityIds: [elena],
    activation: { mode: 'keywords', keys: ['control', 'vulnerable'], advanced: { probability: 80, order: 42 } },
  });
  return { db, patrick, elena, card, story, written };
}

section('using something across stories is a copy, not a move');
{
  const { db, patrick, elena, story, written } = promotionFixture();
  const before = FINGERPRINT(db);
  const pv = promotePreview(db, written.entryId);
  ok('the preview says what it would do', pv.scope === 'story' && pv.about === 'Patrick Moretti'
    && pv.already === false && pv.willExcludeHere === false && /Knowledge/.test(pv.creates), JSON.stringify(pv));
  ok('and the preview wrote nothing', FINGERPRINT(db) === before);

  const r = promoteToReusable(db, written.entryId);
  ok('a reusable copy is made', r.created === true && r.entryId !== written.entryId);
  ok('in their own managed knowledge', r.lorebookId === entityKnowledgeSource(db, patrick, { create: false }));
  const orig = db.raw.prepare('SELECT * FROM lore_entries WHERE id=?').get(written.entryId);
  const copy = db.raw.prepare('SELECT * FROM lore_entries WHERE id=?').get(r.entryId);
  ok('this story keeps its own version, untouched', !!orig && orig.lorebook_id === storyMaterialSource(db, story, { create: false }));
  ok('the words are the same', copy.title === orig.title && copy.content === orig.content);
  const sem = (id) => db.raw.prepare('SELECT * FROM entry_semantics WHERE entry_id=?').get(id);
  ok('the category is the same', sem(r.entryId).category === 'psychology');
  ok('the group it sits in is the same', sem(r.entryId).display_path === sem(written.entryId).display_path
    && JSON.parse(sem(r.entryId).display_path).join('/') === 'Psychology');
  ok('it is approved, by hand, with no analysis',
    sem(r.entryId).status === 'approved' && sem(r.entryId).origin === 'manual' && sem(r.entryId).confidence === 'high');
  ok('it is about the same person', db.raw.prepare("SELECT entity_id FROM entry_relations WHERE entry_id=? AND relation='subject' AND status='approved'").get(r.entryId).entity_id === patrick);
  ok('and still mentions who it mentioned',
    db.raw.prepare("SELECT entity_id FROM entry_relations WHERE entry_id=? AND relation='related' AND status='approved'").all(r.entryId).map((x) => x.entity_id).includes(elena));
  ok('it fires the same way', JSON.parse(copy.keys).join(',') === JSON.parse(orig.keys).join(',')
    && copy.constant === orig.constant && copy.enabled === orig.enabled);
  ok('down to the tuning', copy.probability === 80 && copy.ord === 42, `${copy.probability}/${copy.ord}`);

  ok('pressing it twice makes one copy, not two', (() => {
    const again = promoteToReusable(db, written.entryId);
    return again.created === false && again.entryId === r.entryId
      && db.listEntries(r.lorebookId).length === 1;
  })());
  ok('and it knows which entry it came from, explicitly', promotionOf(db, written.entryId)?.entryId === r.entryId
    && JSON.parse(copy.original).promotedFrom === written.entryId, copy.original);
  ok('the preview now says it is already done', promotePreview(db, written.entryId).already === true);

  // Independent from here.
  updateEntityKnowledge(db, r.entryId, { title: 'Control and Vulnerability', content: 'Reworded for reuse.', category: 'psychology', displayPath: ['Psychology'], activation: { mode: 'keywords', keys: ['control'] } });
  ok('editing the reusable copy leaves the story version alone',
    db.raw.prepare('SELECT content FROM lore_entries WHERE id=?').get(written.entryId).content === orig.content);
  updateEntityKnowledge(db, written.entryId, { title: 'Control and Vulnerability', content: 'Reworded for this story.', category: 'psychology', displayPath: ['Psychology'], activation: { mode: 'keywords', keys: ['control'] } });
  ok('and editing the story version leaves the copy alone',
    db.raw.prepare('SELECT content FROM lore_entries WHERE id=?').get(r.entryId).content === 'Reworded for reuse.');
  ok('the link between them survives both edits', promotionOf(db, written.entryId)?.entryId === r.entryId);

  // Deleting either leaves the other.
  deleteEntityKnowledge(db, r.entryId);
  ok('deleting the copy leaves the story version', !!db.raw.prepare('SELECT 1 x FROM lore_entries WHERE id=?').get(written.entryId));
  ok('and the person', !!db.raw.prepare('SELECT 1 x FROM lore_entities WHERE id=?').get(patrick));
  ok('and it can be promoted again afterwards', promoteToReusable(db, written.entryId).created === true);
  const second = promotionOf(db, written.entryId).entryId;
  deleteEntityKnowledge(db, written.entryId);
  ok('deleting the story version leaves the copy', !!db.raw.prepare('SELECT 1 x FROM lore_entries WHERE id=?').get(second));
  db.close();
}

section('what cannot be used across stories, and why');
{
  const { db, patrick, written } = promotionFixture();
  const already = promoteToReusable(db, written.entryId);
  ok('something already reusable says so', /already reusable/.test(threw(() => promoteToReusable(db, already.entryId))?.message || ''),
    threw(() => promoteToReusable(db, already.entryId))?.message);
  const imported = importedAbout(db, patrick, 'An imported pack', ['A fact']);
  const one = db.listEntries(imported)[0].id;
  ok('imported material is managed where it came from',
    /came from a source you imported/.test(threw(() => promoteToReusable(db, one))?.message || ''),
    threw(() => promoteToReusable(db, one))?.message);
  ok('and none of those refusals wrote anything', db.listEntries(already.lorebookId).length === 1);
  db.close();
}

section('the same fact never arrives twice');
{
  // The story already carries their reusable knowledge when the copy is made.
  const { db, patrick, story, written } = promotionFixture();
  createEntityKnowledge(db, { entityId: patrick, title: 'Something else reusable', content: 'x', category: 'habit', activation: { mode: 'always', keys: [] } });
  attachReusable(db, { entityId: patrick, storyId: story });
  const titlesBefore = db.entriesForStory(story).map((e) => e.title).sort();

  const pv = promotePreview(db, written.entryId);
  ok('the preview warns that this story already reads their knowledge', pv.willExcludeHere === true);
  const r = promoteToReusable(db, written.entryId);
  ok('the copy is made', r.created === true);
  ok('and left out of THIS story, so the fact is said once', r.excludedHere === true
    && db.storyExclusionIds(story).has(r.entryId));
  const titlesAfter = db.entriesForStory(story).map((e) => e.title).sort();
  ok('what this story reads is exactly what it read before',
    JSON.stringify(titlesAfter) === JSON.stringify(titlesBefore), JSON.stringify({ before: titlesBefore.length, after: titlesAfter.length }));
  ok('only once, not twice', titlesAfter.filter((t) => t === 'Control and Vulnerability').length === 1);
  ok('the copy is not hidden anywhere else',
    db.raw.prepare('SELECT COUNT(*) n FROM story_entry_exclusions WHERE entry_id=?').get(r.entryId).n === 1);

  // Another story attaching the same knowledge does get the copy.
  const later = db.createStory({ title: 'A Later Telling' });
  attachReusable(db, { entityId: patrick, storyId: later });
  ok('a later story may use the reusable copy',
    db.entriesForStory(later).some((e) => e.id === r.entryId));
  ok('and does not see this story\'s own version',
    !db.entriesForStory(later).some((e) => e.id === written.entryId));
  db.close();
}

section('a copy made here stays out of here, whenever the story picks it up');
{
  // The other order: used across stories FIRST, and the story carries their
  // knowledge afterwards. The copy would otherwise arrive beside the version
  // written here, and the same fact would be said twice.
  const { db, patrick, story, written } = promotionFixture();
  const r = promoteToReusable(db, written.entryId);
  ok('promoting first excludes nothing, because nothing collides yet', r.excludedHere === false
    && db.storyExclusionIds(story).size === 0);
  const before = db.entriesForStory(story).map((e) => e.title).sort();
  const a = attachReusable(db, { entityId: patrick, storyId: story });
  ok('attaching afterwards keeps the copy out of this story', a.keptOut === 1
    && db.storyExclusionIds(story).has(r.entryId), JSON.stringify({ keptOut: a.keptOut }));
  const after = db.entriesForStory(story).map((e) => e.title).sort();
  ok('so what this story reads is unchanged', JSON.stringify(after) === JSON.stringify(before), JSON.stringify({ before, after }));
  ok('and the fact is said once, not twice',
    after.filter((t) => t === 'Control and Vulnerability').length === 1);
  ok('the copy is not kept out of anywhere else',
    db.raw.prepare('SELECT COUNT(*) n FROM story_entry_exclusions WHERE entry_id=?').get(r.entryId).n === 1);
  // A story that never had its own version reads the copy normally.
  const later = db.createStory({ title: 'A Later Telling' });
  attachReusable(db, { entityId: patrick, storyId: later });
  ok('a story with no version of its own reads the copy', db.entriesForStory(later).some((e) => e.id === r.entryId));
  db.close();
}

// ============================================================== containers

section('one managed container per person, one per story');
{
  const { db, patrick, story, written } = promotionFixture();
  // Reached three different ways: authoring, promotion, and promotion again.
  createEntityKnowledge(db, { entityId: patrick, title: 'By hand', content: 'x', category: 'habit', activation: { mode: 'always', keys: [] } });
  promoteToReusable(db, written.entryId);
  createEntityKnowledge(db, { entityId: patrick, title: 'By hand again', content: 'x', category: 'habit', activation: { mode: 'always', keys: ['y'] } });
  const managed = db.raw.prepare(`SELECT id, name FROM lorebooks WHERE json_valid(original)
    AND json_extract(original,'$.managedFor.kind')='entity-knowledge'
    AND json_extract(original,'$.managedFor.entityId')=?`).all(patrick);
  ok('one Knowledge container, however it was reached', managed.length === 1, JSON.stringify(managed.map((m) => m.name)));
  ok('and it is not numbered', !/\(\d\)/.test(managed[0].name), managed[0].name);
  const material = db.raw.prepare(`SELECT id FROM lorebooks WHERE json_valid(original)
    AND (json_extract(original,'$.managedFor.storyId')=? OR json_extract(original,'$.generatedFor')=?)`).all(story, story);
  ok('and promotion made no second Story Material container', material.length === 1);
  db.close();
}

// ============================================================== cleanup and profile

section('P9 still protects what somebody wrote');
{
  const { db, patrick, story, written } = promotionFixture();
  const r = promoteToReusable(db, written.entryId);
  const dep = analyzeLibraryDependencies(db, [{ kind: 'source', id: r.lorebookId }]).get(dependencyKey('source', r.lorebookId));
  ok('their Knowledge is protected, not disposable', dep.protected && dep.used
    && /Knowledge you wrote about Patrick Moretti/.test(dep.reasons.map((x) => x.text).join('; ')), dep.reasons.map((x) => x.text).join('; '));
  ok('and Select unused never offers it', !unusedResources(db, 'source').some((x) => x.id === r.lorebookId));
  ok('nor can it be deleted directly', threw(() => deleteOneResource(db, 'source', r.lorebookId)) instanceof LibraryDeleteError);
  // Attaching it to a story does not make it look ordinary either.
  attachReusable(db, { entityId: patrick, storyId: story });
  ok('still protected once a story carries it',
    analyzeLibraryDependencies(db, [{ kind: 'source', id: r.lorebookId }]).get(dependencyKey('source', r.lorebookId)).protected);
  // An imported entity-material source follows ordinary rules.
  const imported = importedAbout(db, patrick, 'An imported pack', ['A fact']);
  const idep = analyzeLibraryDependencies(db, [{ kind: 'source', id: imported }]).get(dependencyKey('source', imported));
  ok('imported material about them is ordinary', !idep.protected && !idep.used);
  db.close();
}

section('the profile tells the difference without naming a source');
{
  const { db, patrick, story, written } = promotionFixture();
  createEntityKnowledge(db, { entityId: patrick, title: 'Reusable backstory', content: 'x', category: 'backstory', activation: { mode: 'always', keys: [] } });
  const before = FINGERPRINT(db);
  const inStory = entityProfile(db, patrick, { storyId: story });
  ok('the story-scoped profile reads', !!inStory && inStory.entity.name === 'Patrick Moretti' && inStory.story?.id === story);
  ok('and reading it wrote nothing', FINGERPRINT(db) === before);
  const st = reuseState(db, patrick, { storyId: story });
  ok('their reusable knowledge is counted for this story', st.entries === 1 && st.state === 'none-here');
  attachReusable(db, { entityId: patrick, storyId: story });
  ok('and once used here, it says so', reuseState(db, patrick, { storyId: story }).state === 'all');
  db.close();
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exit(fail ? 1 : 0);
