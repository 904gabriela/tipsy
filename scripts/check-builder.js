// The Story Builder: its draft contract, its three modes, partial
// regeneration, and what happens to generated material on Apply.
//
//   node scripts/check-builder.js
//
// No live model and no key. The model is a function handing back canned
// replies, and for the routes a small local server stands in for OpenRouter
// (OPENROUTER_ENDPOINT). The database is a throwaway one.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { open } from '../src/db/index.js';
import { composeSource } from '../src/import/compose.js';
import { fromComposition, gapsOf, canonOf, validateGeneration, DraftError, LIMITS } from '../src/builder/contract.js';
import { buildDraft, regenerate } from '../src/builder/index.js';
import { planGenerated, writeGenerated, acceptedFromDraft } from '../src/builder/apply.js';
import { createEntity, declareInSource, setEntrySemantics } from '../src/semantics/store.js';
import { BUILDER_PROMPT } from '../src/builder/prompt.js';

let pass = 0; let fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? `  — ${d}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? `  — ${d}` : ''}`); }
};
const rejects = async (fn, re) => {
  try { await fn(); return false; } catch (e) { return (e instanceof DraftError || e.status) && (!re || re.test(`${e.message} ${(e.errors || []).join(' ')}`)); }
};
const model = (data, extra = {}) => {
  const calls = [];
  const fn = async (req) => { calls.push(req); return { data: typeof data === 'function' ? data(req) : structuredClone(data), usage: { total_tokens: 1 }, model: 'mock/model', ...extra }; };
  fn.calls = calls;
  return fn;
};
const never = async () => { throw new Error('the model must not be called'); };

// ------------------------------------------------------------- synthetic canon
let n = 0;
const E = (o) => ({ id: `e${++n}`, lorebook_id: 'book', keys: [], enabled: true, constant: false, ...o });
const PACKAGE = [
  E({ kind: 'premise', title: 'Core Identity', constant: true, keys: ['Dario Vance'], content: 'Dario Vance, 31, runs the harbour for his family.' }),
  E({ kind: 'character', title: 'Mira Castell', keys: ['Mira Castell', 'Mira'], content: 'Mira Castell keeps the lighthouse and the ledgers.' }),
  E({ kind: 'character', title: 'Oren Hale', keys: ['Oren Hale', 'Oren'], content: 'Oren Hale runs the last ferry.' }),
  E({ kind: 'place', title: 'The Lighthouse', keys: ['lighthouse'], content: 'Mira Castell’s lighthouse above the rocks.' }),
  E({ kind: 'faction', title: 'Crane Syndicate', keys: ['Crane'], content: 'Tobias Crane’s people. Loud, quick, careless.' }),
  E({ kind: 'rule', title: 'Harbour Law', keys: ['law'], content: 'No blades on the pier.' }),
];
const LEAD = { id: 'c-dario', name: 'Dario Vance', nickname: '', description: 'Dario runs the harbour. Mira Castell keeps his books.', personality: '', scenario: '', first_message: 'The ferry horn sounds. Oren Hale waves.' };
const sourceBase = (mode = 'fill') => fromComposition(composeSource(PACKAGE, { leadCards: [LEAD], opening: LEAD.first_message }), { mode, story: { opening: LEAD.first_message } });
const emptyBase = (mode = 'build') => fromComposition(composeSource([], {}), { mode });
const sourceSnapshot = (d) => JSON.stringify({
  casting: d.casting.filter((r) => r.origin === 'source'),
  items: d.sections.map((s) => s.items.filter((i) => i.origin === 'source')),
  opening: d.story.opening,
});

console.log('A  the draft contract');
{
  const d = sourceBase();
  ok('version 1, with story, reused, generation and invented fields', d.version === 1 && d.story && Array.isArray(d.reused) && d.invented === 0);
  ok('everything the composer read is marked source', d.casting.every((r) => r.origin === 'source') && d.sections.every((s) => s.items.every((i) => i.origin === 'source')));
  ok('the composer’s links are marked inferred', d.links.every((l) => l.origin === 'inferred'));
  ok('a card greeting is the source opening', d.story.opening?.origin === 'source');
  const g = gapsOf(d);
  ok('gaps: what exists is not missing', !g.missing.includes('places') && !g.missing.includes('factions') && !g.missing.includes('people') && !g.missing.includes('opening'));
  ok('gaps: what is absent is', ['premise', 'events', 'directions', 'items'].every((x) => g.missing.includes(x)), g.missing.join(','));
  const c = canonOf(d);
  ok('canon gives every person and entry a reference', c.lines.length === d.casting.length + d.sections.reduce((a, s) => a + s.items.length, 0));
}

console.log('\nB  organize invents nothing and never calls a model');
{
  const d = await buildDraft({ mode: 'organize', base: sourceBase('organize'), callModel: never });
  ok('no model call', d.generation.called === false);
  ok('nothing invented', d.invented === 0 && d.casting.every((r) => r.origin === 'source'));
}

console.log('\nC  fill the gaps keeps canon and fills only what is missing');
{
  const base = sourceBase();
  const before = sourceSnapshot(base);
  const m = model({
    story: { title: 'Harbour Lights', premise: 'A harbour boss holds a city together while it tries to drown him.' },
    people: [
      { id: 'p1', name: 'Mira Castell', role: 'supporting', content: 'Mira, rewritten as a spy.' },
      { id: 'p2', name: 'Tamsin Reed', role: 'background', content: 'Tamsin Reed keeps the ferry office.' },
    ],
    entries: [
      { id: 'e1', section: 'places', title: 'The Lighthouse', content: 'Rewritten lighthouse.' },
      { id: 'e5', section: 'places', title: 'Dockside Bar', content: 'A new place nobody asked for.' },
      { id: 'e2', section: 'events', title: 'The Night Tide', content: 'The harbour floods in one night.', about: ['p2', 'C1'] },
      { id: 'e3', section: 'directions', title: 'Pacing', content: 'Let tension build before anyone acts.' },
      { id: 'e4', section: 'items', title: 'The Brass Key', content: 'Opens the warehouse.', about: ['S99'] },
    ],
  });
  const d = await buildDraft({ mode: 'fill', base, callModel: m });
  const write = m.calls[0].messages[1].content.split('WRITE:')[1];
  ok('the model is asked only for what is missing', /premise/.test(write) && /events/.test(write) && !/people/.test(write) && !/"places"/.test(write), write.trim().replace(/\n/g, ' '));
  ok('the model is shown the canon with references', /C1 \[people, lead\] Dario Vance/.test(m.calls[0].messages[1].content));
  ok('source material is byte-for-byte unchanged', sourceSnapshot(d) === before);
  ok('no second Mira, and she is not rewritten', d.casting.filter((r) => r.name === 'Mira Castell').length === 1 && !JSON.stringify(d).includes('rewritten as a spy'));
  ok('no rewritten lighthouse', !JSON.stringify(d).includes('Rewritten lighthouse'));
  ok('a new place in a section that was not missing is left out', !d.sections.find((s) => s.id === 'places').items.some((i) => i.title === 'Dockside Bar'));
  ok('what was not asked for is left out, and said', d.generation.warnings.some((w) => /not asked for/.test(w)));
  ok('missing sections are filled and marked generated', d.sections.find((s) => s.id === 'events').items.some((i) => i.title === 'The Night Tide' && i.origin === 'generated'));
  ok('a link to something left out is dropped', !d.links.some((l) => l.origin === 'generated' && l.targetName === 'p2'));
  ok('a link to canon survives', d.links.some((l) => l.origin === 'generated' && l.characterId === 'c-dario'));
  ok('a link to a reference that does not exist is dropped, and said', d.generation.warnings.some((w) => /S99/.test(w)));
  ok('generated premise and title say so', d.story.premise.origin === 'generated' && d.story.title.origin === 'generated');
  ok('the source opening is kept', d.story.opening.origin === 'source');
  ok('invented counts only what was generated', d.invented === 5, String(d.invented));
  ok('nothing missing means no call', (await buildDraft({ mode: 'fill', base: { ...d, story: { ...d.story }, sections: d.sections.map((s) => ({ ...s, count: s.count || 1 })) }, callModel: never })).generation.called === false);
}

console.log('\nD  build it out from an idea');
const IDEA_REPLY = {
  story: { title: 'Salt and Iron', premise: 'A smuggler owes a debt to the woman who pulled him out of the sea.' },
  opening: { text: 'The tide goes out and leaves you on the rocks, and someone is already standing over you.' },
  people: [
    { id: 'nico', name: 'Nico Vale', role: 'lead', content: 'Nico Vale smuggles salt past the harbour patrol.', keys: ['Nico'] },
    { id: 'ada', name: 'Ada Frost', role: 'main', content: 'Ada Frost pulled Nico from the sea and wants paying.', about: ['nico'] },
    { id: 'bex', name: 'Bex', role: 'known', content: 'Bex fences anything that floats.' },
  ],
  entries: [
    { id: 'p1', section: 'places', title: 'Saltworks', content: 'Where the salt is dried and hidden.', about: ['nico'] },
    { id: 'p2', section: 'places', title: 'The Breakwater', content: 'Where the patrol boats turn back.' },
    { id: 'p3', section: 'places', title: 'A Third Place', content: 'One too many at light depth.' },
    { id: 'f1', section: 'factions', title: 'Harbour Patrol', content: 'They take bribes in salt.' },
    { id: 'ev1', section: 'events', title: 'The Wreck', content: 'Nico’s boat went down off the breakwater.', about: ['p2', 'nico'] },
  ],
};
let built;
{
  const m = model(IDEA_REPLY);
  built = await buildDraft({ mode: 'build', depth: 'light', idea: 'A smuggler and the woman who saved him.', base: emptyBase(), callModel: m });
  ok('a plain idea is enough', built.generation.called === true && built.casting.length === 3);
  ok('the idea reaches the model in the builder prompt, not a roleplay prompt', m.calls[0].messages[0].content === BUILDER_PROMPT && /smuggler and the woman/.test(m.calls[0].messages[1].content));
  ok('a lead may be proposed when there is none', built.casting.find((r) => r.name === 'Nico Vale')?.suggested === 'lead');
  ok('a generated lead is not made a card by default', built.casting.find((r) => r.name === 'Nico Vale').promote === false && !built.casting.some((r) => r.characterId));
  ok('everything generated is marked generated', built.casting.every((r) => r.origin === 'generated') && built.story.opening.origin === 'generated');
  ok('depth limits the count, not the length', built.sections.find((s) => s.id === 'places').count === LIMITS.light.places && built.generation.warnings.some((w) => /more than 2 places/.test(w)));
  ok('links between generated items are kept', built.links.some((l) => l.fromDraftId === 'ada' && l.aboutDraftId === 'nico'));
  ok('max tokens follow depth', m.calls[0].maxTokens === 2500);
  ok('build needs an idea or canon', await rejects(() => buildDraft({ mode: 'build', base: emptyBase(), callModel: never }), /needs an idea/));
}

console.log('\nE  existing things are reused, not made twice');
{
  const m = model({
    people: [
      { id: 'x1', name: 'dario vance', role: 'supporting', content: 'A second Dario.' },
      { id: 'x2', name: 'Oren Hale', role: 'background', content: 'A second Oren.' },
      { id: 'x3', name: 'Lena Marsh', role: 'background', content: 'Lena Marsh sells nets.' },
    ],
    entries: [
      { id: 'y1', section: 'places', title: 'the lighthouse', content: 'A second lighthouse.' },
      { id: 'y2', section: 'places', title: 'Net Loft', content: 'Where Lena works.', about: ['x3'] },
    ],
  });
  const d = await buildDraft({ mode: 'build', idea: 'more harbour', base: sourceBase('build'), callModel: m });
  ok('the lead card is reused, not duplicated', d.casting.filter((r) => /dario vance/i.test(r.name)).length === 1 && d.reused.some((r) => /dario/i.test(r.name) && r.existing?.characterId === 'c-dario'));
  ok('a source person is reused, not duplicated', d.casting.filter((r) => r.name === 'Oren Hale').length === 1 && d.reused.some((r) => r.name === 'Oren Hale' && r.existing?.entryId));
  ok('a source place is reused, not duplicated', d.sections.find((s) => s.id === 'places').items.filter((i) => /lighthouse/i.test(i.title)).length === 1);
  ok('new material alongside is kept', d.casting.some((r) => r.name === 'Lena Marsh' && r.origin === 'generated'));
}

console.log('\nF  malformed output is refused whole');
{
  const base = emptyBase();
  const attempt = (data) => buildDraft({ mode: 'build', idea: 'x', base, callModel: model(data) });
  ok('not an object', await rejects(() => attempt([1, 2, 3]), /not a draft/));
  ok('unreadable reply', await rejects(() => buildDraft({ mode: 'build', idea: 'x', base, callModel: async () => ({ data: null, finishReason: 'length' }) }), /cut off/));
  ok('two leads', await rejects(() => attempt({ people: [{ id: 'a', name: 'Ann Lee', role: 'lead', content: 'x' }, { id: 'b', name: 'Bo Lee', role: 'lead', content: 'y' }] }), /more than one lead/));
  ok('a lead when the story has one', await rejects(() => buildDraft({ mode: 'build', idea: 'x', base: sourceBase('build'), callModel: model({ people: [{ id: 'a', name: 'Ann Lee', role: 'lead', content: 'x' }] }) }), /already has one/));
  ok('an unknown section', await rejects(() => attempt({ entries: [{ id: 'a', section: 'weapons', title: 'Gun', content: 'x' }] }), /unknown section/));
  ok('an unknown role', await rejects(() => attempt({ people: [{ id: 'a', name: 'Ann Lee', role: 'boss', content: 'x' }] }), /unknown role/));
  ok('the same id twice', await rejects(() => attempt({ entries: [{ id: 'a', section: 'places', title: 'A', content: 'x' }, { id: 'a', section: 'places', title: 'B', content: 'y' }] }), /used twice/));
  ok('an unusable id', await rejects(() => attempt({ entries: [{ id: 'has spaces!', section: 'places', title: 'A', content: 'x' }] }), /usable id/));
  ok('people that is not a list', await rejects(() => attempt({ people: 'Ann' }), /not a list/));
  const trimmed = validateGeneration({ entries: [{ id: 'a', section: 'places', title: 'Long', content: 'x'.repeat(1600) }, { id: 'b', section: 'places', title: 'Fine', content: 'ok' }] },
    { draft: base, depth: 'standard', allowed: new Set(['places']), canon: canonOf(base) });
  ok('an over-long entry is left out, and said; the rest stays', trimmed.entries.length === 1 && trimmed.warnings.some((w) => /longer than 1500/.test(w)));
  ok('a heading is not accepted as a person', validateGeneration({ people: [{ id: 'a', name: 'Vancetti Family', role: 'main', content: 'x' }] },
    { draft: base, depth: 'standard', allowed: new Set(['people']), canon: canonOf(base) }).people.length === 0);
}

console.log('\nG  partial regeneration touches only its scope');
{
  const placesOf = (d) => d.sections.find((s) => s.id === 'places').items;
  const m = model({ entries: [{ id: 'new-place', section: 'places', title: 'Salt Market', content: 'Where debts are paid.' }] });
  const d = await regenerate({ draft: built, scope: { part: 'places' }, callModel: m });
  ok('the section’s generated items are replaced', placesOf(d).length === 1 && placesOf(d)[0].title === 'Salt Market');
  ok('other sections are untouched', JSON.stringify(d.sections.find((s) => s.id === 'factions')) === JSON.stringify(built.sections.find((s) => s.id === 'factions')));
  ok('people are untouched', JSON.stringify(d.casting) === JSON.stringify(built.casting));
  ok('the opening is untouched', d.story.opening.text === built.story.opening.text);
  ok('links from removed items go with them', !d.links.some((l) => l.fromDraftId === 'p1'));

  const touched = structuredClone(built);
  const mine = touched.sections.find((s) => s.id === 'places').items[0];
  mine.content = 'The person rewrote this.'; mine.edited = true;
  const d1 = await regenerate({ draft: touched, scope: { part: 'places' }, callModel: model({ entries: [{ id: 'fresh', section: 'places', title: 'Fresh Place', content: 'New.' }] }) });
  ok('asking for a section again keeps suggestions the person edited', placesOf(d1).some((i) => i.content === 'The person rewrote this.' && i.edited)
    && placesOf(d1).some((i) => i.title === 'Fresh Place') && placesOf(d1).length === 2);
  const d1b = await regenerate({ draft: touched, scope: { item: mine.draftId }, callModel: model({ entries: [{ id: 'swap', section: 'places', title: 'Swapped', content: 'Asked for.' }] }) });
  ok('but asking for that one item again replaces it', !placesOf(d1b).some((i) => i.edited) && placesOf(d1b).some((i) => i.title === 'Swapped'));

  const fillDraft = await buildDraft({ mode: 'fill', base: sourceBase(), callModel: model({ entries: [{ id: 'ev', section: 'events', title: 'Storm', content: 'A storm.' }] }) });
  const before = sourceSnapshot(fillDraft);
  const d2 = await regenerate({ draft: fillDraft, scope: { part: 'places' }, callModel: model({ entries: [{ id: 'dock', section: 'places', title: 'The Docks', content: 'Wet and loud.' }] }) });
  ok('regenerating a section with source material keeps the source material', sourceSnapshot(d2) === before && placesOf(d2).some((i) => i.title === 'The Lighthouse'));
  ok('and adds beside it', placesOf(d2).some((i) => i.title === 'The Docks' && i.origin === 'generated'));
  ok('the earlier generated event is still there', d2.sections.find((s) => s.id === 'events').items.some((i) => i.title === 'Storm'));

  const ada = built.casting.find((r) => r.name === 'Ada Frost');
  const d3 = await regenerate({ draft: built, scope: { item: ada.draftId }, callModel: model({
    people: [{ id: 'ada2', name: 'Ada Frost', role: 'main', content: 'Ada Frost, rewritten: a lighthouse keeper with a grudge.' }],
    entries: [{ id: 'extra', section: 'events', title: 'Should not appear', content: 'x' }],
  }) });
  ok('one item regenerated', d3.casting.find((r) => r.name === 'Ada Frost').content.includes('grudge'));
  ok('only that item: the extra item is left out', !JSON.stringify({ ...d3, generation: null }).includes('Should not appear') && d3.generation.warnings.some((w) => /extra item|not asked for/.test(w)));
  ok('everyone else unchanged', JSON.stringify(d3.casting.filter((r) => r.name !== 'Ada Frost')) === JSON.stringify(built.casting.filter((r) => r.name !== 'Ada Frost')));

  const manual = structuredClone(built);
  manual.sections.find((s) => s.id === 'items').items.push({ origin: 'manual', draftId: 'm1', title: 'My Knife', content: 'Mine.', keys: [] });
  ok('manual material cannot be regenerated', await rejects(() => regenerate({ draft: manual, scope: { item: 'm1' }, callModel: never }), /Only generated/));
  ok('an author premise cannot be regenerated', await rejects(() => regenerate({ draft: { ...fillDraft, story: { ...fillDraft.story, premise: { value: 'Mine', origin: 'source' } } }, scope: { part: 'premise' }, callModel: never }), /not rewritten/));
  ok('an existing story’s opening cannot be regenerated', await rejects(() => regenerate({ draft: { ...fillDraft, context: 'existing' }, scope: { part: 'opening' }, callModel: never }), /already has its opening/));

  const crane = fillDraft.sections.find((s) => s.id === 'factions').items.find((i) => i.title === 'Crane Syndicate');
  const craneRef = [...canonOf(fillDraft).refs.entries()].find(([, v]) => v.entryId === crane.entryId)[0];
  const d4 = await regenerate({ draft: fillDraft, scope: { expand: { entryId: crane.entryId } }, callModel: model({
    people: [{ id: 'enf', name: 'Tobias Crane', role: 'supporting', content: 'Tobias Crane leads the syndicate.', about: [craneRef] }],
    entries: [{ id: 'unrelated', section: 'factions', title: 'Unrelated Guild', content: 'Nothing to do with Crane.' }],
  }) });
  ok('expanding adds material about the target', d4.casting.some((r) => r.name === 'Tobias Crane' && r.origin === 'generated'));
  ok('and nothing that is not about it', !JSON.stringify(d4).includes('Unrelated Guild'));
  ok('the target itself is not rewritten', JSON.stringify(d4.sections.find((s) => s.id === 'factions').items.find((i) => i.entryId === crane.entryId)) === JSON.stringify(crane));
}

console.log('\nG2 the model can never make a character card');
{
  const d = await buildDraft({ mode: 'build', idea: 'x', base: emptyBase(), callModel: model({
    people: [{ id: 'boss', name: 'Rhea Stone', role: 'lead', content: 'Rhea Stone runs the port.', promote: true, promotionSuggested: true }],
  }) });
  const rhea = d.casting.find((r) => r.name === 'Rhea Stone');
  ok('a model-authored promote is ignored', rhea.promote === false);
  ok('and it is said', d.generation.warnings.some((w) => /cannot make anyone a character card/.test(w)));
  ok('its advice survives as advice', rhea.promotionSuggested === true);
  const forged = structuredClone(d);
  forged.casting[0].promote = true;   // a draft tampered with, or a model that learned the field name
  const { items } = acceptedFromDraft(forged);
  ok('a promote inside a draft is not read at Apply', items[0].promote === false);
  ok('so a lead with no card is refused', (() => { try { planGenerated(null, { items, allowLead: true }); return false; } catch (e) { return /no character card/.test(e.message); } })());
  ok('only the person’s explicit choice promotes', acceptedFromDraft(d, null, [rhea.draftId]).items[0].promote === true);
}

console.log('\nG3 reuse is by kind and name, or by explicit reference');
{
  const pkg = [
    E({ kind: 'place', title: 'Black Lotus', keys: ['Black Lotus'], content: 'A club on the harbour.' }),
    E({ kind: 'character', title: 'Mira Castell', keys: ['Mira Castell'], content: 'Mira Castell keeps the lighthouse.' }),
    E({ kind: 'faction', title: 'Crane Syndicate', keys: ['Crane'], content: 'Loud and careless.' }),
  ];
  const base = fromComposition(composeSource(pkg, { leadCards: [LEAD], opening: LEAD.first_message }), { mode: 'build' });
  const canon = canonOf(base);
  const refOf = (title) => [...canon.refs.entries()].find(([, v]) => v.name === title)[0];
  const v = validateGeneration({
    people: [{ id: 'p1', name: 'Black Lotus', role: 'background', content: 'A singer who took the club’s name.' }],
    entries: [
      { id: 'e1', section: 'places', title: 'Mira Castell', content: 'A ship named after her.' },
      { id: 'e2', section: 'places', title: 'black lotus', content: 'The club again.' },
      { id: 'e3', section: 'places', title: 'The Old Club', content: 'Also the club.', same: refOf('Black Lotus') },
      { id: 'e4', section: 'factions', title: 'Lotus Crew', content: 'Says it is the club.', same: refOf('Black Lotus') },
    ],
  }, { draft: base, depth: 'deep', allowed: new Set(['people', 'places', 'factions']), canon });
  ok('same name, different kind: a person is not the place', v.people.some((p) => p.name === 'Black Lotus') && !v.reused.some((r) => r.kind === 'person'));
  ok('same name, different kind: a place is not the person', v.entries.some((e) => e.title === 'Mira Castell'));
  ok('same kind and same normalised name: reused', v.reused.some((r) => r.name === 'black lotus' && r.kind === 'place' && r.how === 'name' && r.existing.entryId));
  ok('explicit reference to the same kind: reused, whatever the name', v.reused.some((r) => r.name === 'The Old Club' && r.how === 'reference'));
  ok('explicit reference to a different kind: kept as a proposal, and said', v.entries.some((e) => e.title === 'Lotus Crew') && v.warnings.some((w) => /different kind of thing \(place\)/.test(w)));
}

// ------------------------------------------------------- database and routes
const dir = mkdtempSync(join(tmpdir(), 'tipsy-builder-'));
const dbPath = join(dir, 'builder.db');
let db = open(dbPath);
const book = db.createLorebook('Harbour — people and places', '');
const ids = {};
for (const e of PACKAGE) { const { id: _, lorebook_id: __, ...rest } = e; ids[e.title] = db.saveEntry(book, { ...rest, order: 100 }); }
// On the final cast table a cast member is a person Nexus knows, so the two
// people this source casts are organised the way a person would have to.
for (const name of ['Mira Castell', 'Oren Hale']) {
  const who = createEntity(db, { type: 'person', name, aliases: [] });
  declareInSource(db, { lorebookId: book, entityId: who, localRef: name.toLowerCase().replace(/\W+/g, '-'), localName: name, origin: 'manual', status: 'approved' });
  setEntrySemantics(db, { entryId: ids[name], scope: 'entity', category: 'profile', definesEntityId: who, origin: 'manual', status: 'approved', confidence: 'high' });
}
const dario = db.writeCharacter({ name: 'Dario Vance', description: LEAD.description, firstMessage: LEAD.first_message });
db.close();

const counts = (d) => Object.fromEntries(['stories', 'lorebooks', 'lore_entries', 'characters', 'imports', 'import_resources', 'story_npcs', 'entry_character_links', 'entry_entry_links', 'messages']
  .map((t) => [t, d.raw.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));

console.log('\nH  rollback: a failure while writing generated material leaves nothing');
{
  db = open(dbPath);
  const before = counts(db);
  const sid = db.createStory({ title: 'Rollback', characterIds: [dario] });
  const afterStory = counts(db);
  const plan = planGenerated(db, { items: [{ type: 'entry', draftId: 'a', origin: 'generated', section: 'places', title: 'Quay', content: 'Stone.' }], poolIds: new Set() });
  let threw = false;
  // A real foreign-key violation right after everything generated is written.
  try { db.transaction(() => { writeGenerated(db, sid, plan, { title: 'Rollback' }); db.setStoryNpc(sid, 'no-such-entry', 'main'); }); } catch { threw = true; }
  const after = counts(db);
  ok('the write failed', threw);
  ok('no import record, book or entry survived', after.imports === afterStory.imports && after.lorebooks === afterStory.lorebooks && after.lore_entries === afterStory.lore_entries);
  db.deleteStory(sid);
  ok('back to where it started', JSON.stringify(counts(db)) === JSON.stringify(before));
  db.close();
}

// A stand-in for OpenRouter. Replies are queued per test.
const queue = [];
const seen = [];
const fake = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
  const next = queue.shift() ?? { content: '{}' };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ model: 'fake/model', choices: [{ message: { content: next.content }, finish_reason: next.finish || 'stop' }], usage: { total_tokens: 42 } }));
});
await new Promise((r) => fake.listen(0, r));
const fakePort = fake.address().port;
const port = 8950 + Math.floor(Math.random() * 40);
const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(port), DB_PATH: dbPath, OPENROUTER_ENDPOINT: `http://localhost:${fakePort}`, OPENROUTER_API_KEY: 'test-not-a-real-key' },
  stdio: 'ignore',
});
const base = `http://localhost:${port}`;
const J = (p, b, m = 'POST') => fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const dbCounts = () => { const d = open(dbPath); const c = counts(d); d.close(); return c; };
const reply = (obj) => queue.push({ content: JSON.stringify(obj) });

try {
  for (let i = 0; i < 60; i++) { try { await fetch(`${base}/api/library`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  console.log('\nI  the routes produce drafts and write nothing');
  const start = dbCounts();
  const org = await J('/api/builder/draft', { mode: 'organize', lorebookIds: [book], characterIds: [dario] });
  ok('organize over the route: a draft, no model call', org.status === 200 && org.body.version === 1 && org.body.invented === 0 && seen.length === 0);

  reply({
    story: { premise: 'Dario holds the harbour while the Crane Syndicate circles.' },
    people: [{ id: 'tam', name: 'Tamsin Reed', role: 'background', content: 'Tamsin Reed keeps the ferry office.' }, { id: 'lena', name: 'Lena Marsh', role: 'supporting', content: 'Lena Marsh sells nets and secrets.' }],
    entries: [
      { id: 'quay', section: 'places', title: 'The Quay', content: 'Stone steps, always wet.', about: ['tam'] },
      { id: 'storm', section: 'events', title: 'The Storm', content: 'A storm strands the ferry.', about: ['C1'] },
      { id: 'debt', section: 'events', title: 'The Debt', content: 'Someone calls in a debt.' },
    ],
  });
  const build = await J('/api/builder/draft', { mode: 'build', depth: 'standard', idea: 'Dario and a storm', lorebookIds: [book], characterIds: [dario] });
  ok('build over the route returns a draft', build.status === 200 && build.body.invented > 0, JSON.stringify(build.body?.generation?.warnings || build.body));
  ok('it went to the provider with the builder prompt and the configured key', seen[0].auth === 'Bearer test-not-a-real-key' && seen[0].body.messages[0].content === BUILDER_PROMPT);
  ok('with a JSON response format', seen[0].body.response_format?.type === 'json_schema');
  ok('using the story model by default, not a builder-only hardwired one', seen[0].body.model === 'x-ai/grok-4.20', seen[0].body.model);
  ok('the database did not change', JSON.stringify(dbCounts()) === JSON.stringify(start));

  queue.push({ content: 'I am sorry, here is a story: once upon a time' });
  const bad = await J('/api/builder/draft', { mode: 'build', idea: 'anything', lorebookIds: [book], characterIds: [dario] });
  ok('an unreadable reply fails gracefully', bad.status === 422 && /readable/.test(bad.body?.error || ''), bad.body?.error);
  queue.push({ content: JSON.stringify({ people: [{ id: 'a', name: 'Ann Lee', role: 'lead', content: 'x' }] }) });
  const badLead = await J('/api/builder/draft', { mode: 'build', idea: 'anything', lorebookIds: [book], characterIds: [dario] });
  ok('a broken rule fails gracefully', badLead.status === 422 && /broke the draft rules/.test(badLead.body?.error || ''));
  ok('still nothing written', JSON.stringify(dbCounts()) === JSON.stringify(start));

  reply({ entries: [{ id: 'harbour-master', section: 'places', title: 'Harbour Master’s Office', content: 'Where the ledgers are kept.' }] });
  const regen = await J('/api/builder/regenerate', { draft: build.body, scope: { part: 'places' } });
  ok('regenerate over the route', regen.status === 200 && regen.body.sections.find((s) => s.id === 'places').items.some((i) => i.title === 'Harbour Master’s Office'));
  const regenBad = await J('/api/builder/regenerate', { draft: { ...build.body, version: 9 }, scope: { part: 'places' } });
  ok('a draft that is not version 1 is refused', regenBad.status === 422);

  const settings = await J('/api/builder/settings', { model: 'deepseek/deepseek-v4-flash', temperature: 0.4 }, 'PUT');
  ok('the builder model is its own setting', settings.status === 200 && settings.body.model === 'deepseek/deepseek-v4-flash');
  reply({});
  await J('/api/builder/draft', { mode: 'build', idea: 'check the model', lorebookIds: [book], characterIds: [dario] });
  ok('and it is used', seen[seen.length - 1].body.model === 'deepseek/deepseek-v4-flash' && seen[seen.length - 1].body.temperature === 0.4);
  const storyDefaults = (await J('/api/settings', null, 'GET')).body;
  ok('the roleplay default model is unchanged', JSON.stringify(storyDefaults).includes('x-ai/grok-4.20'));
  await J('/api/builder/settings', { model: null }, 'PUT');

  console.log('\nJ  applying accepted generated material');
  const d = build.body;
  const tam = d.casting.find((r) => r.name === 'Tamsin Reed');
  const quay = d.sections.find((s) => s.id === 'places').items.find((i) => i.title === 'The Quay');
  const storm = d.sections.find((s) => s.id === 'events').items.find((i) => i.title === 'The Storm');
  const { items, links } = acceptedFromDraft(d, [tam.draftId, quay.draftId, storm.draftId]);
  ok('accepting three items gives three items and only their links', items.length === 3 && links.every((l) => [tam.draftId, quay.draftId, storm.draftId].includes(l.fromDraftId)));
  const before = dbCounts();
  const sourceCasting = d.casting.filter((r) => r.origin === 'source').map((r) => ({ ...(r.characterId ? { characterId: r.characterId } : { entryId: r.entryId }), entryIds: r.entryIds, role: r.suggested }));
  const started = await J('/api/stories', {
    title: 'Harbour, built', personaId: null, lorebookIds: [book],
    composition: {
      casting: sourceCasting, generated: { items, links },
      story: { premise: d.story.premise.value }, builder: { mode: 'build', depth: 'standard', model: 'fake/model' },
    },
  });
  ok('the story starts', started.status === 200, JSON.stringify(started.body));
  const sid = started.body.id;
  const x = open(dbPath);
  const q = (sql, ...a) => x.raw.prepare(sql).all(...a);
  const after = counts(x);
  // Since P8, accepted material lives in the story's one canonical container —
  // the same Story Material that hand-written material uses — marked on the
  // book itself and owned by the story. Provenance stays per entry and per
  // import record, not as a second visible source.
  const bb = q(`SELECT l.id, l.name, l.import_id FROM lorebooks l JOIN story_lorebooks sl ON sl.lorebook_id=l.id
      WHERE sl.story_id=? AND json_valid(l.original) AND json_extract(l.original,'$.managedFor.kind')='story-material'`, sid)[0];
  ok('one Story Material book of its own, connected to the story', !!bb && q('SELECT COUNT(*) n FROM story_lorebooks WHERE story_id=?', sid)[0].n === 2, bb?.name);
  ok('owned by the story in the canonical way', q('SELECT owner_story_id o, status FROM source_semantics WHERE lorebook_id=?', bb.id)[0]?.o === sid);
  const rec = bb && q('SELECT source, format, committed_at, analysis FROM imports WHERE id=?', bb.import_id)[0];
  ok('its provenance record says Story Builder', rec?.source === 'builder' && rec.format === 'story-builder' && !!rec.committed_at && JSON.parse(rec.analysis).mode === 'build');
  ok('and what that record produced', q('SELECT kind FROM import_resources WHERE import_id=? ORDER BY kind', bb.import_id).map((r) => r.kind).join() === 'lorebook,story');
  const made = q('SELECT title, kind, original FROM lore_entries WHERE lorebook_id=? ORDER BY title', bb.id);
  ok('exactly the accepted items became entries', made.map((m) => m.title).join('|') === 'Tamsin Reed|The Quay|The Storm', made.map((m) => m.title).join('|'));
  ok('as structured entries of the right kind', made.find((m) => m.title === 'The Quay').kind === 'place' && made.find((m) => m.title === 'The Storm').kind === 'event' && made.find((m) => m.title === 'Tamsin Reed').kind === 'character');
  ok('each remembers it was generated', made.every((m) => JSON.parse(m.original).origin === 'generated' && JSON.parse(m.original).builder === bb.import_id));
  ok('rejected material never persisted', q("SELECT COUNT(*) n FROM lore_entries WHERE title IN ('Lena Marsh','The Debt')")[0].n === 0);
  ok('the generated person is in the cast, lore-backed', q('SELECT n.role FROM story_npcs n JOIN lore_entries e ON e.id=n.profile_entry_id WHERE n.story_id=? AND e.title=?', sid, 'Tamsin Reed')[0]?.role === 'background');
  ok('and did not become a global character', after.characters === before.characters);
  // Since the semantic model (P1): accepted links are evidence, not semantics.
  ok('the accepted link is kept as evidence, not semantics', q("SELECT COUNT(*) n FROM legacy_entry_links WHERE source='builder-review' AND entry_title=? AND target_name=? AND derived_origin='builder-accepted' AND status='legacy'", 'The Quay', 'Tamsin Reed')[0].n === 1
    && q('SELECT COUNT(*) n FROM entry_relations')[0].n === 0 && q('SELECT COUNT(*) n FROM entry_entry_links')[0].n === 0);
  ok('the generated premise was saved', JSON.parse(q('SELECT settings FROM stories WHERE id=?', sid)[0].settings).premise === d.story.premise.value);
  ok('source entries untouched', q('SELECT COUNT(*) n FROM lore_entries WHERE lorebook_id=?', book)[0].n === PACKAGE.length);
  x.close();

  const dup = await J('/api/stories', {
    personaId: null, lorebookIds: [book],
    composition: { casting: [{ characterId: dario, role: 'lead' }], generated: { items: [{ type: 'person', draftId: 'm', origin: 'generated', name: 'Mira Castell', role: 'main', content: 'A second Mira.' }], links: [] } },
  });
  ok('a generated person who already exists is refused', dup.status === 400 && /already in this story/.test(dup.body?.error || ''));
  const src = await J('/api/stories', {
    personaId: null, lorebookIds: [book],
    composition: { casting: [{ characterId: dario, role: 'lead' }], generated: { items: [{ type: 'entry', draftId: 's', origin: 'source', section: 'places', title: 'Fake', content: 'x' }], links: [] } },
  });
  ok('"source" material cannot be created through this path', src.status === 400);

  console.log('\nK  a generated lead');
  const beforeLead = dbCounts();
  const nico = { type: 'person', draftId: 'nico', origin: 'generated', name: 'Nico Vale', role: 'lead', content: 'Nico Vale smuggles salt.' };
  const noCard = await J('/api/stories', { personaId: null, composition: { casting: [], generated: { items: [nico], links: [] }, opening: { text: 'The tide goes out.' } } });
  ok('is refused without an explicit card', noCard.status === 400 && /no character card/.test(noCard.body?.error || ''), noCard.body?.error);
  ok('and nothing was written', JSON.stringify(dbCounts()) === JSON.stringify(beforeLead));
  const twoLeads = await J('/api/stories', { personaId: null, composition: { casting: [{ characterId: dario, role: 'lead' }], generated: { items: [{ ...nico, promote: true }], links: [] } } });
  ok('cannot sit beside a card lead', twoLeads.status === 400 && /one lead/.test(twoLeads.body?.error || ''));
  const withCard = await J('/api/stories', {
    personaId: null,
    composition: { casting: [], generated: { items: [{ ...nico, promote: true }, { type: 'entry', draftId: 'wreck', origin: 'generated', section: 'events', title: 'The Wreck', content: 'Nico’s boat went down.' }], links: [{ fromDraftId: 'wreck', aboutDraftId: 'nico' }] }, opening: { text: 'The tide goes out and leaves you on the rocks.' }, story: { title: 'Salt and Iron' }, builder: { mode: 'build' } },
  });
  ok('becomes a card only when asked', withCard.status === 200, JSON.stringify(withCard.body));
  const y = open(dbPath);
  const story = y.getStory(withCard.body.id);
  const card = story.characters[0];
  const cardRec = y.raw.prepare('SELECT source FROM imports WHERE id=(SELECT import_id FROM characters WHERE id=?)').get(card.id);
  ok('exactly one new card, leading the story', dbCounts().characters === beforeLead.characters + 1 && card.name === 'Nico Vale' && card.story_role === 'lead');
  ok('the card knows it came from the Story Builder', cardRec?.source === 'builder');
  ok('the reviewed opening opens the story, exactly once', y.raw.prepare('SELECT COUNT(*) n FROM messages WHERE story_id=?').get(withCard.body.id).n === 1
    && y.pathTo(story.head_id).map((m) => m.content).join() === 'The tide goes out and leaves you on the rocks.');
  ok('the generated title is used', story.title === 'Salt and Iron');
  ok('an entry about the generated lead is recorded as evidence pointing at the card', y.raw.prepare("SELECT COUNT(*) n FROM legacy_entry_links WHERE source='builder-review' AND entry_title='The Wreck' AND target_kind='character' AND target_id=?").get(card.id).n === 1);
  y.close();

  console.log('\nL  an existing story');
  const existing = await J(`/api/stories/${sid}/compose`, { generated: { items: [{ type: 'entry', draftId: 'lamp', origin: 'manual', section: 'items', title: 'The Storm Lamp', content: 'Kept lit for the ferry.' }], links: [] } });
  ok('accepts generated or hand-written additions', existing.status === 200 && existing.body.generatedEntries === 1, JSON.stringify(existing.body));
  const z = open(dbPath);
  // Hand-written additions join the story's one package, marked as written by hand.
  const packages = z.raw.prepare("SELECT l.id FROM lorebooks l WHERE json_valid(l.original) AND json_extract(l.original,'$.managedFor.storyId')=?").all(sid);
  const lamp = z.raw.prepare("SELECT lorebook_id, original FROM lore_entries WHERE title='The Storm Lamp'").get();
  ok('hand-written material joins the same package, not a new one', packages.length === 1 && lamp.lorebook_id === packages[0].id);
  ok('and says it was written by hand, with no Story Builder record of its own', JSON.parse(lamp.original).origin === 'manual' && JSON.parse(lamp.original).builder === null);
  z.close();
  const lead2 = await J(`/api/stories/${sid}/compose`, { generated: { items: [{ ...nico, name: 'Other Lead', promote: true }], links: [] } });
  ok('cannot take a new lead', lead2.status === 400 && /already has its lead/.test(lead2.body?.error || ''));
  const opening2 = await J(`/api/stories/${sid}/compose`, { opening: { text: 'A new beginning' } });
  ok('cannot replace its opening', opening2.status === 400);
  console.log('\nM  one package per story, however often material is accepted');
  const pkgOf = (dd, storyId) => dd.raw.prepare("SELECT id, name, import_id FROM lorebooks WHERE json_valid(original) AND json_extract(original,'$.managedFor.storyId')=?").all(storyId);
  let w = open(dbPath);
  const firstPkg = pkgOf(w, sid);
  const importsBefore = w.raw.prepare("SELECT COUNT(*) n FROM imports WHERE source='builder'").get().n;
  const quayBefore = w.raw.prepare("SELECT content FROM lore_entries WHERE title='The Quay'").get().content;
  const producedBefore = w.raw.prepare("SELECT COUNT(*) n FROM import_resources WHERE kind='lorebook' AND resource_id=?").get(firstPkg[0].id).n;
  w.close();
  const again = await J(`/api/stories/${sid}/compose`, { builder: { mode: 'fill' }, generated: { items: [
    { type: 'entry', draftId: 'q2', origin: 'generated', section: 'places', title: 'The Quay', content: 'A different quay that should not overwrite.' },
    { type: 'entry', draftId: 'gull', origin: 'generated', section: 'places', title: 'Gull Rock', content: 'Where the birds nest.', edited: true },
  ], links: [] } });
  ok('a second accepted generation applies', again.status === 200, JSON.stringify(again.body));
  w = open(dbPath);
  const secondPkg = pkgOf(w, sid);
  ok('still exactly one package, the same one', firstPkg.length === 1 && secondPkg.length === 1 && secondPkg[0].id === firstPkg[0].id);
  ok('its name did not change', secondPkg[0].name === firstPkg[0].name);
  ok('the generation got its own provenance record', w.raw.prepare("SELECT COUNT(*) n FROM imports WHERE source='builder'").get().n === importsBefore + 1);
  ok('and that record lists the same package', w.raw.prepare("SELECT COUNT(*) n FROM import_resources WHERE kind='lorebook' AND resource_id=?").get(firstPkg[0].id).n === producedBefore + 1);
  ok('an accepted entry is not overwritten by a later one with the same kind and name', w.raw.prepare("SELECT content FROM lore_entries WHERE title='The Quay'").get().content === quayBefore
    && w.raw.prepare("SELECT COUNT(*) n FROM lore_entries WHERE title='The Quay'").get().n === 1);
  const gull = w.raw.prepare("SELECT lorebook_id, original FROM lore_entries WHERE title='Gull Rock'").get();
  ok('an edited generated entry persists with edited provenance', gull.lorebook_id === firstPkg[0].id && JSON.parse(gull.original).edited === true && JSON.parse(gull.original).origin === 'generated');
  w.close();
  const twice = await J(`/api/stories/${sid}/compose`, { generated: { items: [{ type: 'entry', draftId: 'gull', origin: 'generated', section: 'places', title: 'Gull Rock', content: 'Where the birds nest.' }], links: [] } });
  w = open(dbPath);
  ok('accepting the same thing twice does not duplicate it', twice.status === 200 && w.raw.prepare("SELECT COUNT(*) n FROM lore_entries WHERE title='Gull Rock'").get().n === 1);
  w.close();
  await J(`/api/stories/${sid}/sources/${firstPkg[0].id}`, null, 'DELETE');
  const reconnect = await J(`/api/stories/${sid}/compose`, { generated: { items: [{ type: 'entry', draftId: 'buoy', origin: 'generated', section: 'items', title: 'Red Buoy', content: 'Marks the channel.' }], links: [] } });
  w = open(dbPath);
  ok('after removing the package from the story, the next apply reconnects the same package', reconnect.status === 200 && pkgOf(w, sid).length === 1
    && w.raw.prepare('SELECT COUNT(*) n FROM story_lorebooks WHERE story_id=? AND lorebook_id=?').get(sid, firstPkg[0].id).n === 1);
  w.close();
  const bibleM = (await J(`/api/stories/${sid}/bible`, null, 'GET')).body;
  ok('the Story Bible marks it as made for this story', bibleM.sources.connected.some((s) => s.id === firstPkg[0].id && s.madeForThisStory === true));
  const libM = (await J('/api/library', null, 'GET')).body;
  ok('the library knows which story it was made for', libM.lorebooks.some((l) => l.id === firstPkg[0].id && l.generated_for === sid));

  console.log('\nN  one review contract, whichever way a draft starts');
  const viaCompose = (await J('/api/compose', { lorebookIds: [book], characterIds: [dario] })).body;
  const viaOrganize = (await J('/api/builder/draft', { mode: 'organize', lorebookIds: [book], characterIds: [dario] })).body;
  reply({ story: { title: 'T', premise: 'P.' }, opening: { text: 'O.' }, people: [{ id: 'z', name: 'Zed Ash', role: 'lead', content: 'Zed Ash.' }], entries: [] });
  const viaIdea = (await J('/api/builder/draft', { mode: 'build', idea: 'a plain idea' })).body;
  const shape = (x) => ['version', 'mode', 'context', 'story', 'casting', 'sections', 'links', 'reused', 'generation', 'invented'].every((k) => k in x);
  ok('an imported source and an idea produce the same draft shape', shape(viaOrganize) && shape(viaIdea));
  ok('organize reads a source exactly as the composer does', JSON.stringify(viaOrganize.casting.map((r) => [r.name, r.suggested])) === JSON.stringify(viaCompose.casting.map((r) => [r.name, r.suggested]))
    && JSON.stringify(viaOrganize.sections.map((s) => s.count)) === JSON.stringify(viaCompose.sections.map((s) => s.count)));
  ok('the same eight sections in both', JSON.stringify(viaOrganize.sections.map((s) => s.id)) === JSON.stringify(viaIdea.sections.map((s) => s.id)));
  const manualDraft = structuredClone(viaOrganize);
  manualDraft.sections.find((s) => s.id === 'items').items.push({ origin: 'manual', draftId: 'hand', title: 'A Letter', content: 'Unopened.', keys: [], kind: 'item' });
  const manualItems = acceptedFromDraft(manualDraft);
  ok('a hand-written item goes through the same apply path', manualItems.items.length === 1 && manualItems.items[0].origin === 'manual');

  console.log('\nO  filling the gaps of a draft being reviewed');
  const edited = structuredClone(build.body);
  const keptPlace = edited.sections.find((s) => s.id === 'places').items.find((i) => i.origin === 'generated');
  keptPlace.content = 'Edited by the person.'; keptPlace.edited = true;
  edited.sections.find((s) => s.id === 'events').items = [];   // the person removed the events
  edited.sections.find((s) => s.id === 'events').count = 0;
  const hitsBefore = seen.length;
  reply({ entries: [{ id: 'new-ev', section: 'events', title: 'A Knock at Night', content: 'Someone at the door.' }, { id: 'no', section: 'places', title: 'Not Asked', content: 'x' }] });
  const beforeFill = dbCounts();
  const filled = await J('/api/builder/fill', { draft: edited });
  const asked = seen[hitsBefore].body.messages[1].content.split('WRITE:')[1];
  ok('asks only for what the reviewed draft is missing', filled.status === 200 && /events/.test(asked) && !/"places"/.test(asked), asked.trim().replace(/\n/g, ' '));
  ok('keeps the person’s edit', filled.body.sections.find((s) => s.id === 'places').items.some((i) => i.content === 'Edited by the person.' && i.edited === true));
  ok('fills the gap', filled.body.sections.find((s) => s.id === 'events').items.some((i) => i.title === 'A Knock at Night'));
  ok('writes nothing', JSON.stringify(dbCounts()) === JSON.stringify(beforeFill));

  const draftExisting = await J('/api/builder/draft', { mode: 'organize', storyId: sid });
  ok('an existing story’s own draft shows its accepted generated people as source material now', draftExisting.status === 200 && draftExisting.body.context === 'existing' && draftExisting.body.casting.some((r) => r.name === 'Tamsin Reed' && r.origin === 'source'));
} finally {
  server.kill();
  fake.close();
  await new Promise((r) => setTimeout(r, 300));
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* the OS may still hold it briefly */ }
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail) process.exitCode = 1;
