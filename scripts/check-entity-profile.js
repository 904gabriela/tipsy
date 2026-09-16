// What belongs to a person, and what only stands near them.
//
//   node scripts/check-entity-profile.js
//
// Throwaway databases and invented material. The rule this file exists to hold:
// an entry that DEFINES someone belongs to them, with no second relation needed,
// and an entry that merely mentions them does not — however much of the source
// around it is about them.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../src/db/index.js';
import { entityProfile, CATEGORY_GROUP } from '../src/semantics/profile.js';
import { createEntity, declareInSource, setEntrySemantics, setRelation, setSourceRole, bindCharacterEntity, bindPersonaEntity } from '../src/semantics/store.js';

let pass = 0; let fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? `  — ${d}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? `  — ${d}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);
const tmp = () => join(mkdtempSync(join(tmpdir(), 'tipsy-profile-')), 'p.db');

/** Everything a page would show, flattened, so a test can ask "is it there?". */
const titles = (groups) => groups.flatMap((g) => [...g.items, ...g.sub.flatMap((s) => s.items)]).map((x) => x.title);
const itemsOf = (groups) => groups.flatMap((g) => [...g.items, ...g.sub.flatMap((s) => s.items)]);

// ------------------------------------------------------------------ a world

const db = open(tmp());
const book = db.createLorebook('Nora Vale — Knowledge', '');
const storyBook = db.createLorebook('The Quay — this story', '');
const otherBook = db.createLorebook('Another Life — not attached', '');

const entry = (bookId, title, content, extra = {}) =>
  db.saveEntry(bookId, { order: 100, enabled: true, constant: false, probability: 100, keys: [], kind: 'note', title, content, ...extra });

const E = {
  profile: entry(book, 'Nora Vale', 'Nora Vale runs the ferry office and keeps the books.'),
  childhood: entry(book, 'Childhood', 'She grew up above a bakery on the quay.'),
  fear: entry(book, 'Deepest Fear', 'That the office closes and nobody notices.'),
  quirkA: entry(book, 'Tide Sense', 'She reads the water the way other people read a room.'),
  quirkB: entry(book, 'Limits', 'It fails in still water, and in anything with a roof.'),
  ilya: entry(book, 'Ilya Vale', 'Ilya Vale keeps the boats running. Nora trusts him with the engines.'),
  weather: entry(book, 'Weather', 'It rains for most of autumn.'),
  disabled: entry(book, 'Old Rumour', 'A story about the Vales that never checked out.', { enabled: false }),
  storyOnly: entry(storyBook, 'Shoulder injury', 'Her left shoulder has not been right since the winter.'),
  elsewhere: entry(otherBook, 'Another version of Nora', 'In that telling she never left the quay at all.'),
};

const nora = createEntity(db, { type: 'person', name: 'Nora Vale', aliases: ['Nora'] });
const ilya = createEntity(db, { type: 'person', name: 'Ilya Vale', aliases: ['Ilya'] });
const storyId = db.createStory({ title: 'The Quay', personaId: null, lorebookIds: [book, storyBook] });

// A source declares who it speaks of before any entry may define them.
for (const [bookId, entityId, ref, nm] of [[book, nora, 'nora', 'Nora Vale'], [book, ilya, 'ilya', 'Ilya Vale'],
  [storyBook, nora, 'nora', 'Nora Vale'], [otherBook, nora, 'nora', 'Nora Vale']]) {
  declareInSource(db, { lorebookId: bookId, entityId, localRef: ref, localName: nm, origin: 'manual', status: 'approved' });
}

const approve = (entryId, semantics, relations = []) => {
  setEntrySemantics(db, { entryId, origin: 'manual', status: 'approved', confidence: 'high', ...semantics });
  for (const r of relations) setRelation(db, { entryId, entityId: r.entity, relation: r.relation, origin: 'manual', status: 'approved' });
};

// The profile entry DEFINES Nora and says nothing else. This is the invariant.
approve(E.profile, { scope: 'entity', category: 'profile', definesEntityId: nora });
approve(E.childhood, { scope: 'entity', category: 'backstory' }, [{ entity: nora, relation: 'subject' }]);
approve(E.fear, { scope: 'entity', category: 'psychology' }, [{ entity: nora, relation: 'subject' }]);
approve(E.quirkA, { scope: 'entity', category: 'ability', displayPath: ['Tide Sense'] }, [{ entity: nora, relation: 'subject' }]);
approve(E.quirkB, { scope: 'entity', category: 'ability', displayPath: ['Tide Sense', 'How it fails'] }, [{ entity: nora, relation: 'subject' }]);
// Ilya's own entry, standing in Nora's source and mentioning her.
approve(E.ilya, { scope: 'entity', category: 'profile', definesEntityId: ilya }, [{ entity: nora, relation: 'related' }]);
// World material in the same source, about nobody.
approve(E.weather, { scope: 'world', category: 'background' });
approve(E.disabled, { scope: 'entity', category: 'backstory' }, [{ entity: nora, relation: 'subject' }]);
approve(E.storyOnly, { scope: 'entity', category: 'other', displayPath: ['Injuries'] }, [{ entity: nora, relation: 'subject' }]);
approve(E.elsewhere, { scope: 'entity', category: 'backstory' }, [{ entity: nora, relation: 'subject' }]);

// The source travels with Nora; the story's own material belongs to the story.
setSourceRole(db, { lorebookId: book, role: 'entity-material', origin: 'manual', status: 'approved', subjectEntityId: nora });
setSourceRole(db, { lorebookId: storyBook, role: 'mixed', origin: 'manual', status: 'approved', ownerStoryId: storyId });
setSourceRole(db, { lorebookId: otherBook, role: 'entity-material', origin: 'manual', status: 'approved', subjectEntityId: nora });

// ------------------------------------------------------------ the invariant

section('what belongs to a person');
const p = entityProfile(db, nora);
ok('the profile exists', !!p && p.entity.name === 'Nora Vale', p?.entity?.type);
const own = titles(p.knowledge.reusable);
ok('an entry that DEFINES her is her own material, with no second relation',
  own.includes('Nora Vale'), own.join(', '));
ok('an entry whose approved subject is her is her own material', own.includes('Childhood') && own.includes('Deepest Fear'));
ok('an entry that only mentions her is not', !own.includes('Ilya Vale'), own.join(', '));
ok('world material in her source is not hers either', !own.includes('Weather'));
ok('a source travelling with her does not make every entry about her',
  !own.includes('Ilya Vale') && !own.includes('Weather'), `${own.length} entries are hers`);
ok('each entry appears once', own.length === new Set(own).size, own.join(', '));

section('defining and being about, at the same time');
// The canonical form P5.1 accepts: defines X, and a subject relation to X too.
setRelation(db, { entryId: E.profile, entityId: nora, relation: 'subject', origin: 'manual', status: 'approved' });
const both = entityProfile(db, nora);
const bothTitles = titles(both.knowledge.reusable);
ok('an entry that defines her AND is about her is still one entry',
  bothTitles.filter((t) => t === 'Nora Vale').length === 1, bothTitles.join(', '));
db.raw.prepare("DELETE FROM entry_relations WHERE entry_id=? AND relation='subject'").run(E.profile);
ok('and taking the relation away again leaves the defining entry in place',
  titles(entityProfile(db, nora).knowledge.reusable).includes('Nora Vale'));

section('proposed is not approved');
const loose = entry(book, 'A guess', 'Someone said she keeps a boat of her own.');
setEntrySemantics(db, { entryId: loose, scope: 'entity', category: 'backstory', origin: 'inferred', status: 'proposed', confidence: 'low' });
setRelation(db, { entryId: loose, entityId: nora, relation: 'subject', origin: 'inferred', status: 'proposed' });
ok('an unresolved entry is not on her page', !titles(entityProfile(db, nora).knowledge.reusable).includes('A guess'));

section('reusable, and this story');
const inStory = entityProfile(db, nora, { storyId });
ok('the library view shows only reusable material',
  !titles(p.knowledge.reusable).includes('Shoulder injury') && p.knowledge.story.length === 0);
ok('a story view keeps the two apart',
  titles(inStory.knowledge.story).includes('Shoulder injury')
  && !titles(inStory.knowledge.reusable).includes('Shoulder injury'),
  `${inStory.counts.reusable} reusable, ${inStory.counts.story} in story`);
ok('reusable material the story carries is still there', titles(inStory.knowledge.reusable).includes('Childhood'));
ok('a source the story has not attached stays out of it',
  !titles(inStory.knowledge.reusable).includes('Another version of Nora'), titles(inStory.knowledge.reusable).join(', '));
ok('and out of the library view too, unless it is attached to nothing',
  titles(p.knowledge.reusable).includes('Another version of Nora'),
  'the library shows every reusable source about her');

section('groups');
const groups = entityProfile(db, nora).knowledge.reusable;
const tide = groups.find((g) => g.name === 'Tide Sense');
ok('a display group carries its own name', !!tide, groups.map((g) => g.name).join(', '));
ok('a nested path becomes a group inside it', tide?.sub?.[0]?.name === 'How it fails' && tide.sub[0].items[0].title === 'Limits');
ok('the group counts everything under it', tide?.count === 2);
ok('an entry with no group of its own falls under its category',
  groups.find((g) => g.name === CATEGORY_GROUP.psychology)?.items.some((x) => x.title === 'Deepest Fear'),
  groups.map((g) => `${g.name}(${g.count})`).join(', '));
ok('a display group never becomes a category', itemsOf(groups).every((x) => Object.keys(CATEGORY_GROUP).includes(x.category)));

section('the people around her');
const near = entityProfile(db, nora).related;
ok('someone whose own entry mentions her is a related person, not her material',
  near.some((r) => r.name === 'Ilya Vale'), near.map((r) => r.name).join(', '));
ok('related people are named, never shown as an id', near.every((r) => r.name && !/^[0-9a-f-]{16,}$/.test(r.name)));

section('what is quietly wrong');
ok('a disabled entry is still shown, and still says it is off',
  itemsOf(entityProfile(db, nora).knowledge.reusable).find((x) => x.title === 'Old Rumour')?.activation.enabled === false);
ok('the page counts what is switched off', entityProfile(db, nora).attention.disabled >= 1);
db.saveEntry(book, { id: E.fear, title: 'Deepest Fear', content: 'Changed after it was approved.', keys: [], order: 100, enabled: true, constant: false, probability: 100, kind: 'note' });
const after = entityProfile(db, nora);
const fear = itemsOf(after.knowledge.reusable).find((x) => x.title === 'Deepest Fear');
ok('an entry whose text changed says it needs another look', fear?.needsRecheck === true);
ok('and its approved reading is still shown', fear?.category === 'psychology' && after.attention.recheck === 1);

section('cards, personas, and neither');
const cardId = db.saveCharacter({ name: 'Nora Vale', description: 'Ferry clerk. Exacting.', personality: 'Patient, dry.', scenario: '', firstMessage: '', exampleDialogue: '', alternateGreetings: [], systemPrompt: '', postHistoryInstructions: '', creatorNotes: '', tags: [], spec: 'chara_card_v2' });
db.raw.prepare('UPDATE characters SET appearance=? WHERE id=?').run('Short, weathered.', cardId);
bindCharacterEntity(db, cardId, nora);
const withCard = entityProfile(db, nora);
ok('a bound character gives the page its core', withCard.core?.from === 'character' && /Ferry clerk/.test(withCard.core.identity));
ok('the resource is named, and kept apart from the entity', withCard.resources.character?.name === 'Nora Vale' && withCard.entity.id === nora);
const bare = entityProfile(db, ilya);
ok('a person with no card still has a page', !!bare && bare.entity.name === 'Ilya Vale');
ok('and nothing is invented for them', bare.resources.character === null && bare.core === null);
ok('their own defining entry is their profile', titles(bare.knowledge.reusable).includes('Ilya Vale'), titles(bare.knowledge.reusable).join(', '));

const personaId = db.savePersona({ name: 'Reiko', description: 'Quiet, watchful.', appearance: 'Tall.', personality: 'Wry.' });
const reiko = createEntity(db, { type: 'person', name: 'Reiko Ryuusui', aliases: [] });
bindPersonaEntity(db, personaId, reiko);
const personaProfile = entityProfile(db, reiko);
ok('a persona has the same depth of page as a character',
  personaProfile.core?.from === 'persona' && /Quiet, watchful/.test(personaProfile.core.identity));
ok('a persona with no knowledge yet shows no empty groups', personaProfile.knowledge.reusable.length === 0);

section('nothing is written by reading');
const before = db.raw.prepare('SELECT COUNT(*) a FROM entry_semantics').get().a;
const rels = db.raw.prepare('SELECT COUNT(*) a FROM entry_relations').get().a;
entityProfile(db, nora);
entityProfile(db, nora, { storyId });
entityProfile(db, ilya);
ok('reading a profile writes nothing',
  db.raw.prepare('SELECT COUNT(*) a FROM entry_semantics').get().a === before
  && db.raw.prepare('SELECT COUNT(*) a FROM entry_relations').get().a === rels);
ok('an entity that does not exist is simply not there', entityProfile(db, 'no-such-entity') === null);

db.close();
console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exit(fail ? 1 : 0);
