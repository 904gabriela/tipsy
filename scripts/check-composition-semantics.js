// Composition and the Builder, thinking in approved meaning.
//
//   node scripts/check-composition-semantics.js
//
// Throwaway databases and invented material. The promises held here: approved
// identity outranks a stored kind, one person is one cast row however many
// entries describe them, a guess never becomes truth on the way through, the
// reader you play is never offered to the model, excluding a person is one
// reversible decision, and nothing the Builder invents merges with anything on
// its own.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../src/db/index.js';
import { composeSource } from '../src/import/compose.js';
import { planComposition, writeComposition, sourceRemovalPreview, removeSource, CompositionError } from '../src/import/compose-apply.js';
import { planGenerated, writeGenerated, storyPackage } from '../src/builder/apply.js';
import { readCompositionMaterial, entityInventory, setEntityExclusion, backfillNpcIdentities } from '../src/semantics/composition.js';
import { createEntity, declareInSource, setEntrySemantics, setRelation, setSourceRole, bindPersonaEntity, resolveNpcEntity, areDistinct, semanticViews } from '../src/semantics/store.js';
import { organizationState } from '../src/semantics/authority.js';
import { createEntityKnowledge } from '../src/semantics/authoring.js';

let pass = 0; let fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? `  — ${d}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? `  — ${d}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);
const threw = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const tmp = () => join(mkdtempSync(join(tmpdir(), 'tipsy-p8-')), 'p8.db');

const db = open(tmp());
const one = (sql, ...a) => db.raw.prepare(sql).get(...a);
const q = (sql, ...a) => db.raw.prepare(sql).all(...a);

// ------------------------------------------------------------------ a world
//
// One imported-looking source whose stored kinds are all wrong, the way real
// legacy files are: a person filed as a note, a faction filed as a character,
// a place filed as a note.

const book = db.createLorebook('Harbour Files', '');
const entry = (bookId, title, kind, content, extra = {}) =>
  db.saveEntry(bookId, { order: 100, enabled: true, constant: false, probability: 100, keys: [], title, kind, content, ...extra });

const E = {
  carlo: entry(book, 'Carlo Vancetti', 'note', 'Carlo Vancetti runs the west docks and says little.'),
  carlo2: entry(book, 'Carlo — late story', 'note', 'Carlo Vancetti after the fire: quieter, kinder, slower.'),
  family: entry(book, 'Vancetti Family', 'character', 'The Vancetti Family holds the harbour and the courts.'),
  lotus: entry(book, 'Black Lotus', 'note', 'The Black Lotus is a members-only club on the water.'),
  fear: entry(book, 'Deepest Fear', 'note', 'That the office closes and nobody notices.'),
  changed: entry(book, 'Old Wound', 'note', 'A limp from the winter on the ice.'),
  guessed: entry(book, 'A Guess', 'note', 'Maybe about somebody; nobody has said.'),
  legacy: entry(book, 'Weather', 'note', 'It rains for most of autumn.'),
  reikoE: entry(book, 'Reiko Ryuusui', 'note', 'Reiko Ryuusui watches the boats and keeps her own counsel.'),
};

const carlo = createEntity(db, { type: 'person', name: 'Carlo Vancetti', aliases: ['Carlo'] });
const family = createEntity(db, { type: 'faction', name: 'Vancetti Family', aliases: [] });
const lotus = createEntity(db, { type: 'place', name: 'Black Lotus', aliases: [] });
const reiko = createEntity(db, { type: 'person', name: 'Reiko Ryuusui', aliases: [] });
for (const [ref, id, name] of [['carlo', carlo, 'Carlo Vancetti'], ['family', family, 'Vancetti Family'], ['lotus', lotus, 'Black Lotus'], ['reiko', reiko, 'Reiko Ryuusui']]) {
  declareInSource(db, { lorebookId: book, entityId: id, localRef: ref, localName: name, origin: 'converted', status: 'approved' });
}
const approve = (entryId, semantics, relations = []) => {
  setEntrySemantics(db, { entryId, origin: 'converted', status: 'approved', confidence: 'high', ...semantics });
  for (const r of relations) setRelation(db, { entryId, entityId: r.entity, relation: r.relation, origin: 'converted', status: 'approved' });
};
approve(E.carlo, { scope: 'entity', category: 'profile', definesEntityId: carlo });
approve(E.carlo2, { scope: 'entity', category: 'profile', definesEntityId: carlo });
approve(E.family, { scope: 'entity', category: 'profile', definesEntityId: family });
approve(E.lotus, { scope: 'entity', category: 'profile', definesEntityId: lotus });
approve(E.fear, { scope: 'entity', category: 'psychology' }, [{ entity: carlo, relation: 'subject' }]);
approve(E.changed, { scope: 'entity', category: 'backstory' }, [{ entity: carlo, relation: 'subject' }]);
approve(E.reikoE, { scope: 'entity', category: 'profile', definesEntityId: reiko });
// The text moved after approval: the reading stands, marked.
db.saveEntry(book, { id: E.changed, title: 'Old Wound', content: 'A limp from the winter on the ice, worse in the rain.' });
// A proposal is a suggestion, not truth.
setEntrySemantics(db, { entryId: E.guessed, scope: 'entity', category: 'backstory', origin: 'inferred', status: 'proposed', confidence: 'low' });
setRelation(db, { entryId: E.guessed, entityId: carlo, relation: 'subject', origin: 'inferred', status: 'proposed' });
setSourceRole(db, { lorebookId: book, role: 'mixed', origin: 'converted', status: 'approved' });

// A framework and a reference pack, approved as what they are.
const framework = db.createLorebook('Living Scene-like Pack', '');
const fw1 = entry(framework, 'Stay in the scene', 'note', 'Never skip time without being asked.');
const fw2 = entry(framework, 'Loose note', 'note', 'A stray thought nobody organised.');
approve(fw1, { scope: 'world', category: 'direction' });
setSourceRole(db, { lorebookId: framework, role: 'narrative-framework', origin: 'converted', status: 'approved' });
const refpack = db.createLorebook('Combat Reference', '');
const rp1 = entry(refpack, 'Knife range', 'note', 'Inside three metres the knife wins.');
setSourceRole(db, { lorebookId: refpack, role: 'reference-pack', origin: 'converted', status: 'approved' });

// The reader's persona, bound to Reiko.
const personaId = db.savePersona({ name: 'Reiko', description: 'You.' });
bindPersonaEntity(db, personaId, reiko);

// A helper that composes the way the server does.
const composeAll = (bookIds, { storyId = null, personaEntityId = null } = {}) => {
  const entries = bookIds.flatMap((id) => db.listEntries(id));
  const material = readCompositionMaterial(db, bookIds, { storyId });
  const entityCards = new Map();
  for (const x of material.inventory) if (x.cards.length || x.storyCardId) entityCards.set(x.id, { storyCardId: x.storyCardId, cards: x.cards });
  return composeSource(entries, {
    characters: db.listCharacters(),
    semantics: semanticViews(db, entries),
    sourceRoles: new Map([...material.sources].map(([id, s]) => [id, s.role])),
    excludedEntities: material.excludedEntities,
    entityCards,
    personaEntityId,
    storyNpcs: storyId ? db.storyNpcs(storyId) : [],
    storyExclusions: storyId ? db.storyExclusionIds(storyId) : new Set(),
  });
};

// -------------------------------------------------- what approved meaning does

section('approved identity outranks the stored kind');
const draft = composeAll([book, framework, refpack]);
const cast = draft.casting.filter((r) => r.backing === 'lore');
const inSection = (id) => draft.sections.find((s) => s.id === id).items.map((i) => i.title);
ok('a person filed as a note is cast', cast.some((r) => r.name === 'Carlo Vancetti'), cast.map((r) => r.name).join(', '));
ok('a faction filed as a character is a faction', inSection('factions').includes('Vancetti Family'));
ok('and never cast', !cast.some((r) => r.name === 'Vancetti Family'));
ok('a place filed as a note is a place', inSection('places').includes('Black Lotus'));
ok('one person is one cast row, however many entries', cast.filter((r) => r.name === 'Carlo Vancetti').length === 1
  && cast.find((r) => r.name === 'Carlo Vancetti').entryIds.length === 2);
ok('their identity rides along', cast.find((r) => r.name === 'Carlo Vancetti').semantic?.entityId === carlo);

section('the rest of the authority ladder');
const briefOf = (title) => draft.sections.flatMap((s) => s.items).find((i) => i.title === title);
ok('an approved subject entry is placed by meaning', briefOf('Deepest Fear')?.semantic?.state === 'approved');
ok('a changed entry keeps its approved meaning, marked', briefOf('Old Wound')?.semantic?.state === 'recheck');
ok('a proposal is not authority', briefOf('A Guess')?.semantic?.state === 'proposed'
  && inSection('other').includes('A Guess'), 'placed by legacy kind, its proposal visible but not used');
ok('unorganised material falls back as it always did', !briefOf('Weather')?.semantic || briefOf('Weather')?.semantic?.state === 'none');

section('a source role is presentation');
ok('a framework directive reads as direction', inSection('directions').includes('Stay in the scene'));
ok('and its unorganised stray follows the framework, not world building',
  inSection('directions').includes('Loose note'), briefOf('Loose note')?.note || '');
ok('and a screen need not call it unorganised, because a decision placed it',
  briefOf('Loose note')?.placedBy === 'role' && !briefOf('Weather')?.placedBy, briefOf('Loose note')?.placedBy || 'none');
ok('reference-pack material is reference, not world dumping', inSection('other').includes('Knife range')
  && briefOf('Knife range')?.note === 'reference knowledge');
ok('the roles are named for the screen', draft.sourceRoles?.[framework] === 'narrative-framework' && draft.sourceRoles?.[refpack] === 'reference-pack');
ok('a framework invents no cast, no places, no factions',
  !cast.some((r) => [fw1, fw2].includes(r.entryId)) && !inSection('places').includes('Stay in the scene') && !inSection('factions').includes('Loose note'));

section('a role places an entry; it does not organise one');
// Where an entry is shown and what anybody has decided it MEANS are two
// different facts. A role settles the first and must never settle the second:
// an unorganised directive sitting under Directions is still unorganised, and
// the source it came from is still only partly organised. Otherwise approving
// one role would silently launder a hundred entries into canon.
{
  const roleOnly = db.raw.prepare('SELECT * FROM entry_semantics WHERE entry_id=?').get(fw2);
  ok('the entry has no semantics row at all', !roleOnly, JSON.stringify(roleOnly));
  ok('so it has no approved category', !roleOnly?.category);
  ok('and no approved subject or defines',
    db.raw.prepare("SELECT COUNT(*) c FROM entry_relations WHERE entry_id=? AND status='approved'").get(fw2).c === 0
    && !roleOnly?.defines_entity_id);
  const fwEntries = db.listEntries(framework);
  const fwViews = readCompositionMaterial(db, [framework]).views;
  const view = fwViews.get(fw2);
  ok('the authority layer still calls it unorganised', view.state === 'none' && view.authoritative === false, view.state);
  // And the source's own state stays truthful: one approved entry of two.
  const state = organizationState(fwEntries, fwViews, []);
  ok('the source is partial, not organised, however clear its role is',
    state.coverage === 'partial' && state.approved === 1 && state.unresolved === 1,
    `${state.coverage}: ${state.approved} of ${state.total} approved`);
  ok('and its approved role changed none of those numbers',
    readCompositionMaterial(db, [framework]).sources.get(framework).role.role === 'narrative-framework'
    && state.coverage === 'partial');
}

section('the person you play');
const withPersona = composeAll([book], { personaEntityId: reiko });
ok('your person is not offered to the model', !withPersona.casting.some((r) => r.name === 'Reiko Ryuusui'),
  withPersona.casting.map((r) => r.name).join(', '));
ok('and the draft says why', withPersona.personaEntity?.entityId === reiko && withPersona.personaEntity.name === 'Reiko Ryuusui');
ok('without the binding they are ordinary cast', draft.casting.some((r) => r.name === 'Reiko Ryuusui'));

section('cards that stand for a person');
const cardA = db.writeCharacter({ name: 'Carlo Vancetti', description: 'A card.' });
db.raw.prepare('UPDATE characters SET entity_id=? WHERE id=?').run(carlo, cardA);
const offered = composeAll([book]);
ok('one bound card is offered', offered.casting.find((r) => r.name === 'Carlo Vancetti')?.libraryCardId === cardA);
const cardB = db.writeCharacter({ name: 'Carlo Vancetti (AU)', description: 'Another card.' });
db.raw.prepare('UPDATE characters SET entity_id=? WHERE id=?').run(carlo, cardB);
const ambiguous = composeAll([book]);
const carloRow = ambiguous.casting.find((r) => r.name === 'Carlo Vancetti');
ok('two bound cards are a choice, never a pick', carloRow?.libraryCardId !== cardB
  && (carloRow?.semantic?.cardChoices || []).length === 2, JSON.stringify(carloRow?.semantic?.cardChoices));
const story0 = db.createStory({ title: 'A Telling', lorebookIds: [book] });
db.raw.prepare('INSERT INTO story_entity_cards (story_id, entity_id, character_id, created_at) VALUES (?,?,?,?)').run(story0, carlo, cardB, Date.now());
const boundRow = composeAll([book], { storyId: story0 }).casting.find((r) => r.name === 'Carlo Vancetti');
ok('the story\'s explicit binding outranks everything', boundRow?.semantic?.boundCardId === cardB && boundRow?.libraryCardId === cardB);

// ------------------------------------------------------------- cast identity

section('story_npcs carry who somebody is');
const story = db.createStory({ title: 'The Quay', lorebookIds: [book] });
const plan = planComposition(db, {
  storyId: story, existingBookIds: [book], lorebookIds: [],
  casting: [{ entryId: E.carlo, entryIds: [E.carlo, E.carlo2], role: 'supporting' }],
  links: [], recursion: {}, exclude: [], include: [],
});
db.transaction(() => writeComposition(db, story, plan));
const npcs = q('SELECT profile_entry_id AS entry_id, role, entity_id FROM story_npcs WHERE story_id=?', story);
ok('the accepted person carries their entity', npcs.length === 1 && npcs[0].entity_id === carlo, JSON.stringify(npcs));
ok('one logical row despite two profile entries', npcs.length === 1);
ok('and remembers which entry introduced them', npcs[0].entry_id === E.carlo);

section('the cast is people, not entries');
const story2 = db.createStory({ title: 'An Older Telling', lorebookIds: [book] });
// Casting the same person twice, through two entries, is one cast row.
db.setStoryNpc(story2, E.carlo, 'background');
db.setStoryNpc(story2, E.carlo2, 'supporting');
ok('two entries about one person are one cast member', q('SELECT * FROM story_npcs WHERE story_id=?', story2).length === 1);
ok('with the part most recently given', one('SELECT role r FROM story_npcs WHERE story_id=? AND entity_id=?', story2, carlo).r === 'supporting');
ok('an entry nobody has organised cannot be cast at all',
  threw(() => db.setStoryNpc(story2, E.legacy, 'background')) !== null, threw(() => db.setStoryNpc(story2, E.legacy, 'background'))?.message);
ok('nor can a faction, however it is asked', /Only a person/.test(threw(() => db.setStoryNpc(story2, { entityId: family, role: 'main' }))?.message || ''));
ok('and the table itself refuses a row with nobody in it',
  threw(() => db.raw.prepare('INSERT INTO story_npcs (story_id, entity_id, role, ord) VALUES (?,NULL,?,0)').run(story2, 'main')) !== null);

// ------------------------------------------------------------ excluding a person

section('excluding a person is one decision');
const excludePlan = planComposition(db, {
  storyId: story, existingBookIds: [book], lorebookIds: [],
  casting: [{ entryId: E.carlo, entryIds: [E.carlo, E.carlo2], role: 'excluded' }],
  links: [], recursion: {}, exclude: [], include: [],
});
ok('the plan reads it as the person, not a pile of entries',
  excludePlan.entityExcludes.includes(carlo) && excludePlan.excludes.length === 0, JSON.stringify({ e: excludePlan.entityExcludes.length, ids: excludePlan.excludes.length }));
db.transaction(() => writeComposition(db, story, excludePlan));
ok('one row says so', q('SELECT entity_id FROM story_entity_exclusions WHERE story_id=?', story).length === 1);
const served = db.entriesForStory(story).map((e) => e.title);
ok('what defines him and what is about him stay out', !served.includes('Carlo Vancetti') && !served.includes('Carlo — late story')
  && !served.includes('Deepest Fear') && !served.includes('Old Wound'), served.join(', '));
ok('what merely mentions him stays in', served.includes('Weather') && served.includes('Vancetti Family'));
ok('the unorganised guess is not guessed away', served.includes('A Guess'));
ok('the source itself is untouched', db.listEntries(book).length === 9);
ok('other stories are unaffected', db.entriesForStory(story2).map((e) => e.title).includes('Carlo Vancetti'));
ok('and the draft shows him excluded', composeAll([book], { storyId: story }).casting.find((r) => r.name === 'Carlo Vancetti')?.current === 'excluded');
const includePlan = planComposition(db, {
  storyId: story, existingBookIds: [book], lorebookIds: [],
  casting: [{ entryId: E.carlo, entryIds: [E.carlo, E.carlo2], role: 'known' }],
  links: [], recursion: {}, exclude: [], include: [],
});
db.transaction(() => writeComposition(db, story, includePlan));
ok('and it is reversible', q('SELECT entity_id FROM story_entity_exclusions WHERE story_id=?', story).length === 0
  && db.entriesForStory(story).map((e) => e.title).includes('Carlo Vancetti'));

// ------------------------------------------------------------- source removal

section('removing a source, with identity honest');
const bookB = db.createLorebook('Second Harbour', '');
const carloB = entry(bookB, 'Carlo at the club', 'note', 'Carlo Vancetti drinks alone at the Lotus.');
declareInSource(db, { lorebookId: bookB, entityId: carlo, localRef: 'carlo', localName: 'Carlo Vancetti', origin: 'converted', status: 'approved' });
approve(carloB, { scope: 'entity', category: 'habit' }, [{ entity: carlo, relation: 'subject' }]);
db.raw.prepare('INSERT OR IGNORE INTO story_lorebooks (story_id, lorebook_id) VALUES (?,?)').run(story, bookB);
const preview1 = sourceRemovalPreview(db, story, book, composeSource);
ok('removing one source says who still remains', preview1.entitiesStaying.some((x) => x.name === 'Carlo Vancetti'),
  JSON.stringify({ staying: preview1.entitiesStaying.map((x) => x.name), leaving: preview1.entitiesLeaving.map((x) => x.name) }));
db.transaction(() => removeSource(db, story, book));
const preview2 = sourceRemovalPreview(db, story, bookB, composeSource);
ok('removing the last carrier says who leaves', preview2.entitiesLeaving.some((x) => x.name === 'Carlo Vancetti'));
db.transaction(() => removeSource(db, story, bookB));
ok('the person themselves survives it all', !!one('SELECT 1 x FROM lore_entities WHERE id=?', carlo)
  && db.listEntries(book).length === 9);

// -------------------------------------------------- the builder, reconciled

section('the builder against who exists');
const bstory = db.createStory({ title: 'Built', lorebookIds: [book] });
const gen = (name, type, role) => (type === 'person'
  ? { type: 'person', draftId: `g-${name.replace(/\W+/g, '')}`, origin: 'generated', name, role, content: `${name} waits by the water.` }
  : { type: 'entry', draftId: `g-${name.replace(/\W+/g, '')}`, origin: 'generated', section: type, title: name, content: `${name}, described.` });
const dupe = threw(() => planGenerated(db, {
  items: [gen('Carlo Rossi Vancetti', 'person', 'supporting')],
  links: [], poolIds: new Set(db.listEntries(book).map((e) => e.id)), castNames: [], allowLead: false,
  bookIds: [book], reconcile: {},
}));
ok('an unresolved possible duplicate blocks Apply', dupe instanceof CompositionError && /Carlo/.test(dupe.message), dupe?.message);
const kept = planGenerated(db, {
  items: [gen('Carlo Rossi Vancetti', 'person', 'supporting'), gen('Sofia Bell', 'person', 'known')],
  links: [], poolIds: new Set(db.listEntries(book).map((e) => e.id)), castNames: [], allowLead: false,
  bookIds: [book], reconcile: { 'g-CarloRossiVancetti': { use: 'new' } },
});
ok('"keep as new" resolves it', kept.people.length === 2 && kept.reconciliation.unresolved === 0);
ok('a genuinely new person asked nobody anything', kept.reconciliation.items.find((x) => x.name === 'Sofia Bell').decision === 'new');
const used = planGenerated(db, {
  items: [gen('Carlo Rossi Vancetti', 'person', 'supporting')],
  links: [], poolIds: new Set(db.listEntries(book).map((e) => e.id)), castNames: [], allowLead: false,
  bookIds: [book], reconcile: { 'g-CarloRossiVancetti': { use: 'existing', id: carlo } },
});
ok('"use existing" drops the copy and uses the one who exists', used.people.length === 0
  && used.reusedExisting.some((x) => x.as === 'Carlo Vancetti'));

section('what an accepted invention becomes');
const written = db.transaction(() => writeGenerated(db, bstory, kept, { title: 'Built', builder: { mode: 'build' } }));
const newEntity = one("SELECT id, type FROM lore_entities WHERE canonical_name='Carlo Rossi Vancetti'");
ok('an accepted person becomes an entity', !!newEntity && newEntity.type === 'person');
ok('approved because a person accepted it, and marked as generated',
  one('SELECT s.status, s.origin FROM entry_semantics s JOIN lore_entries e ON e.id=s.entry_id WHERE e.title=?', 'Carlo Rossi Vancetti').status === 'approved'
  && one('SELECT s.origin o FROM entry_semantics s JOIN lore_entries e ON e.id=s.entry_id WHERE e.title=?', 'Carlo Rossi Vancetti').o === 'generated');
ok('"keep as new" is remembered as a distinction', areDistinct(db, carlo, newEntity.id));
ok('their cast row knows who they are', one('SELECT entity_id e FROM story_npcs WHERE story_id=? AND entity_id=?', bstory, newEntity.id)?.e === newEntity.id);
ok('and the container is the story\'s own material', !!one("SELECT 1 x FROM lorebooks WHERE id=? AND json_extract(original,'$.managedFor.kind')='story-material'", written.bookId));
const again = threw(() => planGenerated(db, {
  items: [gen('Carlo Rossi Vancetti', 'person', 'supporting')],
  links: [], poolIds: new Set(), castNames: [], allowLead: false, bookIds: [book], reconcile: {},
}));
ok('the settled pair is not asked about again', !(again instanceof CompositionError) || !/Carlo Vancetti/.test(again?.message || ''),
  again?.message || 'no duplicate question raised');

section('manual material and safety');
const manual = createEntityKnowledge(db, {
  entityId: carlo, storyId: bstory, title: 'Control and quiet', content: 'He counts the boats twice.',
  category: 'psychology', activation: { mode: 'always', keys: [] },
});
ok('story material written by hand shares the same container', manual.lorebookId === written.bookId);
const bdraft = composeAll([book, written.bookId], { storyId: bstory });
ok('composition reads it without re-inference', bdraft.sections.flatMap((s) => s.items).some((i) => i.title === 'Control and quiet'));
const beforeStory = JSON.stringify([q('SELECT * FROM story_npcs WHERE story_id=?', story2), q('SELECT * FROM story_lorebooks WHERE story_id=?', story2)]);
setEntrySemantics(db, { entryId: E.legacy, scope: 'world', category: 'background', origin: 'manual', status: 'approved', confidence: 'high' });
ok('organising a source changes no story', JSON.stringify([q('SELECT * FROM story_npcs WHERE story_id=?', story2), q('SELECT * FROM story_lorebooks WHERE story_id=?', story2)]) === beforeStory);

// ------------------------------------------------- the rules, pushed against
//
// Each of these is a rule that would be easy to lose in a refactor and quiet
// about it. They are tested by trying to break them.

section('the person you play cannot be cast, however the request arrives');
const pstory = db.createStory({ title: 'Yours', lorebookIds: [book] });
db.raw.prepare('UPDATE stories SET persona_id=? WHERE id=?').run(personaId, pstory);
const castSelf = threw(() => planComposition(db, {
  storyId: pstory, existingBookIds: [book], lorebookIds: [],
  casting: [{ entryId: E.reikoE, entryIds: [E.reikoE], role: 'main' }],
  links: [], recursion: {}, exclude: [], include: [],
}));
ok('a hand-made request naming your own person is refused',
  castSelf instanceof CompositionError && /persona/i.test(castSelf.message), castSelf?.message);
ok('and nothing was written', q('SELECT * FROM story_npcs WHERE story_id=?', pstory).length === 0);
const knownSelf = planComposition(db, {
  storyId: pstory, existingBookIds: [book], lorebookIds: [],
  casting: [{ entryId: E.reikoE, entryIds: [E.reikoE], role: 'known' }],
  links: [], recursion: {}, exclude: [], include: [],
});
ok('being written about is still allowed', knownSelf.npcs.length === 0 && knownSelf.drop.includes(E.reikoE));

section('a person appearing as related is not a person the story left out');
const bookC = db.createLorebook('Third Harbour', '');
const mention = entry(bookC, 'The west docks', 'note', 'The west docks run late, and Carlo Vancetti is often there.');
declareInSource(db, { lorebookId: bookC, entityId: carlo, localRef: 'carlo', localName: 'Carlo Vancetti', origin: 'converted', status: 'approved' });
approve(mention, { scope: 'world', category: 'background' }, [{ entity: carlo, relation: 'related' }]);
const rstory = db.createStory({ title: 'Related Only', lorebookIds: [bookC] });
setEntityExclusion(db, { storyId: rstory, entityId: carlo, excluded: true });
ok('material that merely relates to them is still served',
  db.entriesForStory(rstory).map((e) => e.title).includes('The west docks'),
  db.entriesForStory(rstory).map((e) => e.title).join(', '));

section('a person outlives the entry that introduced them');
const story3 = db.createStory({ title: 'Outliving', lorebookIds: [book] });
db.setStoryNpc(story3, E.carlo2, 'main');
ok('cast, with the entry as provenance', one('SELECT profile_entry_id p FROM story_npcs WHERE story_id=?', story3).p === E.carlo2);
db.deleteEntry(E.carlo2);
const after3 = one('SELECT entity_id e, role r, profile_entry_id p FROM story_npcs WHERE story_id=?', story3);
ok('deleting that entry leaves them in the cast', !!after3 && after3.e === carlo && after3.r === 'main');
ok('with the provenance cleared, not the person', after3.p === null);
ok('and the cast still names them', db.storyNpcs(story3)[0]?.name === 'Carlo Vancetti' && db.storyNpcs(story3)[0]?.title === 'Carlo Vancetti');
E.carlo2 = entry(book, 'Carlo — late story', 'Carlo Vancetti after the fire: quieter, kinder, slower.');
approve(E.carlo2, { scope: 'entity', category: 'profile', definesEntityId: carlo });

section('nothing the Builder invents is approved before somebody accepts it');
const before = one("SELECT COUNT(*) c FROM entry_semantics WHERE origin='generated' AND status='approved'").c;
const previewed = planGenerated(db, {
  items: [gen('Ines Aldabra', 'person', 'supporting')],
  links: [], poolIds: new Set(), castNames: [], allowLead: false, bookIds: [book], reconcile: {},
});
ok('planning is a read', previewed.people.length === 1
  && one("SELECT COUNT(*) c FROM entry_semantics WHERE origin='generated' AND status='approved'").c === before);
ok('and the invented person does not exist yet', !one("SELECT 1 x FROM lore_entities WHERE canonical_name='Ines Aldabra'"));
db.transaction(() => writeGenerated(db, bstory, previewed, { title: 'Built', builder: { mode: 'build' } }));
ok('only accepting it makes it so', one("SELECT COUNT(*) c FROM entry_semantics WHERE origin='generated' AND status='approved'").c > before
  && !!one("SELECT 1 x FROM lore_entities WHERE canonical_name='Ines Aldabra'"));

section('a story built before all this had one of these already');
// The old Builder marked its container {"generatedFor": story}. A story that
// carries one must not end up with a second container beside it: the reader
// would see two rows both called "Story material", and the two would drift.
// The old one is recognised, never rewritten, and never duplicated.
{
  const oldStory = db.createStory({ title: 'Built Long Ago' });
  const oldBook = db.createLorebook('Built Long Ago — Story Builder', '');
  db.raw.prepare("UPDATE lorebooks SET original=json_object('generatedFor', ?) WHERE id=?").run(oldStory, oldBook);
  db.raw.prepare('INSERT OR IGNORE INTO story_lorebooks (story_id,lorebook_id) VALUES (?,?)').run(oldStory, oldBook);
  const before = one('SELECT original o, name n FROM lorebooks WHERE id=?', oldBook);
  const booksNow = () => q('SELECT lorebook_id FROM story_lorebooks WHERE story_id=?', oldStory).length;
  const was = booksNow();

  const written = createEntityKnowledge(db, {
    entityId: carlo, storyId: oldStory, title: 'Something written by hand',
    content: 'Added long after the story was built.',
    category: 'habit', activation: { mode: 'always', keys: [] },
  });
  ok('hand-written material joins the container the story already had', written.lorebookId === oldBook, written.lorebookId);
  ok('and no second one is made', booksNow() === was, `${was} → ${booksNow()}`);
  const after = one('SELECT original o, name n FROM lorebooks WHERE id=?', oldBook);
  ok('the old marker and name are left exactly as they were', after.o === before.o && after.n === before.n, after.o);
  ok('so the story sheet has one Story-material row, not two',
    q(`SELECT l.id FROM story_lorebooks sl JOIN lorebooks l ON l.id=sl.lorebook_id
        WHERE sl.story_id=? AND COALESCE(json_extract(l.original,'$.generatedFor'), json_extract(l.original,'$.managedFor.storyId'))=?`,
    oldStory, oldStory).length === 1);
}

section('reusable material stays where it was put');
const reikoKnowledge = createEntityKnowledge(db, {
  entityId: reiko, storyId: null, title: 'Advanced techniques', content: 'She reads a wake like a page.',
  category: 'skill', activation: { mode: 'keys', keys: ['technique'] },
});
ok('it goes to the person\'s own material, not a story\'s', reikoKnowledge.lorebookId !== written.bookId);
ok('and no story picks it up by itself',
  !db.entriesForStory(bstory).map((e) => e.title).includes('Advanced techniques'),
  'available to attach, never attached on its own');

db.close();
console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exit(fail ? 1 : 0);
