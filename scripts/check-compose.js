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

console.log('\nF  applying a reviewed composition');
{
  const before = { fp: fingerprint(), entries: count('lore_entries'), characters: count('characters') };
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
  ok('approved links are stored', db.loreAboutCharacter(dario).some((x) => x.id === ids['Dario’s Warehouse'])
    && db.loreAboutEntry(ids['Mira Castell']).some((x) => x.id === ids['The Lighthouse']));
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
  try {
    db.transaction(() => writeComposition(db, sid2, { ...plan, links: [{ entryId: ids.Pell, characterId: 'no-such-character' }] }));
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
  const linksBefore = count('entry_character_links') + count('entry_entry_links');
  const msgs = count('messages');
  removeSource(db, sid, bookA);
  ok('the story no longer reads the source', !db.getStory(sid).lorebookIds.includes(bookA));
  ok('the source is still in the library', !!db.getLorebook(bookA));
  ok('every entry is still there, unchanged', fingerprint() === fp);
  ok('cast from that source left the story', !db.storyNpcs(sid).some((x) => x.lorebook_id === bookA));
  ok('cast from other sources stayed', db.storyNpcs(sid).some((x) => x.entry_id === ids.war));
  ok('links describing the material are kept', count('entry_character_links') + count('entry_entry_links') === linksBefore);
  ok('no message was touched', count('messages') === msgs);
  ok('the other book keeps its recursion setting', db.storyLorebookSettings(sid).find((r) => r.lorebook_id === bookB)?.recursion === 'block');
  ok('removing a source the story does not have is refused', throws(() => removeSource(db, sid, bookA), /not part/));
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
