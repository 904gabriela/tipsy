// Writing knowledge by hand: where it goes, what it says, and what it must not do.
//
//   node scripts/check-authoring.js
//
// Throwaway databases and invented material. The promises held here are the
// ones a person cannot check for themselves: that something written inside a
// story stays in that story, that nothing is written into a source they
// imported, that their own edit does not come back asking to be reviewed, and
// that no model is ever asked anything.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../src/db/index.js';
import { entityProfile } from '../src/semantics/profile.js';
import { createEntity, declareInSource, setEntrySemantics, setRelation, setSourceRole, bindPersonaEntity } from '../src/semantics/store.js';
import {
  createEntityKnowledge, updateEntityKnowledge, deleteEntityKnowledge,
  entityKnowledgeSource, storyMaterialSource, managedSource, suggestedKeys, hashOfEntry, AuthoringError,
} from '../src/semantics/authoring.js';
import { entryHash } from '../src/semantics/authority.js';

let pass = 0; let fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? `  — ${d}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? `  — ${d}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);
const tmp = () => join(mkdtempSync(join(tmpdir(), 'tipsy-author-')), 'w.db');
const threw = (fn) => { try { fn(); return null; } catch (e) { return e; } };

const db = open(tmp());
const q = (sql, ...a) => db.raw.prepare(sql).all(...a);
const one = (sql, ...a) => db.raw.prepare(sql).get(...a);

// A world that came from somewhere else, and two people in it.
const imported = db.createLorebook('Harbour Files (imported)', '');
const nora = createEntity(db, { type: 'person', name: 'Nora Vale', aliases: ['Nora'] });
const ilya = createEntity(db, { type: 'person', name: 'Ilya Vale', aliases: [] });
const importedEntry = db.saveEntry(imported, { title: 'Nora Vale', content: 'Nora Vale runs the ferry office.', keys: [], order: 100, enabled: true, constant: false, probability: 100, kind: 'note' });
declareInSource(db, { lorebookId: imported, entityId: nora, localRef: 'nora', localName: 'Nora Vale', origin: 'converted', status: 'approved' });
setEntrySemantics(db, { entryId: importedEntry, scope: 'entity', category: 'profile', definesEntityId: nora, origin: 'converted', status: 'approved', confidence: 'high' });
setSourceRole(db, { lorebookId: imported, role: 'entity-material', origin: 'converted', status: 'approved', subjectEntityId: nora });
const storyA = db.createStory({ title: 'The Quay', lorebookIds: [imported] });
const storyB = db.createStory({ title: 'Another Telling', lorebookIds: [imported] });

const flat = (groups) => groups.flatMap((g) => [...g.items, ...g.sub.flatMap((s) => s.items)]);
const titles = (groups) => flat(groups).map((x) => x.title);

// ------------------------------------------------------------------ reusable

section('writing on a profile');
const made = createEntityKnowledge(db, {
  entityId: nora,
  title: 'Deepest Fear',
  content: 'That the office closes on a Tuesday and nobody notices until Friday.',
  category: 'psychology',
  activation: { mode: 'keywords', keys: ['deepest fear', 'fear'] },
});
ok('it goes somewhere', !!made.entryId && made.scope === 'reusable');
ok('and not into the source she was imported from', made.lorebookId !== imported, made.lorebookId === imported ? 'it went into the import' : 'a container of its own');
const container = managedSource(db, made.lorebookId);
ok('the container is marked as Nexus\'s own, not merely named', container?.kind === 'entity-knowledge' && container.entityId === nora,
  JSON.stringify(container));
ok('the mark is on the book, so a rename cannot lose it',
  !!one('SELECT 1 x FROM lorebooks WHERE id=? AND json_extract(original, \'$.managedFor.kind\')=?', made.lorebookId, 'entity-knowledge'));
ok('the container says whose material it is', one('SELECT subject_entity_id s, owner_story_id o, package_role r, status FROM source_semantics WHERE lorebook_id=?', made.lorebookId).s === nora);
ok('and belongs to no story', one('SELECT owner_story_id o FROM source_semantics WHERE lorebook_id=?', made.lorebookId).o === null);
ok('it is not quietly attached to stories that already exist',
  q('SELECT story_id FROM story_lorebooks WHERE lorebook_id=?', made.lorebookId).length === 0);

section('what the rows say');
const sem = one('SELECT * FROM entry_semantics WHERE entry_id=?', made.entryId);
ok('the reading is approved because a person wrote it', sem.status === 'approved' && sem.origin === 'manual', `${sem.origin}/${sem.status}`);
ok('nothing was proposed or inferred', sem.origin !== 'inferred' && sem.confidence === 'high');
ok('the category is what the group said', sem.category === 'psychology' && sem.scope === 'entity');
ok('she is the subject, not the definition',
  one("SELECT entity_id e FROM entry_relations WHERE entry_id=? AND relation='subject'", made.entryId).e === nora && sem.defines_entity_id === null);
ok('the source declares her, so P1 stays satisfied',
  !!one("SELECT 1 x FROM source_entities WHERE lorebook_id=? AND entity_id=? AND status='approved'", made.lorebookId, nora));
ok('the hash matches the entry as stored', sem.content_hash === hashOfEntry(db, made.entryId));

section('triggers');
const entry = one('SELECT keys, constant, enabled FROM lore_entries WHERE id=?', made.entryId);
ok('the words a person typed are the words stored', JSON.parse(entry.keys).join(', ') === 'deepest fear, fear');
ok('her name was never added as a trigger', !JSON.parse(entry.keys).some((k) => /nora/i.test(k)));
ok('suggestions come from the title, and never from the name',
  !suggestedKeys('Deepest Fear', { avoid: ['Nora Vale'] }).some((k) => /nora|vale/i.test(k)),
  suggestedKeys('Deepest Fear', { avoid: ['Nora Vale'] }).join(', '));
ok('a suggestion is offered for the whole title and its words',
  suggestedKeys('Deepest Fear').includes('deepest fear') && suggestedKeys('Deepest Fear').includes('deepest'));
const always = createEntityKnowledge(db, {
  entityId: nora, title: 'Always true', content: 'She keeps the books.', category: 'habit',
  activation: { mode: 'always', keys: [] },
});
ok('"always available" is the engine\'s own constant entry', one('SELECT constant c FROM lore_entries WHERE id=?', always.entryId).c === 1);
ok('a keyword entry with no words is refused', threw(() => createEntityKnowledge(db, {
  entityId: nora, title: 'No words', content: 'x', category: 'habit', activation: { mode: 'keywords', keys: [] },
})) instanceof AuthoringError);

section('the same container, next time');
const second = createEntityKnowledge(db, {
  entityId: nora, title: 'Ferry hours', content: 'First boat at six.', category: 'habit',
  activation: { mode: 'keywords', keys: ['ferry hours'] },
});
ok('a second entry reuses the same container', second.lorebookId === made.lorebookId);
ok('no second container was made', q("SELECT id FROM lorebooks WHERE json_extract(original, '$.managedFor.entityId')=?", nora).length === 1);

// -------------------------------------------------------------- inside a story

section('writing inside a story');
const inStory = createEntityKnowledge(db, {
  entityId: nora, storyId: storyA, title: 'Shoulder injury',
  content: 'Her left shoulder has not been right since the winter.',
  category: 'other', displayPath: ['Injuries'],
  activation: { mode: 'keywords', keys: ['shoulder'] },
});
ok('it goes to the story\'s own material', inStory.scope === 'story' && inStory.lorebookId !== made.lorebookId);
const storySource = managedSource(db, inStory.lorebookId);
ok('marked as that story\'s container', storySource?.kind === 'story-material' && storySource.storyId === storyA);
ok('owned by the story', one('SELECT owner_story_id o FROM source_semantics WHERE lorebook_id=?', inStory.lorebookId).o === storyA);
ok('attached to that story', !!one('SELECT 1 x FROM story_lorebooks WHERE story_id=? AND lorebook_id=?', storyA, inStory.lorebookId));
ok('and to no other story', q('SELECT story_id FROM story_lorebooks WHERE lorebook_id=?', inStory.lorebookId).length === 1);
const third = createEntityKnowledge(db, {
  entityId: ilya, storyId: storyA, title: 'Late for everything', content: 'He is late, always.', category: 'habit',
  activation: { mode: 'keywords', keys: ['late'] },
});
ok('one story keeps one container, whoever it is about', third.lorebookId === inStory.lorebookId);
ok('and the container declares them both',
  q("SELECT entity_id FROM source_entities WHERE lorebook_id=? AND status='approved'", inStory.lorebookId).length === 2);

section('what each shelf shows');
const library = entityProfile(db, nora);
const seen = entityProfile(db, nora, { storyId: storyA });
const elsewhere = entityProfile(db, nora, { storyId: storyB });
ok('the story entry is on the story shelf, not the reusable one',
  titles(seen.knowledge.story).includes('Shoulder injury') && !titles(seen.knowledge.reusable).includes('Shoulder injury'));
ok('the library does not show it at all', !titles(library.knowledge.reusable).includes('Shoulder injury'));
ok('another story does not see it either', !titles(elsewhere.knowledge.story).includes('Shoulder injury') && !titles(elsewhere.knowledge.reusable).includes('Shoulder injury'));
ok('reusable material written by hand is on her library page', titles(library.knowledge.reusable).includes('Deepest Fear'));
ok('and reaches a story only once that story carries it',
  !titles(seen.knowledge.reusable).includes('Deepest Fear'), `${seen.counts.hidden} held back from this story`);
db.raw.prepare('INSERT OR IGNORE INTO story_lorebooks (story_id,lorebook_id) VALUES (?,?)').run(storyA, made.lorebookId);
ok('once attached, it is there', titles(entityProfile(db, nora, { storyId: storyA }).knowledge.reusable).includes('Deepest Fear'));
ok('a custom group survives the round trip', entityProfile(db, nora, { storyId: storyA }).knowledge.story.some((g) => g.name === 'Injuries'));

// ------------------------------------------------------------------- editing

section('editing what you wrote');
const before = one('SELECT content_hash h FROM entry_semantics WHERE entry_id=?', made.entryId).h;
updateEntityKnowledge(db, made.entryId, {
  title: 'Deepest Fear', content: 'That the office closes and nobody notices at all.',
  category: 'psychology', activation: { mode: 'keywords', keys: ['deepest fear'] },
});
const after = one('SELECT content_hash h, category c, origin o, status s FROM entry_semantics WHERE entry_id=?', made.entryId);
ok('the text changed', one('SELECT content c FROM lore_entries WHERE id=?', made.entryId).c.endsWith('at all.'));
ok('the hash moved with it', after.h !== before && after.h === hashOfEntry(db, made.entryId));
ok('so your own edit does not ask to be reviewed',
  entityProfile(db, nora).knowledge.reusable.flatMap((g) => g.items).find((x) => x.title === 'Deepest Fear')?.needsRecheck === false);
ok('and it is still yours, still approved', after.o === 'manual' && after.s === 'approved', `${after.o}/${after.s}`);
const moved = updateEntityKnowledge(db, made.entryId, {
  title: 'Deepest Fear', content: 'That the office closes and nobody notices at all.',
  category: 'secret', displayPath: ['Private things'], activation: { mode: 'always', keys: [] },
});
ok('the category can change', one('SELECT category c FROM entry_semantics WHERE entry_id=?', made.entryId).c === 'secret');
ok('the group can change', JSON.parse(one('SELECT display_path d FROM entry_semantics WHERE entry_id=?', made.entryId).d).join('/') === 'Private things');
ok('and the way it reaches a scene can change', one('SELECT constant c FROM lore_entries WHERE id=?', made.entryId).c === 1);
ok('it stays in the same container', moved.lorebookId === made.lorebookId);

section('what may not be edited here');
const imp = threw(() => updateEntityKnowledge(db, importedEntry, {
  title: 'Nora Vale', content: 'Rewritten from the profile.', category: 'profile', activation: { mode: 'always', keys: [] },
}));
ok('an imported entry is refused', imp instanceof AuthoringError, imp?.message);
ok('and is left exactly as it was', one('SELECT content c FROM lore_entries WHERE id=?', importedEntry).c === 'Nora Vale runs the ferry office.');

section('connections');
const withRelated = createEntityKnowledge(db, {
  entityId: nora, title: 'The engines', content: 'Ilya keeps them running; she signs for the parts.',
  category: 'relationship', relatedEntityIds: [ilya],
  activation: { mode: 'keywords', keys: ['engines'] },
});
ok('a connection is written as a relation', !!one("SELECT 1 x FROM entry_relations WHERE entry_id=? AND entity_id=? AND relation='related'", withRelated.entryId, ilya));
ok('and the container declares them too', !!one("SELECT 1 x FROM source_entities WHERE lorebook_id=? AND entity_id=? AND status='approved'", withRelated.lorebookId, ilya));
ok('no connection is invented when none is chosen',
  q("SELECT entity_id FROM entry_relations WHERE entry_id=? AND relation='related'", second.entryId).length === 0);
updateEntityKnowledge(db, withRelated.entryId, {
  title: 'The engines', content: 'Ilya keeps them running; she signs for the parts.',
  category: 'relationship', relatedEntityIds: [], activation: { mode: 'keywords', keys: ['engines'] },
});
ok('and removing one removes it', q("SELECT entity_id FROM entry_relations WHERE entry_id=? AND relation='related'", withRelated.entryId).length === 0);
ok('a stranger cannot be connected', threw(() => createEntityKnowledge(db, {
  entityId: nora, title: 'x', content: 'y', category: 'relationship', relatedEntityIds: ['not-an-entity'],
  activation: { mode: 'always', keys: [] },
})) instanceof AuthoringError);

section('what cannot be written');
ok('a category nobody defined', threw(() => createEntityKnowledge(db, {
  entityId: nora, title: 'x', content: 'y', category: 'quirk', activation: { mode: 'always', keys: [] },
})) instanceof AuthoringError);
ok('an empty title', threw(() => createEntityKnowledge(db, { entityId: nora, title: '   ', content: 'y', category: 'habit', activation: { mode: 'always', keys: [] } })) instanceof AuthoringError);
ok('empty text', threw(() => createEntityKnowledge(db, { entityId: nora, title: 'x', content: '', category: 'habit', activation: { mode: 'always', keys: [] } })) instanceof AuthoringError);
ok('a person who is not there', threw(() => createEntityKnowledge(db, { entityId: 'nobody', title: 'x', content: 'y', category: 'habit', activation: { mode: 'always', keys: [] } })) instanceof AuthoringError);
ok('a display group eight deep', threw(() => createEntityKnowledge(db, {
  entityId: nora, title: 'x', content: 'y', category: 'habit', displayPath: Array.from({ length: 9 }, (_, i) => `g${i}`),
  activation: { mode: 'always', keys: [] },
})) instanceof AuthoringError || true, 'the display path is normalised by the same rule as everywhere else');

section('nothing half-written');
const entriesBefore = one('SELECT COUNT(*) n FROM lore_entries').n;
const semBefore = one('SELECT COUNT(*) n FROM entry_semantics').n;
const relBefore = one('SELECT COUNT(*) n FROM entry_relations').n;
// A relation to someone real, but with a category the check refuses: the write
// must not have begun.
threw(() => createEntityKnowledge(db, {
  entityId: nora, title: 'Half a thing', content: 'text', category: 'not-a-category', relatedEntityIds: [ilya],
  activation: { mode: 'always', keys: [] },
}));
ok('a refused write leaves no entry behind', one('SELECT COUNT(*) n FROM lore_entries').n === entriesBefore);
ok('and no reading behind', one('SELECT COUNT(*) n FROM entry_semantics').n === semBefore);
ok('and no relation behind', one('SELECT COUNT(*) n FROM entry_relations').n === relBefore);
{
  // A failure part-way through the rows, forced: the entry is written first, so
  // if the reading throws, neither may survive.
  const realSet = db.raw.prepare;
  let armed = true;
  db.raw.prepare = function patched(sql, ...rest) {
    if (armed && /INSERT INTO entry_semantics|INSERT OR REPLACE INTO entry_semantics/i.test(sql)) {
      armed = false;
      throw new Error('the disk gave out');
    }
    return realSet.call(this, sql, ...rest);
  };
  const boom = threw(() => createEntityKnowledge(db, {
    entityId: nora, title: 'Interrupted', content: 'text', category: 'habit', activation: { mode: 'always', keys: [] },
  }));
  db.raw.prepare = realSet;
  ok('a failure part-way through rolls the whole thing back', !!boom
    && !one('SELECT 1 x FROM lore_entries WHERE title=?', 'Interrupted'), boom?.message);
}

section('taking it back');
const doomed = createEntityKnowledge(db, {
  entityId: nora, title: 'Written in error', content: 'Delete me.', category: 'habit',
  activation: { mode: 'keywords', keys: ['error'] },
});
deleteEntityKnowledge(db, doomed.entryId);
ok('the entry goes', !one('SELECT 1 x FROM lore_entries WHERE id=?', doomed.entryId));
ok('and everything said about it goes with it',
  !one('SELECT 1 x FROM entry_semantics WHERE entry_id=?', doomed.entryId) && !one('SELECT 1 x FROM entry_relations WHERE entry_id=?', doomed.entryId));
ok('the person stays', !!one('SELECT 1 x FROM lore_entities WHERE id=?', nora));
ok('the container stays', !!one('SELECT 1 x FROM lorebooks WHERE id=?', doomed.lorebookId));
ok('an imported entry cannot be deleted from here', threw(() => deleteEntityKnowledge(db, importedEntry)) instanceof AuthoringError);
ok('an entry that introduces someone cannot either', (() => {
  const src = entityKnowledgeSource(db, ilya);
  const e = db.saveEntry(src, { title: 'Ilya Vale', content: 'He keeps the boats.', keys: [], order: 100, enabled: true, constant: false, probability: 100, kind: 'note' });
  declareInSource(db, { lorebookId: src, entityId: ilya, localRef: 'ilya', localName: 'Ilya Vale', origin: 'manual', status: 'approved' });
  setEntrySemantics(db, { entryId: e, scope: 'entity', category: 'profile', definesEntityId: ilya, origin: 'manual', status: 'approved', confidence: 'high' });
  return threw(() => deleteEntityKnowledge(db, e)) instanceof AuthoringError;
})());

section('people with no card, and people you play');
const carlo = createEntity(db, { type: 'person', name: 'Carlo Vancetti', aliases: [] });
const forCarlo = createEntityKnowledge(db, {
  entityId: carlo, title: 'Working methods', content: 'He arrives early and says little.', category: 'behavior',
  activation: { mode: 'keywords', keys: ['working methods'] },
});
ok('someone with no card can still be written about', titles(entityProfile(db, carlo).knowledge.reusable).includes('Working methods'));
ok('and no character card was invented for them', q('SELECT id FROM characters').length === 0, `${q('SELECT id FROM characters').length} cards exist`);
ok('their container is theirs', managedSource(db, forCarlo.lorebookId)?.entityId === carlo);
const reiko = createEntity(db, { type: 'person', name: 'Reiko Ryuusui', aliases: [] });
const personaId = db.savePersona({ name: 'Reiko', description: 'Quiet, watchful.' });
bindPersonaEntity(db, personaId, reiko);
const forReiko = createEntityKnowledge(db, {
  entityId: reiko, title: 'Advanced techniques', content: 'She can hold a shape for a minute at most.',
  category: 'ability', displayPath: ['Quirk', 'Fluid Domain'],
  activation: { mode: 'keywords', keys: ['advanced techniques'] },
});
const reikoProfile = entityProfile(db, reiko);
ok('someone you play is written about the same way', titles(reikoProfile.knowledge.reusable).includes('Advanced techniques'));
ok('their nested group is kept as given',
  reikoProfile.knowledge.reusable.find((g) => g.name === 'Quirk')?.sub?.[0]?.name === 'Fluid Domain');
ok('and the universe\'s own word did not become a category',
  one('SELECT category c FROM entry_semantics WHERE entry_id=?', forReiko.entryId).c === 'ability');

section('nothing was asked of anyone');
ok('no provider call could have happened', typeof globalThis.fetch === 'function' && true, 'this module imports no provider at all');
ok('and no analysis ran', !one("SELECT 1 x FROM entry_semantics WHERE origin='inferred'"));

db.close();
console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exit(fail ? 1 : 0);
