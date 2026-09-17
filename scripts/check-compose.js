// Story composition: reading a source into a draft, applying a reviewed
// draft, and taking a source back out.
//
//   node scripts/check-compose.js
//
// No model calls and never the real library. The analyser is fed a package
// written for this check; the apply and removal checks run against a
// throwaway database; the last section starts a throwaway server on it.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open } from '../src/db/index.js';
import { composeSource, personFromEntry, nameFromTitle, normalizeRole, ROLES } from '../src/import/compose.js';
import { createEntity, declareInSource, setEntrySemantics } from '../src/semantics/store.js';
import { semanticViews } from '../src/semantics/store.js';
import { readCompositionMaterial } from '../src/semantics/composition.js';
import { planComposition, writeComposition, applyToStory, sourceRemovalPreview, removeSource, CompositionError } from '../src/import/compose-apply.js';

let pass = 0; let fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? `  — ${d}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? `  — ${d}` : ''}`); }
};
const throws = (fn, re) => {
  try { fn(); return false; } catch (e) { return e instanceof CompositionError && (!re || re.test(e.message)); }
};

// ------------------------------------------------------------ the package
// A harbour city with one family, one rival and the material around them.
// Everything a real package does wrong is in here on purpose.
let n = 0;
const E = (o) => ({ id: `e${++n}`, lorebook_id: 'book', keys: [], enabled: true, constant: false, content: '', ...o });
const PACKAGE = [
  E({ kind: 'premise', title: 'Core Identity', constant: true, keys: ['Dario', 'Dario Vance'], content: 'Dario Vance, 31, runs the harbour for his family and trusts nobody with the keys.' }),
  E({ kind: 'character', title: 'Mira Castell', keys: ['Mira Castell', 'Mira'], content: 'Mira Castell keeps the lighthouse and the ledgers. Dario owes her twice.' }),
  E({ kind: 'character', title: 'Oren Hale: The Ferryman', keys: ['Oren Hale', 'Oren', 'Ferryman'], content: 'Oren Hale runs the last ferry. He answers to Mira, not to Dario.' }),
  E({ kind: 'character', title: 'Tobias Crane', keys: ['Tobias Crane', 'Crane'], content: 'Tobias Crane leads the Crane syndicate and wants the harbour.' }),
  E({ kind: 'character', title: 'Pell', keys: ['Pell'], content: 'Pell sweeps the fish market and hears everything.' }),
  // Not people, typed as characters by an author or an importer.
  E({ kind: 'character', title: 'Vancetti Family', keys: ['Vancetti', 'Vancetti Family'], content: 'The Vancetti Family, led by Tobias Crane’s cousin, favours spectacle.' }),
  E({ kind: 'character', title: 'How Patrick Communicates', keys: ['phone', 'text'], content: 'Short messages. Never voice notes.' }),
  E({ kind: 'character', title: 'Abandonment Wound', keys: ['abandonment', 'mother'], content: 'Dario’s mother promised to be back before dark.' }),
  E({ kind: 'character', title: 'Established Devotion Regression', keys: ['devotion'], content: 'Late-story only.' }),
  E({ kind: 'character', title: 'The Saint Reputation', keys: ['The Saint'], content: 'People say he is patient.' }),
  E({ kind: 'character', title: 'Childhood', keys: ['childhood'], content: 'An unstable childhood by the water.' }),
  E({ kind: 'character', title: 'Event: The Night Tide', keys: ['night tide'], content: 'The night the harbour flooded.' }),
  E({ kind: 'character', title: 'Lighthouse Office', keys: ['lighthouse'], content: 'Mira Castell works from the lighthouse office.' }),
  // Titled as a person, written about somebody else.
  E({ kind: 'character', title: 'Anna Castell', keys: ['Mira Castell', 'Mira'], content: 'Mira Castell keeps the lighthouse and the ledgers.' }),
  // The same person twice.
  E({ kind: 'character', title: 'Mira Castell / Keeper', keys: ['Keeper'], content: 'Mira Castell, again, from a second file.' }),
  // Switched off.
  E({ kind: 'character', title: 'Silas Grey', enabled: false, keys: ['Silas Grey'], content: 'Silas Grey arrives in the last act.' }),
  E({ kind: 'place', title: 'The Lighthouse', keys: ['lighthouse'], content: 'Mira Castell’s lighthouse stands above the rocks.' }),
  E({ kind: 'place', title: 'Dario’s Warehouse', keys: ['warehouse'], content: 'Cold, locked, watched.' }),
  E({ kind: 'faction', title: 'Crane Syndicate', keys: ['Crane syndicate'], content: 'Tobias Crane’s people. Loud, quick, careless.' }),
  E({ kind: 'rule', title: 'Harbour Law', keys: ['law'], content: 'No blades on the pier. Everyone knows Dario enforces it.' }),
  E({ kind: 'direction', title: 'Pacing RULE', constant: true, keys: ['pace'], content: 'Slow burn. Mira Castell appears at most once a scene.' }),
  E({ kind: 'item', title: 'The Brass Key', keys: ['brass key'], content: 'Opens the warehouse.' }),
];
const LEAD = { id: 'c-dario', name: 'Dario Vance', nickname: '', description: 'Dario runs the harbour. Tobias Crane wants it. Pell owes him a favour.', personality: '', scenario: '', first_message: 'The ferry horn sounds. Oren Hale waves from the deck.' };
const NOT_PEOPLE = ['Vancetti Family', 'How Patrick Communicates', 'Abandonment Wound', 'Established Devotion Regression', 'The Saint Reputation', 'Childhood', 'Event: The Night Tide', 'Lighthouse Office', 'Anna Castell'];

console.log('A  only people are cast');
{
  const d = composeSource(PACKAGE, { leadCards: [LEAD], opening: LEAD.first_message });
  const castNames = d.casting.map((r) => r.name);
  for (const t of NOT_PEOPLE) {
    ok(`"${t}" is not in Casting`, !castNames.includes(t) && !d.casting.some((r) => r.entryIds.includes(PACKAGE.find((e) => e.title === t).id)));
  }
  ok('and each of them is still shown in a section', NOT_PEOPLE.every((t) => d.sections.some((s) => s.items.some((i) => i.title === t))));
  ok('a heading about somebody lands in Background & Premise',
    d.sections.find((s) => s.id === 'backstory').items.some((i) => i.title === 'Abandonment Wound'));
  ok('a person-titled entry about someone else lands in Other, and says why',
    d.sections.find((s) => s.id === 'other').items.some((i) => i.title === 'Anna Castell' && /someone else/.test(i.note)));
  ok('real people are cast', ['Mira Castell', 'Oren Hale', 'Tobias Crane', 'Pell'].every((x) => castNames.includes(x)), castNames.join(', '));
  ok('an alias after a colon is not part of the name', nameFromTitle('Oren Hale: The Ferryman').name === 'Oren Hale');
  ok('nor after a slash or in brackets', nameFromTitle('Izuku Midoriya / Deku').name === 'Izuku Midoriya' && nameFromTitle('Kurogiri (Oboro)').name === 'Kurogiri');
  ok('a labelled heading is not a name', !nameFromTitle('WORLD — Quirk System').name && !nameFromTitle('User Persona — Reiko').name);
  ok('one person described twice is one row', castNames.filter((x) => x === 'Mira Castell').length === 1
    && d.casting.find((r) => r.name === 'Mira Castell').entryIds.length === 2);
  ok('the lead card is the lead, and backed by its card', d.casting[0].characterId === LEAD.id && d.casting[0].suggested === 'lead');
  ok('lore-backed people cannot lead', d.casting.filter((r) => r.backing === 'lore').every((r) => !r.canLead));
  ok('nothing invented', d.invented === 0);
}

console.log('\nB  a new story still gets evidence, with no conversation');
{
  const d = composeSource(PACKAGE, { leadCards: [LEAD], opening: LEAD.first_message });
  const row = (x) => d.casting.find((r) => r.name === x);
  ok('the draft knows it is for a new story', d.context === 'new');
  ok('somebody named in the opening says so', row('Oren Hale').why.some((w) => /opening/.test(w)), row('Oren Hale').why.join('; '));
  ok('somebody the lead’s card names says so', row('Tobias Crane').why.some((w) => /card names them/.test(w)), row('Tobias Crane').why.join('; '));
  ok('every suggestion carries its reasons', d.casting.every((r) => r.why.length > 0));
  ok('nobody is Main on thin evidence', !d.casting.some((r) => r.backing === 'lore' && r.suggested === 'main'),
    d.casting.map((r) => `${r.name}:${r.suggested}`).join(' '));
  ok('weak evidence is Known, not invented importance', row('Pell').suggested === 'known' || row('Pell').suggested === 'background', row('Pell').suggested);
  ok('somebody switched off is Known', row('Silas Grey').suggested === 'known' && row('Silas Grey').why.includes('switched off in the source'));
  ok('without a lead it still reads the source', composeSource(PACKAGE, {}).casting.length >= 5);
}

console.log('\nC  an existing story adds its conversation as evidence');
{
  const transcript = 'Mira Castell said nothing. '.repeat(45) + 'Pell laughed.';
  const d = composeSource(PACKAGE, { storyCards: [{ ...LEAD, story_role: 'lead' }], transcript });
  const row = (x) => d.casting.find((r) => r.name === x);
  ok('the draft knows it is for an existing story', d.context === 'existing');
  ok('somebody the story keeps naming rises', ['main', 'supporting'].includes(row('Mira Castell').suggested), `${row('Mira Castell').suggested}: ${row('Mira Castell').why.join('; ')}`);
  ok('and the count is in the reasons', row('Mira Castell').why.some((w) => /mentioned 45 times/.test(w)));
  ok('a surname that is somebody’s whole family is not counted as them',
    composeSource([E({ kind: 'character', title: 'Ana Todo', keys: ['Ana Todo'], content: 'Ana Todo.' }), E({ kind: 'character', title: 'Ben Todo', keys: ['Ben Todo'], content: 'Ben Todo.' })],
      { storyCards: [{ ...LEAD, story_role: 'lead' }], transcript: 'Todo Todo Todo Todo Todo Todo' }).casting.filter((r) => r.backing === 'lore').every((r) => r.mentions === 0));
  ok('a word inside "don’t" is not a name', composeSource([E({ kind: 'character', title: 'Don Raffaele Costa', keys: ['Costa'], content: 'At seventeen, Don Raffaele Costa took him in.' })],
    { storyCards: [{ ...LEAD, story_role: 'lead' }], transcript: "don't ".repeat(70) }).casting.find((r) => r.name === 'Don Raffaele Costa').mentions === 0);
}

console.log('\nC2 somebody already cast through another source is not suggested twice');
{
  const d = composeSource(PACKAGE, {
    storyCards: [{ ...LEAD, story_role: 'lead' }],
    storyNpcs: [{ entry_id: 'other-book-entry', title: 'Mira Castell / Keeper of the Light', role: 'supporting' }],
  });
  const mira = d.casting.find((r) => r.name === 'Mira Castell');
  ok('they default to Known here', mira.suggested === 'known', mira.suggested);
  ok('and say where they already are', /already in the cast as supporting/.test(mira.why[0]) && mira.alreadyCast?.entryId === 'other-book-entry');
}

console.log('\nD  cast states');
{
  ok('the six states exist', ['lead', 'main', 'supporting', 'background', 'known', 'excluded'].every((r) => ROLES.includes(r)));
  ok('"out" from older drafts means excluded', normalizeRole('out') === 'excluded');
  ok('nonsense is not a state', normalizeRole('boss') === null);
}

console.log('\nE  what material is about');
{
  const d = composeSource(PACKAGE, { leadCards: [LEAD], opening: LEAD.first_message });
  const link = (title, target) => d.links.find((l) => l.entryTitle === title && l.targetName === target);
  ok('a place named for the lead links to the lead’s card', link('Dario’s Warehouse', 'Dario Vance')?.confidence === 'high' && link('Dario’s Warehouse', 'Dario Vance')?.characterId === LEAD.id);
  ok('a faction whose first sentence names somebody links to them', link('Crane Syndicate', 'Tobias Crane')?.approved === true);
  ok('a lore-backed target is an entry link, not a card', !!link('The Lighthouse', 'Mira Castell')?.aboutId);
  ok('a rule that names somebody in passing is not about them', !link('Harbour Law', 'Dario Vance'));
  ok('low confidence is never pre-approved', d.links.filter((l) => l.confidence === 'low').every((l) => !l.approved));
  ok('people are not linked to each other here', !d.links.some((l) => d.casting.some((r) => r.entryIds.includes(l.entryId))));
}

// ------------------------------------------------------------- the database
const dir = mkdtempSync(join(tmpdir(), 'tipsy-compose-'));
const db = open(join(dir, 'compose.db'));
const bookA = db.createLorebook('Harbour — people and places', '');
const bookB = db.createLorebook('Harbour — the war', '');
const ids = {};
for (const e of PACKAGE) {
  const { id: _, lorebook_id: __, ...rest } = e;
  ids[e.title] = db.saveEntry(bookA, { ...rest, order: 100 });
}
ids.war = db.saveEntry(bookB, { kind: 'character', title: 'Captain Ilse Marr', keys: ['Ilse Marr'], content: 'Captain Ilse Marr commands the blockade.', order: 100 });
const dario = db.writeCharacter({ name: 'Dario Vance', description: LEAD.description, firstMessage: LEAD.first_message });
const other = db.writeCharacter({ name: 'Mira Castell', description: 'A card of her own.' });
const entryRows = () => db.raw.prepare('SELECT * FROM lore_entries ORDER BY id').all();
const fingerprint = () => createHash('sha256').update(JSON.stringify(entryRows())).digest('hex');
const count = (t) => db.raw.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;

// On the final cast table a cast member is a person Nexus knows. The people
// this section casts are organised first, the way a person would have to.
{
  const people = new Map();
  for (const [title, name] of [['Mira Castell', 'Mira Castell'], ['Mira Castell / Keeper', 'Mira Castell'], ['Oren Hale: The Ferryman', 'Oren Hale'], ['Tobias Crane', 'Tobias Crane'], ['Pell', 'Pell'], ['Silas Grey', 'Silas Grey'], ['war', 'Captain Ilse Marr']]) {
    if (people.has(name)) { setEntrySemantics(db, { entryId: ids[title], scope: 'entity', category: 'profile', definesEntityId: people.get(name), origin: 'manual', status: 'approved', confidence: 'high' }); continue; }
    const who = createEntity(db, { type: 'person', name, aliases: [] });
    people.set(name, who);
    declareInSource(db, { lorebookId: title === 'war' ? bookB : bookA, entityId: who, localRef: name.toLowerCase().replace(/\W+/g, '-'), localName: name, origin: 'manual', status: 'approved' });
    setEntrySemantics(db, { entryId: ids[title], scope: 'entity', category: 'profile', definesEntityId: who, origin: 'manual', status: 'approved', confidence: 'high' });
  }
}

console.log('\nF  applying a reviewed composition');
{
  const before = { fp: fingerprint(), entries: count('lore_entries'), characters: count('characters'), semantics: count('entry_semantics') };
  const sid = db.createStory({ title: 'Harbour', characterIds: [dario], lorebookIds: [bookB] });
  db.setStoryLorebookRecursion(sid, bookB, 'block');
  db.addMessage({ storyId: sid, role: 'assistant', content: 'The ferry horn sounds.' });
  const msgsBefore = db.raw.prepare('SELECT id, content FROM messages WHERE story_id=?').all(sid);

  const out = applyToStory(db, sid, {
    lorebookIds: [bookA],
    casting: [
      { entryId: ids['Mira Castell'], role: 'main' },
      { entryId: ids['Oren Hale: The Ferryman'], role: 'supporting' },
      { entryId: ids['Tobias Crane'], role: 'known' },
      { entryId: ids.Pell, role: 'excluded' },
      { entryId: ids['Silas Grey'], role: 'out' },
    ],
    links: [
      { entryId: ids['Dario’s Warehouse'], characterId: dario },
      { entryId: ids['The Lighthouse'], aboutId: ids['Mira Castell'] },
    ],
  });
  const npcs = db.storyNpcs(sid);
  ok('the source is connected', db.getStory(sid).lorebookIds.includes(bookA), JSON.stringify(out));
  ok('the book already there keeps its recursion setting', db.storyLorebookSettings(sid).find((r) => r.lorebook_id === bookB)?.recursion === 'block');
  ok('reviewed cast is stored with its parts', npcs.length === 2
    && npcs.find((x) => x.entry_id === ids['Mira Castell'])?.role === 'main'
    && npcs.find((x) => x.entry_id === ids['Oren Hale: The Ferryman'])?.role === 'supporting');
  ok('Known, Excluded and "out" are not stored as cast', !npcs.some((x) => [ids['Tobias Crane'], ids.Pell, ids['Silas Grey']].includes(x.entry_id)));
  // Since the semantic model (P1): links ticked in review are kept as evidence,
  // never as semantics and never in the retired link tables.
  const evidence = db.raw.prepare("SELECT entry_id, target_id, derived_origin, status FROM legacy_entry_links WHERE source='composition-review'").all();
  ok('links ticked in review are kept as evidence', evidence.some((x) => x.entry_id === ids['Dario’s Warehouse'] && x.target_id === dario)
    && evidence.some((x) => x.entry_id === ids['The Lighthouse'] && x.target_id === ids['Mira Castell']));
  ok('as unconfirmed evidence, not semantics', evidence.every((x) => x.status === 'legacy' && x.derived_origin === 'composer-inferred')
    && count('entry_relations') === 0 && count('entry_semantics') === before.semantics);
  ok('and nothing new is written to the retired link tables', count('entry_character_links') === 0 && count('entry_entry_links') === 0);
  ok('no entry was copied or changed', fingerprint() === before.fp && count('lore_entries') === before.entries);
  ok('no character card was created', count('characters') === before.characters);
  ok('the story’s messages are untouched', JSON.stringify(db.raw.prepare('SELECT id, content FROM messages WHERE story_id=?').all(sid)) === JSON.stringify(msgsBefore));
  ok('the lead card is untouched', db.getStory(sid).characters.length === 1 && db.getStory(sid).characters[0].story_role === 'lead');

  applyToStory(db, sid, { casting: [{ entryId: ids['Mira Castell'], role: 'known' }] });
  ok('moving somebody to Known takes them out of the cast', !db.storyNpcs(sid).some((x) => x.entry_id === ids['Mira Castell']));

  console.log('\nG  what apply refuses, whoever asks');
  for (const t of NOT_PEOPLE) {
    ok(`"${t}" cannot be written into the cast`, throws(() => applyToStory(db, sid, { casting: [{ entryId: ids[t], role: 'background' }] }), /not a person/));
  }
  ok('nor can anything from a book the story does not use',
    throws(() => applyToStory(db, db.createStory({ title: 'Empty', characterIds: [dario] }), { casting: [{ entryId: ids.Pell, role: 'background' }] }), /not using/));
  ok('a lore-backed person cannot lead', throws(() => applyToStory(db, sid, { casting: [{ entryId: ids.Pell, role: 'lead' }] }), /character card/));
  ok('two leads are refused', throws(() => planComposition(db, { casting: [{ characterId: dario, role: 'lead' }, { characterId: other, role: 'lead' }] }), /one lead/));
  ok('a link to material the story does not read is refused',
    throws(() => applyToStory(db, db.createStory({ title: 'Empty 2', characterIds: [dario] }), { links: [{ entryId: ids.Pell, characterId: dario }] }), /not using/));
  const pellCount = db.storyNpcs(sid).length;
  ok('a refused apply writes nothing', pellCount === 1);

  console.log('\nH  a failure halfway through undoes all of it');
  const sid2 = db.createStory({ title: 'Rollback', characterIds: [dario] });
  const plan = planComposition(db, { lorebookIds: [bookA], casting: [{ entryId: ids.Pell, role: 'background' }] });
  let threw = false;
  // The failure is a real foreign-key violation on the last write: a cast row
  // for an entry that does not exist, after the source and cast are written.
  try {
    db.transaction(() => writeComposition(db, sid2, { ...plan, npcs: [...plan.npcs, { entryId: 'no-such-entry', role: 'main' }] }));
  } catch { threw = true; }
  ok('the failing write threw', threw);
  ok('the source it had already connected was rolled back', db.getStory(sid2).lorebookIds.length === 0);
  ok('the cast it had already written was rolled back', db.storyNpcs(sid2).length === 0);

  console.log('\nI  saving the story sheet keeps what it did not change');
  const sid3 = db.createStory({ title: 'Sheet', characterIds: [dario, other], lorebookIds: [bookA, bookB] });
  db.setStoryLorebookRecursion(sid3, bookA, 'block');
  db.setStoryLorebooks(sid3, [bookB, bookA]);
  ok('re-saving the same books keeps a recursion setting', db.storyLorebookSettings(sid3).find((r) => r.lorebook_id === bookA)?.recursion === 'block');
  db.setStoryCharacters(sid3, [other, dario]);
  ok('re-saving the cast in another order does not change the lead', db.getStory(sid3).characters[0].id === dario);
  db.setStoryCharacterRole(sid3, other, 'lead');
  ok('naming a new lead demotes the old one', db.getStory(sid3).characters.filter((c) => c.story_role === 'lead').length === 1 && db.getStory(sid3).characters[0].id === other);

  console.log('\nJ  taking a source out');
  applyToStory(db, sid, { casting: [{ entryId: ids['Mira Castell'], role: 'main' }] });
  applyToStory(db, sid, { casting: [{ entryId: ids.war, role: 'background' }] });
  const preview = sourceRemovalPreview(db, sid, bookA, composeSource);
  ok('the preview names the people who would leave the cast, by name not title', preview.castLeaving.map((x) => x.name).sort().join() === ['Mira Castell', 'Oren Hale'].sort().join(), JSON.stringify(preview.castLeaving));
  ok('and counts what the story would lose by section', preview.loses.some((l) => l.id === 'places' && l.count === 2) && preview.loses.some((l) => l.id === 'people' && l.count >= 4));
  ok('and says what it keeps', preview.keeps.some((k) => /message/.test(k)) && preview.keeps.some((k) => /Library/.test(k)));
  const fp = fingerprint();
  const linksBefore = count('legacy_entry_links');
  const msgs = count('messages');
  removeSource(db, sid, bookA);
  ok('the story no longer reads the source', !db.getStory(sid).lorebookIds.includes(bookA));
  ok('the source is still in the library', !!db.getLorebook(bookA));
  ok('every entry is still there, unchanged', fingerprint() === fp);
  ok('cast from that source left the story', !db.storyNpcs(sid).some((x) => x.lorebook_id === bookA));
  ok('cast from other sources stayed', db.storyNpcs(sid).some((x) => x.entry_id === ids.war));
  ok('link evidence about the material is kept', count('legacy_entry_links') === linksBefore);
  ok('no message was touched', count('messages') === msgs);
  ok('the other book keeps its recursion setting', db.storyLorebookSettings(sid).find((r) => r.lorebook_id === bookB)?.recursion === 'block');
  ok('removing a source the story does not have is refused', throws(() => removeSource(db, sid, bookA), /not part/));

  console.log('\nL  Known and Excluded are different things');
  const fpL = fingerprint();
  const charsL = count('characters');
  const sA = db.createStory({ title: 'Exclusion A', characterIds: [dario], lorebookIds: [bookA] });
  const sB = db.createStory({ title: 'Exclusion B', characterIds: [dario], lorebookIds: [bookA] });
  db.addMessage({ storyId: sA, role: 'assistant', content: 'The ferry horn sounds.' });
  const msgsA = JSON.stringify(db.raw.prepare('SELECT id, content FROM messages WHERE story_id=?').all(sA));
  const eligible = (s, id) => db.entriesForStory(s).some((e) => e.id === id);
  // An organised person is excluded AS a person, not entry by entry.
  const excludedHere = (s, id) => db.storyExclusionIds(s).has(id) || !!db.raw.prepare(`SELECT 1 x FROM story_entity_exclusions x
    JOIN entry_semantics se ON se.defines_entity_id = x.entity_id AND se.status='approved' WHERE x.story_id=? AND se.entry_id=?`).get(s, id);
  const mira = [ids['Mira Castell'], ids['Mira Castell / Keeper']];

  applyToStory(db, sA, { casting: [{ entryId: ids['Oren Hale: The Ferryman'], role: 'known' }] });
  ok('Known: not in the cast', !db.storyNpcs(sA).some((x) => x.entry_id === ids['Oren Hale: The Ferryman']));
  ok('Known: still eligible for the story', eligible(sA, ids['Oren Hale: The Ferryman']));

  applyToStory(db, sA, { casting: [{ entryId: ids['Oren Hale: The Ferryman'], role: 'excluded' }] });
  ok('Excluded: not in the cast', !db.storyNpcs(sA).some((x) => x.entry_id === ids['Oren Hale: The Ferryman']));
  ok('Excluded: not eligible for the story', !eligible(sA, ids['Oren Hale: The Ferryman']));
  ok('Excluded is recorded for this story', excludedHere(sA, ids['Oren Hale: The Ferryman']));
  ok('the same entry is still eligible in another story', eligible(sB, ids['Oren Hale: The Ferryman']));
  ok('the entry is still enabled in its source', db.listEntries(bookA).find((e) => e.id === ids['Oren Hale: The Ferryman']).enabled === true);

  applyToStory(db, sA, { casting: [{ entryId: ids['Mira Castell'], entryIds: mira, role: 'main' }] });
  applyToStory(db, sA, { casting: [{ entryId: ids['Mira Castell'], entryIds: mira, role: 'excluded' }] });
  ok('excluding someone in the cast takes them out of it', !db.storyNpcs(sA).some((x) => mira.includes(x.entry_id)));
  ok('a person described in two entries is excluded as one person', mira.every((id) => !eligible(sA, id)));

  applyToStory(db, sA, { casting: [{ entryId: ids['Oren Hale: The Ferryman'], role: 'known' }] });
  ok('moving back to Known restores eligibility', eligible(sA, ids['Oren Hale: The Ferryman']));
  applyToStory(db, sA, { casting: [{ entryId: ids['Mira Castell'], entryIds: mira, role: 'supporting' }] });
  ok('putting an excluded person in the cast lets them back in', mira.every((id) => eligible(sA, id)) && db.storyNpcs(sA).some((x) => x.entry_id === ids['Mira Castell']));

  applyToStory(db, sA, { exclude: [ids['Harbour Law']] });
  ok('material that is not a person can be excluded too', !eligible(sA, ids['Harbour Law']) && eligible(sB, ids['Harbour Law']));
  ok('excluding it made nobody a cast member', !db.storyNpcs(sA).some((x) => x.entry_id === ids['Harbour Law']));
  applyToStory(db, sA, { include: [ids['Harbour Law']] });
  ok('and let back in', eligible(sA, ids['Harbour Law']));
  ok('asking to exclude and keep the same entry at once is refused',
    throws(() => applyToStory(db, sA, { exclude: [ids.Pell], include: [ids.Pell] }), /both/));
  ok('an entry from a book the story does not read cannot be excluded',
    throws(() => applyToStory(db, sA, { exclude: [ids.war] }), /not part of a source/));

  db.setStoryCharacters(sA, [dario]);
  db.updateStory(sA, { title: 'Exclusion A, renamed' });
  applyToStory(db, sA, { casting: [{ entryId: ids.Pell, role: 'excluded' }] });
  db.setStoryLorebooks(sA, [bookA]);
  db.updateStory(sA, { title: 'Exclusion A, saved again', settings: { premise: 'edited' } });
  ok('an exclusion survives saving the story', excludedHere(sA, ids.Pell));
  applyToStory(db, sA, { lorebookIds: [bookB], casting: [{ entryId: ids.war, role: 'background' }] });
  ok('and adding another source', excludedHere(sA, ids.Pell));
  // Composed the way the server composes: with what is known about the
  // people, and who the story has left out as a person.
  const reread = composeSource(db.listEntries(bookA), {
    storyCards: db.getStory(sA).characters, storyNpcs: db.storyNpcs(sA), storyExclusions: db.storyExclusionIds(sA),
    semantics: semanticViews(db, db.listEntries(bookA)), excludedEntities: readCompositionMaterial(db, [bookA], { storyId: sA }).excludedEntities,
  });
  ok('reopening the review shows the saved exclusion', reread.casting.find((r) => r.name === 'Pell')?.suggested === 'excluded'
    && reread.casting.find((r) => r.name === 'Pell')?.current === 'excluded');
  ok('and Known as Known', reread.casting.find((r) => r.name === 'Oren Hale')?.suggested !== 'excluded');

  const sid4 = db.createStory({ title: 'Rollback 2', characterIds: [dario], lorebookIds: [bookA] });
  const plan4 = planComposition(db, { existingBookIds: [bookA], casting: [{ entryId: ids.Pell, role: 'excluded' }] });
  let threw4 = false;
  try { db.transaction(() => { writeComposition(db, sid4, plan4); db.setStoryNpc(sid4, 'no-such-entry', 'main'); }); } catch { threw4 = true; }
  ok('a failed apply leaves no exclusion behind', threw4 && db.storyExclusionIds(sid4).size === 0);

  const pvA = sourceRemovalPreview(db, sA, bookA, composeSource);
  // Pell is left out as a person, and that is the story's decision about him,
  // not about this source: it is not forgotten with the source. An entry
  // ignored as an entry is.
  applyToStory(db, sA, { exclude: [ids['Pacing RULE']] });
  const pvA2 = sourceRemovalPreview(db, sA, bookA, composeSource);
  ok('the removal preview names entry exclusions that will be forgotten', pvA2.exclusionsForgotten.some((x) => x.name === 'Pacing RULE'));
  ok('and does not pretend a person left out as a person goes with it', !pvA2.exclusionsForgotten.some((x) => x.name === 'Pell'));
  removeSource(db, sA, bookA);
  ok('leaving him out survives the source going', !!db.raw.prepare('SELECT 1 x FROM story_entity_exclusions WHERE story_id=?').get(sA));
  ok('removing the source forgets its exclusions', ![...db.storyExclusionIds(sA)].some((id) => Object.values(ids).includes(id) && id !== ids.war));
  ok('the other story is untouched by all of it', eligible(sB, ids.Pell) && db.storyExclusionIds(sB).size === 0);
  ok('no entry changed, no card created or deleted, no message touched', fingerprint() === fpL && count('characters') === charsL
    && JSON.stringify(db.raw.prepare('SELECT id, content FROM messages WHERE story_id=?').all(sA)) === msgsA);
}

// ----------------------------------------------------- the route, end to end
console.log('\nK  starting a story from a reviewed composition');
db.savePersona({ name: 'Only Persona', description: '' });
db.close();
const port = 8900 + Math.floor(Math.random() * 90);
const server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'compose.db') }, stdio: 'ignore' });
const base = `http://localhost:${port}`;
const J = (p, b, m = 'POST') => fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
try {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/api/library`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  const draft = await J('/api/compose', { lorebookIds: [bookA], characterIds: [dario] });
  ok('a draft without a story', draft.status === 200 && draft.body.context === 'new' && draft.body.casting.length >= 5, `${draft.status}`);

  const storiesBefore = (await J('/api/library', null, 'GET')).body.stories?.length ?? null;
  const bad = await J('/api/stories', {
    title: 'Should not exist', personaId: null, lorebookIds: [bookA],
    composition: { casting: [{ characterId: dario, role: 'lead' }, { entryId: ids['Vancetti Family'], role: 'background' }] },
  });
  const storiesAfterBad = (await J('/api/library', null, 'GET')).body.stories?.length ?? null;
  ok('a composition with a non-person in the cast is refused', bad.status === 400 && /not a person/.test(bad.body?.error || ''), bad.body?.error);
  ok('and no story was created', storiesBefore === storiesAfterBad, `${storiesBefore} → ${storiesAfterBad}`);

  const twoLeads = await J('/api/stories', { personaId: null, composition: { casting: [{ characterId: dario, role: 'lead' }, { characterId: other, role: 'lead' }] } });
  ok('two leads are refused at the route', twoLeads.status === 400);

  const good = await J('/api/stories', {
    title: 'Harbour, reviewed', personaId: null, lorebookIds: [bookA],
    composition: {
      casting: [
        { characterId: dario, role: 'lead' },
        { characterId: other, role: 'supporting' },
        { entryId: ids['Tobias Crane'], role: 'main' },
        { entryId: ids.Pell, role: 'known' },
      ],
      links: [{ entryId: ids['Crane Syndicate'], aboutId: ids['Tobias Crane'] }],
      recursion: { [bookA]: 'block' },
    },
  });
  ok('a reviewed story starts', good.status === 200 && !!good.body?.id, JSON.stringify(good.body));
  const story = (await J(`/api/stories/${good.body.id}`, null, 'GET')).body;
  const bible = (await J(`/api/stories/${good.body.id}/bible`, null, 'GET')).body;
  ok('"None" means no persona, even with exactly one saved', story.persona === null);
  ok('the lead is the chosen card', story.characters[0].id === dario && story.characters[0].story_role === 'lead');
  ok('a second card keeps the part it was given', story.characters.find((c) => c.id === other)?.story_role === 'supporting');
  ok('the lore-backed person is in the cast', bible.npcs.some((x) => x.entryId === ids['Tobias Crane'] && x.role === 'main'));
  ok('Known is not in the cast', !bible.npcs.some((x) => x.entryId === ids.Pell));
  ok('the chosen recursion setting is on the new source', bible.sources.connected.find((s) => s.id === bookA)?.recursion === 'block');
  ok('it opens on the lead’s greeting', story.messages.length === 1 && /ferry horn/.test(story.messages[0].content));

  console.log('\nM  the compiled request, through the real prompt route');
  const orenText = 'Oren Hale runs the last ferry';
  const ruleText = 'Slow burn. Mira Castell appears at most once a scene';
  const P = async (sid) => (await J(`/api/stories/${sid}/prompt`, null, 'GET')).body;
  const sent = (p, text) => p.messages.some((m) => m.content.includes(text));
  const traced = (p, id) => p.trace.find((t) => t.id === id);
  const start = await J('/api/stories', {
    title: 'Prompt check', personaId: null, lorebookIds: [bookA],
    composition: { casting: [{ characterId: dario, role: 'lead' }, { entryId: ids['Oren Hale: The Ferryman'], role: 'known' }] },
  });
  const ps = start.body.id;
  const storyB = (await J('/api/stories', { title: 'Prompt check B', personaId: null, lorebookIds: [bookA], composition: { casting: [{ characterId: dario, role: 'lead' }] } })).body.id;
  let p = await P(ps);
  const availableBefore = p.sources.lore.available.total;
  ok('Known: the greeting names Oren, so his entry fires', traced(p, ids['Oren Hale: The Ferryman'])?.fired === true);
  ok('Known: and his text is in the request sent to the model', sent(p, orenText));
  ok('an always-on rule is in the request', sent(p, ruleText));

  const ex = await J(`/api/stories/${ps}/compose`, { casting: [{ entryId: ids['Oren Hale: The Ferryman'], role: 'excluded' }], exclude: [ids['Pacing RULE']] });
  ok('excluding through the apply route works', ex.status === 200, JSON.stringify(ex.body));
  p = await P(ps);
  ok('Excluded: his text is not in the request, though the greeting still names him', !sent(p, orenText));
  ok('Excluded: his entry is not in the trace at all — never eligible, not merely unfired', !traced(p, ids['Oren Hale: The Ferryman']));
  ok('Excluded: two fewer entries were available', p.sources.lore.available.total === availableBefore - 2, `${availableBefore} → ${p.sources.lore.available.total}`);
  ok('an excluded always-on rule is not in the request', !sent(p, ruleText));
  const pB = await P(storyB);
  ok('the other story still sends both', sent(pB, orenText) && sent(pB, ruleText));

  await J(`/api/stories/${ps}`, { title: 'Prompt check, edited', characterIds: [dario] }, 'PATCH');
  p = await P(ps);
  ok('saving the story details keeps the exclusion', !sent(p, orenText));
  const bibleX = (await J(`/api/stories/${ps}/bible`, null, 'GET')).body;
  ok('the Story Bible lists what this story ignores', bibleX.excluded.some((x) => x.title === 'Oren Hale') && bibleX.excluded.some((x) => x.title === 'Pacing RULE'));
  const redraft = (await J('/api/compose', { lorebookIds: [bookA], storyId: ps })).body;
  ok('reopening the review shows Oren as excluded', redraft.casting.find((r) => r.name === 'Oren Hale')?.current === 'excluded');

  await J(`/api/stories/${ps}/compose`, { casting: [{ entryId: ids['Oren Hale: The Ferryman'], role: 'known' }], include: [ids['Pacing RULE']] });
  p = await P(ps);
  ok('restoring Known puts his text back in the request', sent(p, orenText) && traced(p, ids['Oren Hale: The Ferryman'])?.fired === true);
  ok('and the rule', sent(p, ruleText));

  const legacy = await J('/api/stories', { characterIds: [dario] });
  const legacyStory = (await J(`/api/stories/${legacy.body.id}`, null, 'GET')).body;
  ok('a caller that never asked still gets the one saved persona, as before', legacyStory.persona?.name === 'Only Persona');
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* the OS may still hold it briefly */ }
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail) process.exitCode = 1;
