// Which person a card or a persona is, and who gets to decide.
//
//   node scripts/check-identity.js
//
// Throwaway databases. The promises held here: Nexus never works this out from
// a name, a card that represents nobody is told so rather than guessed at, the
// evidence it offers is ordered but never authority, saying "someone new" keeps
// two people of one name apart for good, connecting shows what they know
// immediately and attaches nothing to any story, disconnecting deletes nothing,
// and looking writes nothing.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { open } from '../src/db/index.js';
import {
  bindingFor, bindingCandidates, connectResource, newPersonFor,
  disconnectPreview, disconnectResource, unboundResources, offerFor,
} from '../src/semantics/identity.js';
import { reuseState, attachReusable } from '../src/semantics/reuse.js';
import { createEntityKnowledge } from '../src/semantics/authoring.js';
import {
  createEntity, declareInSource, setEntrySemantics, setRelation, setSourceRole,
  bindCharacterEntity, bindPersonaEntity, bindCard, areDistinct, SemanticError,
} from '../src/semantics/store.js';
import { entityProfile } from '../src/semantics/profile.js';

let pass = 0; let fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? `  — ${d}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? `  — ${d}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);
const threw = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const fresh = () => open(join(mkdtempSync(join(tmpdir(), 'tipsy-p101-')), 'p101.db'));

/** Everything a look must not change. */
const FINGERPRINT = (db) => createHash('sha256').update(JSON.stringify([
  db.raw.prepare('SELECT id, name, entity_id FROM characters ORDER BY id').all(),
  db.raw.prepare('SELECT id, name, entity_id FROM personas ORDER BY id').all(),
  db.raw.prepare('SELECT * FROM lore_entities ORDER BY id').all(),
  db.raw.prepare('SELECT * FROM entity_distinctions ORDER BY entity_a, entity_b').all(),
  db.raw.prepare('SELECT * FROM story_lorebooks ORDER BY story_id, lorebook_id').all(),
  db.raw.prepare('SELECT * FROM story_entity_cards ORDER BY story_id, entity_id').all(),
  db.raw.prepare('SELECT * FROM story_npcs').all(),
  db.raw.prepare('SELECT id, lorebook_id, title FROM lore_entries ORDER BY id').all(),
])).digest('hex');

/** Somebody with reusable knowledge of their own, and no card. */
function personWithKnowledge(db, name, titles, aliases = []) {
  const id = createEntity(db, { type: 'person', name, aliases });
  for (const t of titles) {
    createEntityKnowledge(db, {
      entityId: id, title: t, content: `${t}, about ${name}.`, category: 'psychology',
      activation: { mode: 'always', keys: [] },
    });
  }
  return id;
}

/** A source imported about one person, organised the way Review leaves it. */
function importedAbout(db, entityId, name, titles, { fromCharacter = null } = {}) {
  const id = db.createLorebook(name, '');
  // A source that arrived with a character card keeps saying so, which is the
  // provenance the chooser leans on hardest.
  if (fromCharacter) db.raw.prepare('UPDATE lorebooks SET from_character=? WHERE id=?').run(fromCharacter, id);
  declareInSource(db, { lorebookId: id, entityId, localRef: 'x', localName: name, origin: 'converted', status: 'approved' });
  for (const t of titles) {
    const e = db.saveEntry(id, { title: t, content: `${t}.`, keys: [t.toLowerCase()], ord: 100, enabled: true, constant: false, probability: 100, kind: 'note' });
    setEntrySemantics(db, { entryId: e, scope: 'entity', category: 'backstory', origin: 'converted', status: 'approved', confidence: 'high' });
    setRelation(db, { entryId: e, entityId, relation: 'subject', origin: 'converted', status: 'approved' });
  }
  setSourceRole(db, { lorebookId: id, role: 'entity-material', origin: 'converted', status: 'approved', confidence: 'high', subjectEntityId: entityId });
  return id;
}

// ---------------------------------------------------------------------------
section('A card that represents nobody says so, and is not guessed at');
{
  const db = fresh();
  const patrick = personWithKnowledge(db, 'Patrick Moretti', ['Deepest Fear', 'The Office'], ['The Saint']);
  const card = db.writeCharacter({ name: 'Patrick Moretti', description: 'Careful.', firstMessage: 'He does not look up.' });

  const b = bindingFor(db, { kind: 'character', resourceId: card });
  ok('a new card represents nobody', !b.bound && b.entityId === null);
  ok('and nothing about them is claimed', b.entity === null);

  // The whole point: the name matches exactly, and it still is not them.
  const chars = db.listCharacters();
  ok('the card was not quietly joined to the person of the same name',
    chars.find((c) => c.id === card).entity_id === null || chars.find((c) => c.id === card).entity_id === undefined);
  ok('their knowledge is not shown as the card\'s', reuseState(db, patrick).entries === 2 && !b.entityId);

  const c = bindingCandidates(db, { kind: 'character', resourceId: card });
  ok('but there is a way to say who they are', c.candidates.length === 1, `${c.candidates.length} offered`);
  ok('and the offer says it is only a name', c.candidates[0].nameOnly && c.candidates[0].why[0] === 'Same name');
  ok('with enough about them to tell them apart', c.candidates[0].entries === 2, `${c.candidates[0].entries} entries`);
  ok('a name match is never presented as the likely answer', c.candidates[0].prominent === false);
  db.close();
}

// ---------------------------------------------------------------------------
section('Looking writes nothing');
{
  const db = fresh();
  const patrick = personWithKnowledge(db, 'Patrick Moretti', ['Deepest Fear']);
  const card = db.writeCharacter({ name: 'Patrick Moretti', description: 'x', firstMessage: 'y' });
  const persona = db.savePersona({ name: 'Reiko', description: 'x' });
  const before = FINGERPRINT(db);
  bindingFor(db, { kind: 'character', resourceId: card });
  bindingCandidates(db, { kind: 'character', resourceId: card });
  bindingCandidates(db, { kind: 'persona', resourceId: persona });
  unboundResources(db);
  offerFor(db, patrick);
  ok('every read leaves the database exactly as it was', FINGERPRINT(db) === before);
  db.close();
}

// ---------------------------------------------------------------------------
section('Evidence is ordered, and says what it is');
{
  const db = fresh();
  const patrick = personWithKnowledge(db, 'Patrick Moretti', ['Deepest Fear']);
  const other = createEntity(db, { type: 'person', name: 'Patrick Moretti', aliases: [] });
  const card = db.writeCharacter({ name: 'Patrick Moretti', description: 'x', firstMessage: 'y' });
  // A source that came from this very card, organised as being about Patrick.
  importedAbout(db, patrick, 'Patrick Moretti — Lore', ['History'], { fromCharacter: card });

  const c = bindingCandidates(db, { kind: 'character', resourceId: card });
  ok('the person their own source is about comes first', c.candidates[0].entityId === patrick);
  ok('and is said to be worth putting first', c.candidates[0].prominent === true);
  ok('in the reader\'s words', c.candidates[0].why[0] === 'A source you organised says this is who they are');
  ok('the other of the same name is still offered', c.candidates.some((x) => x.entityId === other));
  ok('and marked as nothing but a name', c.candidates.find((x) => x.entityId === other).nameOnly === true);
  ok('provenance alone still does not bind anything', !bindingFor(db, { kind: 'character', resourceId: card }).bound);

  const story = db.createStory({ title: 'A story', characterIds: [card] });
  bindCard(db, { storyId: story, entityId: other, characterId: card });
  const c2 = bindingCandidates(db, { kind: 'character', resourceId: card });
  ok('a part this card already played counts as evidence too',
    c2.candidates.find((x) => x.entityId === other).why.includes('You already played this card as them in a story'));
  db.close();
}

// ---------------------------------------------------------------------------
section('Two people with one name stay two people');
{
  const db = fresh();
  const a = personWithKnowledge(db, 'Patrick Moretti', ['Deepest Fear', 'The Office']);
  const b = personWithKnowledge(db, 'Patrick Moretti', ['Another Fear']);
  const card = db.writeCharacter({ name: 'Patrick Moretti', description: 'x', firstMessage: 'y' });

  const c = bindingCandidates(db, { kind: 'character', resourceId: card });
  ok('both are offered, neither is chosen', c.candidates.length === 2 && !c.bound);
  ok('and nothing merged them', a !== b && !areDistinct(db, a, b));

  const made = newPersonFor(db, { kind: 'character', resourceId: card });
  ok('saying "someone new" makes a third', made.bound && made.entityId !== a && made.entityId !== b);
  ok('and records that they are not either of the others',
    areDistinct(db, made.entityId, a) && areDistinct(db, made.entityId, b), `kept apart from ${made.keptApartFrom}`);
  ok('the new person has nothing of theirs', reuseState(db, made.entityId).entries === 0);
  ok('and theirs is untouched', reuseState(db, a).entries === 2 && reuseState(db, b).entries === 1);

  const second = db.writeCharacter({ name: 'Patrick Moretti', description: 'x', firstMessage: 'y' });
  const c2 = bindingCandidates(db, { kind: 'character', resourceId: second });
  const kept = c2.keptApart.length;
  ok('a later card is told which of them were kept apart', kept >= 2, `${kept} pairs`);
  ok('and is offered all three without a recommendation',
    c2.candidates.length === 3 && c2.candidates.every((x) => x.nameOnly));
  db.close();
}

// ---------------------------------------------------------------------------
section('Connecting shows what they know, and attaches nothing');
{
  const db = fresh();
  const patrick = personWithKnowledge(db, 'Patrick Moretti', ['Deepest Fear', 'The Office']);
  const card = db.writeCharacter({ name: 'Patrick Moretti', description: 'x', firstMessage: 'y' });
  const story = db.createStory({ title: "The Saint's Shadow", characterIds: [card] });
  const sourcesBefore = db.raw.prepare('SELECT COUNT(*) n FROM story_lorebooks WHERE story_id=?').get(story).n;

  ok('before: the story has no reusable knowledge of theirs', reuseState(db, patrick, { storyId: story }).usedHere === 0);
  const r = connectResource(db, { kind: 'character', resourceId: card, entityId: patrick });
  ok('the card now represents them', r.bound && r.entityId === patrick);
  ok('and their reusable knowledge is visible at once', r.reuse.total === 1 && r.reuse.entries === 2);
  ok('no source was attached to the story',
    db.raw.prepare('SELECT COUNT(*) n FROM story_lorebooks WHERE story_id=?').get(story).n === sourcesBefore);
  ok('the story still reads none of it', reuseState(db, patrick, { storyId: story }).usedHere === 0);
  ok('the card keeps every word it had', db.getCharacter(card).description === 'x');
  ok('no entity was created', db.raw.prepare('SELECT COUNT(*) n FROM lore_entities').get().n === 1);
  ok('no cast row was written', db.raw.prepare('SELECT COUNT(*) n FROM story_npcs').get().n === 0);

  // Only now, and only because somebody asked.
  attachReusable(db, { entityId: patrick, storyId: story });
  ok('asking for it is what changes the story', reuseState(db, patrick, { storyId: story }).usedHere === 1);

  const again = threw(() => connectResource(db, { kind: 'character', resourceId: card, entityId: createEntity(db, { type: 'person', name: 'Someone', aliases: [] }) }));
  ok('a connected card cannot be quietly pointed at someone else', again instanceof SemanticError, again?.message);
  ok('and connecting to the same person again is simply nothing',
    connectResource(db, { kind: 'character', resourceId: card, entityId: patrick }).changed === false);
  db.close();
}

// ---------------------------------------------------------------------------
section('Someone you play is a person the same way');
{
  const db = fresh();
  const reiko = personWithKnowledge(db, 'Reiko', ['Fluid Domain', 'Limits', 'Ethics']);
  const persona = db.savePersona({ name: 'Reiko', description: 'Yours.' });
  const card = db.writeCharacter({ name: 'Patrick', description: 'x', firstMessage: 'y' });
  const story = db.createStory({ title: 'A story', characterIds: [card], personaId: persona });

  ok('an unconnected persona represents nobody', !bindingFor(db, { kind: 'persona', resourceId: persona }).bound);
  const c = bindingCandidates(db, { kind: 'persona', resourceId: persona });
  ok('and is offered the person of that name, as a name', c.candidates.length === 1 && c.candidates[0].nameOnly);

  const r = connectResource(db, { kind: 'persona', resourceId: persona, entityId: reiko });
  ok('connecting works exactly as it does for a card', r.bound && r.reuse.entries === 3);
  ok('no cast row was written for someone you play', db.raw.prepare('SELECT COUNT(*) n FROM story_npcs').get().n === 0);
  ok('and no character card was made', db.listCharacters().length === 1);
  ok('the story reads none of it until asked', reuseState(db, reiko, { storyId: story }).usedHere === 0);
  attachReusable(db, { entityId: reiko, storyId: story });
  ok('and then it does', reuseState(db, reiko, { storyId: story }).usedHere === 1);
  ok('still with no cast row', db.raw.prepare('SELECT COUNT(*) n FROM story_npcs').get().n === 0);
  ok('and they are still the one you play', db.getStory(story).persona_id === persona);
  db.close();
}

// ---------------------------------------------------------------------------
section('A persona that follows a lore entry already points at somebody');
{
  const db = fresh();
  const reiko = personWithKnowledge(db, 'Reiko Tanaka', ['Fluid Domain']);
  const book = importedAbout(db, reiko, 'Reiko — Lore', ['Who she is']);
  const entry = db.listEntries(book)[0];
  const persona = db.savePersona({ name: 'Somebody Else Entirely', description: 'x', fromEntry: entry.id });

  const c = bindingCandidates(db, { kind: 'persona', resourceId: persona });
  ok('the entry it follows is the strong offer', c.candidates[0]?.entityId === reiko);
  ok('said as what it is', c.candidates[0].why[0] === 'This follows a lore entry about them');
  ok('and it is still only an offer', !c.bound && !bindingFor(db, { kind: 'persona', resourceId: persona }).bound);
  db.close();
}

// ---------------------------------------------------------------------------
section('Disconnecting says what leans on it, and deletes nothing');
{
  const db = fresh();
  const patrick = personWithKnowledge(db, 'Patrick Moretti', ['Deepest Fear', 'The Office']);
  const card = db.writeCharacter({ name: 'Patrick Moretti', description: 'x', firstMessage: 'y' });
  connectResource(db, { kind: 'character', resourceId: card, entityId: patrick });
  const one = db.createStory({ title: 'One', characterIds: [card] });
  const two = db.createStory({ title: 'Two', characterIds: [card] });
  attachReusable(db, { entityId: patrick, storyId: one });
  createEntityKnowledge(db, {
    entityId: patrick, storyId: two, title: 'Only here', content: 'True in Two alone.',
    category: 'psychology', activation: { mode: 'always', keys: [] },
  });
  bindCard(db, { storyId: one, entityId: patrick, characterId: card });

  const pv = disconnectPreview(db, { kind: 'character', resourceId: card });
  ok('the preview names the story reading their reusable knowledge',
    pv.depends.reading.length === 1 && pv.depends.reading[0].title === 'One');
  ok('and the story that wrote its own facts about them',
    pv.depends.writing.length === 1 && pv.depends.writing[0].title === 'Two');
  ok('and the part this card plays as them', pv.depends.parts === 1);
  ok('and how much is theirs', pv.depends.knowledge === 2 && pv.depends.sets === 1);
  ok('it says this is worth reading', pv.heavy === true);

  const stale = threw(() => disconnectResource(db, { kind: 'character', resourceId: card, token: 'not-the-token' }));
  ok('a change since the preview refuses the change', stale instanceof SemanticError, stale?.message);

  const entriesBefore = db.raw.prepare('SELECT COUNT(*) n FROM lore_entries').get().n;
  const r = disconnectResource(db, { kind: 'character', resourceId: card, token: pv.token });
  ok('disconnected', !r.bound && r.was === 'Patrick Moretti');
  ok('the person is still there', !!db.raw.prepare('SELECT 1 x FROM lore_entities WHERE id=?').get(patrick));
  ok('every entry is still there', db.raw.prepare('SELECT COUNT(*) n FROM lore_entries').get().n === entriesBefore);
  ok('the story still carries what it carried',
    db.raw.prepare('SELECT COUNT(*) n FROM story_lorebooks WHERE story_id=?').get(one).n === 1);
  ok('their knowledge is still theirs', reuseState(db, patrick).entries === 2);
  ok('the card still exists, with its own words', db.getCharacter(card).description === 'x');
  ok('and it can be connected again', connectResource(db, { kind: 'character', resourceId: card, entityId: patrick }).bound);
  db.close();
}

// ---------------------------------------------------------------------------
section('What a card cannot be connected to');
{
  const db = fresh();
  const place = createEntity(db, { type: 'place', name: 'The Harbour', aliases: [] });
  const card = db.writeCharacter({ name: 'The Harbour', description: 'x', firstMessage: 'y' });
  const e = threw(() => connectResource(db, { kind: 'character', resourceId: card, entityId: place }));
  ok('a card represents a person, not a place', e instanceof SemanticError, e?.message);
  ok('and a place is never offered', bindingCandidates(db, { kind: 'character', resourceId: card }).candidates.length === 0);
  const gone = threw(() => connectResource(db, { kind: 'character', resourceId: card, entityId: 'nobody' }));
  ok('somebody who is not there cannot be chosen', gone instanceof SemanticError, gone?.message);
  const missing = threw(() => bindingFor(db, { kind: 'character', resourceId: 'no-such-card' }));
  ok('a card that is gone says so', missing instanceof SemanticError, missing?.message);
  db.close();
}

// ---------------------------------------------------------------------------
section('Where a card already represents somebody, it is said');
{
  const db = fresh();
  const patrick = personWithKnowledge(db, 'Patrick Moretti', ['Deepest Fear']);
  const first = db.writeCharacter({ name: 'Patrick Moretti', description: 'one', firstMessage: 'y' });
  bindCharacterEntity(db, first, patrick);
  const second = db.writeCharacter({ name: 'Patrick Moretti', description: 'two', firstMessage: 'y' });

  const c = bindingCandidates(db, { kind: 'persona', resourceId: db.savePersona({ name: 'Patrick Moretti', description: 'x' }) });
  ok('a persona is told the card that already represents them',
    c.candidates[0]?.alreadyRepresented?.[0]?.name === 'Patrick Moretti');
  const c2 = bindingCandidates(db, { kind: 'character', resourceId: second });
  ok('and so is a second card', c2.candidates[0].alreadyRepresented.length === 1);
  ok('it is still allowed, because two cards may play one person',
    connectResource(db, { kind: 'character', resourceId: second, entityId: patrick }).bound);
  db.close();
}

// ---------------------------------------------------------------------------
section('What is waiting to be connected, and whether it is worth asking');
{
  const db = fresh();
  const patrick = personWithKnowledge(db, 'Patrick Moretti', ['Deepest Fear']);
  const known = db.writeCharacter({ name: 'Patrick Moretti', description: 'x', firstMessage: 'y' });
  importedAbout(db, patrick, 'Patrick — Lore', ['History'], { fromCharacter: known });
  const stranger = db.writeCharacter({ name: 'Nobody In Lore', description: 'x', firstMessage: 'y' });
  const persona = db.savePersona({ name: 'Reiko', description: 'x' });
  bindPersonaEntity(db, persona, createEntity(db, { type: 'person', name: 'Reiko', aliases: [] }));

  const list = unboundResources(db);
  ok('the connected persona is not in the list', !list.some((x) => x.kind === 'persona'));
  ok('both unconnected cards are', list.filter((x) => x.kind === 'character').length === 2);
  const withEvidence = list.find((x) => x.id === known);
  ok('one has real evidence behind it', withEvidence.candidates >= 1 && withEvidence.nameOnly === false);
  const without = list.find((x) => x.id === stranger);
  ok('the other has nobody to suggest', without.candidates === 0 && without.best === null);
  db.close();
}

// ---------------------------------------------------------------------------
section('A connected card is shown in full, and an unconnected one is not');
{
  const db = fresh();
  const patrick = personWithKnowledge(db, 'Patrick Moretti', ['Deepest Fear', 'The Office']);
  const card = db.writeCharacter({ name: 'Patrick Moretti', description: 'Careful.', firstMessage: 'y' });
  ok('nobody\'s profile shows an unconnected card as theirs',
    !entityProfile(db, patrick).resources.character);
  connectResource(db, { kind: 'character', resourceId: card, entityId: patrick });
  const p = entityProfile(db, patrick);
  ok('once connected, the profile knows the card', p.resources.character?.id === card);
  ok('and their knowledge is there to use', reuseState(db, patrick).entries === 2);
  ok('nothing about the card\'s own fields changed', db.getCharacter(card).description === 'Careful.');
  ok('and the profile reads the card\'s own words as core', String(p.core?.identity || '').includes('Careful'));
  db.close();
}

// ---------------------------------------------------------------------------
section('Knowledge ABOUT somebody is never called knowledge they have');
{
  // A childhood, a deepest fear, an abandonment wound: all true of Patrick
  // whether or not Patrick understands any of them. Reusable knowledge is
  // structured knowledge about a person, and nothing in the app may describe it
  // as what that person knows — that wording would spend a distinction a later
  // "who knows what" layer needs, and would be a lie about the data today.
  // Only what a reader can see: comments are where the rule itself is written
  // down, so scanning them would fail on the explanation of the rule.
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const ui = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const saying = (re) => (ui.match(re) || []).slice(0, 3);

  // "what they know" / "they know" said of an entity's own knowledge.
  const claims = saying(/[^\n]*\b(?:what|everything|anything) (?:they|he|she) knows?\b[^\n]*/gi)
    .concat(saying(/[^\n]*\bentr(?:y|ies) (?:they|he|she) know\b[^\n]*/gi))
    .concat(saying(/[^\n]*\bof what they know\b[^\n]*/gi))
    .concat(saying(/[^\n]*\bthey know that can travel\b[^\n]*/gi))
    // "what X knows" in an aria-label or title, same mistake said quietly.
    .concat(saying(/[^\n]*aria-label="Use what [^"]*knows[^\n]*/gi));
  ok('no screen says an entity knows its own reusable knowledge', claims.length === 0, claims.join(' | ').slice(0, 220));

  // And the check has teeth: the wording this replaced is still caught.
  const WRONG = [
    '<span>5 entries they know that can travel.</span>',
    '<span>3 of what they know is already available here.</span>',
    'aria-label="Use what Patrick Moretti knows in this story"',
    '<p>Pick who is in it and what they know.</p>',
  ];
  const caught = WRONG.filter((s) => /\b(?:what|everything|anything) (?:they|he|she) knows?\b/i.test(s)
    || /\bentr(?:y|ies) (?:they|he|she) know\b/i.test(s)
    || /\bof what they know\b/i.test(s)
    || /\bthey know that can travel\b/i.test(s)
    || /aria-label="Use what [^"]*knows/i.test(s));
  ok('and the old wording would still be caught', caught.length === WRONG.length, `${caught.length}/${WRONG.length}`);

  // The wording that IS correct keeps working: the knower is the reader.
  ok('the reader\'s own knowledge is still said as theirs', /what you know about/.test(ui));
  // And the review control names whose knowledge it is.
  ok('the review offers it as the person\'s reusable knowledge', /reusable knowledge/.test(ui));
  ok('counted as entries available, not as things the person holds', /entries' : 'entries'\)} available`/.test(ui)
    || /\$\{said\}/.test(ui));
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exit(fail ? 1 : 0);
