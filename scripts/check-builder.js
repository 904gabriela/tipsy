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

// ------------------------------------------------------- database and routes
const dir = mkdtempSync(join(tmpdir(), 'tipsy-builder-'));
const dbPath = join(dir, 'builder.db');
let db = open(dbPath);
const book = db.createLorebook('Harbour — people and places', '');
const ids = {};
for (const e of PACKAGE) { const { id: _, lorebook_id: __, ...rest } = e; ids[e.title] = db.saveEntry(book, { ...rest, order: 100 }); }
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
  try { db.transaction(() => writeGenerated(db, sid, { ...plan, links: [{ from: 'a', characterId: 'no-such-character' }] }, { title: 'Rollback' })); } catch { threw = true; }
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
  const bb = q("SELECT l.id, l.name, l.import_id FROM lorebooks l JOIN story_lorebooks sl ON sl.lorebook_id=l.id WHERE sl.story_id=? AND l.name LIKE '%Story Builder'", sid)[0];
  ok('one Story Builder book, connected to the story', !!bb && q('SELECT COUNT(*) n FROM story_lorebooks WHERE story_id=?', sid)[0].n === 2);
  const rec = bb && q('SELECT source, format, committed_at, analysis FROM imports WHERE id=?', bb.import_id)[0];
  ok('its provenance record says Story Builder', rec?.source === 'builder' && rec.format === 'story-builder' && !!rec.committed_at && JSON.parse(rec.analysis).mode === 'build');
  ok('and what that record produced', q('SELECT kind FROM import_resources WHERE import_id=? ORDER BY kind', bb.import_id).map((r) => r.kind).join() === 'lorebook,story');
  const made = q('SELECT title, kind, original FROM lore_entries WHERE lorebook_id=? ORDER BY title', bb.id);
  ok('exactly the accepted items became entries', made.map((m) => m.title).join('|') === 'Tamsin Reed|The Quay|The Storm', made.map((m) => m.title).join('|'));
  ok('as structured entries of the right kind', made.find((m) => m.title === 'The Quay').kind === 'place' && made.find((m) => m.title === 'The Storm').kind === 'event' && made.find((m) => m.title === 'Tamsin Reed').kind === 'character');
  ok('each remembers it was generated', made.every((m) => JSON.parse(m.original).origin === 'generated' && JSON.parse(m.original).builder === bb.import_id));
  ok('rejected material never persisted', q("SELECT COUNT(*) n FROM lore_entries WHERE title IN ('Lena Marsh','The Debt')")[0].n === 0);
  ok('the generated person is in the cast, lore-backed', q('SELECT n.role FROM story_npcs n JOIN lore_entries e ON e.id=n.entry_id WHERE n.story_id=? AND e.title=?', sid, 'Tamsin Reed')[0]?.role === 'background');
  ok('and did not become a global character', after.characters === before.characters);
  ok('the approved link persisted', q('SELECT COUNT(*) n FROM entry_entry_links l JOIN lore_entries a ON a.id=l.entry_id JOIN lore_entries b ON b.id=l.about_id WHERE a.title=? AND b.title=?', 'The Quay', 'Tamsin Reed')[0].n === 1);
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
  ok('the reviewed opening opens the story', y.pathTo(story.head_id).map((m) => m.content).join() === 'The tide goes out and leaves you on the rocks.');
  ok('the generated title is used', story.title === 'Salt and Iron');
  ok('an entry about the generated lead links to the card', y.loreAboutCharacter(card.id).some((e) => e.title === 'The Wreck'));
  y.close();

  console.log('\nL  an existing story');
  const existing = await J(`/api/stories/${sid}/compose`, { generated: { items: [{ type: 'entry', draftId: 'lamp', origin: 'manual', section: 'items', title: 'The Storm Lamp', content: 'Kept lit for the ferry.' }], links: [] } });
  ok('accepts generated or hand-written additions', existing.status === 200 && existing.body.generatedEntries === 1, JSON.stringify(existing.body));
  const z = open(dbPath);
  const handBook = z.raw.prepare("SELECT l.name, l.import_id FROM lorebooks l JOIN story_lorebooks sl ON sl.lorebook_id=l.id WHERE sl.story_id=? AND l.name LIKE '%written for this story'").get(sid);
  ok('hand-written material has no Story Builder record', !!handBook && handBook.import_id === null);
  z.close();
  const lead2 = await J(`/api/stories/${sid}/compose`, { generated: { items: [{ ...nico, name: 'Other Lead', promote: true }], links: [] } });
  ok('cannot take a new lead', lead2.status === 400 && /already has its lead/.test(lead2.body?.error || ''));
  const opening2 = await J(`/api/stories/${sid}/compose`, { opening: { text: 'A new beginning' } });
  ok('cannot replace its opening', opening2.status === 400);
  const draftExisting = await J('/api/builder/draft', { mode: 'organize', storyId: sid });
  ok('an existing story’s own draft shows its generated people as source now', draftExisting.status === 200 && draftExisting.body.context === 'existing' && draftExisting.body.casting.some((r) => r.name === 'Tamsin Reed' && r.origin === 'source' && r.current === 'background'));
} finally {
  server.kill();
  fake.close();
  await new Promise((r) => setTimeout(r, 300));
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* the OS may still hold it briefly */ }
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail) process.exitCode = 1;
