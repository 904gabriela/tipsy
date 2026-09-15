// Nexus Story Package v1: validation, trusted import, export, round trips.
//
//   node scripts/check-package.js
//
// Throwaway databases and a throwaway server. A counting stand-in for the
// model provider proves nothing on the package routes calls one.

import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { open } from '../src/db/index.js';
import { validatePackage, canonicalPackage } from '../src/package/format.js';
import { inspectPackage, importPackage } from '../src/package/import.js';
import { exportStory, exportSources } from '../src/package/export.js';
import { createEntity, setEntrySemantics, semanticViews } from '../src/semantics/store.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(here, 'fixtures', 'nexus-package-v1-saint-like.json'), 'utf8'));
const STORY = 'a-saint-like-story';

let pass = 0; let fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? `  — ${d}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? `  — ${d}` : ''}`); }
};
const clone = (v) => JSON.parse(JSON.stringify(v));
const tmp = () => join(mkdtempSync(join(tmpdir(), 'tipsy-package-')), 'p.db');
const fresh = () => open(tmp());
const errorsOf = (pkg) => validatePackage(pkg).errors;
const refused = (mutate, re) => {
  const pkg = clone(FIXTURE);
  mutate(pkg);
  const errs = errorsOf(pkg);
  return errs.some((e) => re.test(`${e.path} ${e.message}`)) ? true : (console.log('      got:', JSON.stringify(errs.slice(0, 3))), false);
};
const count = (db, t) => db.raw.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
const allCreate = { characters: { 'patrick-card': { use: 'create' } }, personas: { 'reiko-ryuusui': { use: 'create' } } };
const entries = (pkg, source) => pkg.sources.find((s) => s.ref === source).entries;

// ---------------------------------------------------------------- A
console.log('A  validation');
{
  const v = validatePackage(FIXTURE);
  ok('the fixture is a valid v1 package', v.ok, JSON.stringify(v.errors.slice(0, 2)));
  const visibility = (pkg) => { entries(pkg, 'reiko-knowledge')[0].visibility = 'private'; };
  ok('visibility on an entry is refused, and says why', refused(visibility, /reserved for a later package version/));
  ok('visibility inside semantics is refused too', refused((p) => { entries(p, 'reiko-knowledge')[0].semantics.visibility = 'hidden'; }, /reserved/)
    && refused((p) => { entries(p, 'reiko-knowledge')[0].semantics.knownBy = ['patrick']; }, /reserved/));
  ok('vendor data under extensions is allowed and not interpreted', validatePackage((() => { const p = clone(FIXTURE); entries(p, 'reiko-knowledge')[0].extensions = { someApp: { visibility: 'private' } }; return p; })()).ok);
  ok('an unknown field is an error, not silently dropped', refused((p) => { p.characters[0].backstory = 'flattened'; }, /not part of Nexus Package v1/));
  ok('"auto" activation is reserved', refused((p) => { entries(p, 'patrick-knowledge')[0].activation.policy = 'auto'; }, /reserved and not available/));
  ok('keywords policy needs a keyword', refused((p) => { entries(p, 'patrick-knowledge')[0].activation.keys = []; }, /at least one keyword/));
  ok("a universe's word is not a category", refused((p) => { entries(p, 'reiko-knowledge')[0].semantics.category = 'quirk'; }, /displayPath/));
  ok('the deep categories are accepted', ['skill', 'ability', 'equipment', 'belief', 'habit'].every((category) => validatePackage((() => { const p = clone(FIXTURE); entries(p, 'reiko-knowledge')[0].semantics.category = category; return p; })()).ok));
  ok('an entity entry names its subject or what it defines', refused((p) => { delete entries(p, 'reiko-knowledge')[0].semantics.subject; }, /subject.*defines/));
  ok('subject and defines together are refused', refused((p) => { entries(p, 'patrick-knowledge')[2].semantics.subject = 'patrick'; }, /either defines an entity or is about one/));
  ok('refs must exist', refused((p) => { entries(p, 'patrick-knowledge')[0].semantics.subject = 'nobody'; }, /not an entity in this package/));
  ok('a character must be a person', refused((p) => { p.entities.push({ ref: 'harbour', type: 'place', name: 'Harbour' }); p.characters[0].entity = 'harbour'; }, /only a person/));
  ok('refs are unique', refused((p) => { p.entities.push({ ref: 'reiko', type: 'person', name: 'Other Reiko' }); }, /used twice/));
  ok('a source cannot be reusable material and story material at once', refused((p) => { p.sources[0].story = STORY; }, /not both/));
  ok("story material must be attached to its own story", refused((p) => { p.stories[0].sources = p.stories[0].sources.filter((s) => s.source !== 'saint-material'); }, /does not attach it/));
  ok('a story has exactly one lead', refused((p) => { p.stories[0].cast[0].role = 'cast'; }, /exactly one lead/));
  ok('a displayPath is a short list of names', refused((p) => { entries(p, 'reiko-knowledge')[0].semantics.displayPath = []; }, /one to eight/)
    && refused((p) => { entries(p, 'reiko-knowledge')[0].semantics.displayPath = ['Quirk', '']; }, /one to eight/));
  ok('a newer version is named as newer', refused((p) => { p.version = 2; }, /this Nexus reads version 1/));
  ok('exclusions must point into attached sources', refused((p) => { p.stories[0].exclusions = [{ source: 'patrick-knowledge', entry: 'nope' }]; }, /is not an entry/));
}

// ---------------------------------------------------------------- B
console.log('\nB  trusted import writes exactly what the package says');
const db = fresh();
const res = importPackage(db, FIXTURE, { decisions: allCreate });
{
  const patrick = res.entities.patrick;
  const reiko = res.entities.reiko;
  const salvatore = res.entities.salvatore;
  const card = db.raw.prepare('SELECT * FROM characters WHERE id=?').get(res.characters['patrick-card']);
  const persona = db.raw.prepare('SELECT * FROM personas WHERE id=?').get(res.personas['reiko-ryuusui']);
  ok('three entities, no more', count(db, 'lore_entities') === 3);
  ok('the card is bound to its own entity', card.entity_id === patrick);
  ok('the persona is bound to its own entity', persona.entity_id === reiko);
  ok('Character Core lands in its slots, not in the description', card.description.startsWith('A soft-spoken fixer') && card.appearance.startsWith('Tall, dark coat')
    && card.behavior.startsWith('Listens') && card.speech_style.startsWith('Short sentences') && !card.description.includes('scar'));
  ok('Persona Core lands in its slots', persona.description.startsWith('A second-year') && persona.appearance.includes('tattoo') && persona.personality.startsWith('Quick') && persona.speech_style.includes('Spanish') && persona.behavior === null);
  const role = (ref) => db.raw.prepare('SELECT * FROM source_semantics WHERE lorebook_id=?').get(res.sources[ref]);
  ok('reusable knowledge belongs with its person', role('patrick-knowledge').subject_entity_id === patrick && role('reiko-knowledge').subject_entity_id === reiko
    && role('patrick-knowledge').owner_story_id === null);
  ok("story material belongs to its story only", role('saint-material').owner_story_id === res.stories[STORY] && role('saint-material').subject_entity_id === null);
  ok('roles are approved and native', ['patrick-knowledge', 'reiko-knowledge', 'living-scene', 'saint-material'].every((r) => role(r).status === 'approved' && role(r).origin === 'native')
    && role('living-scene').package_role === 'narrative-framework');
  const sem = (s, e) => db.raw.prepare('SELECT * FROM entry_semantics WHERE entry_id=?').get(res.entries[s][e]);
  const rel = (s, e) => db.raw.prepare('SELECT entity_id, relation, status, origin FROM entry_relations WHERE entry_id=? ORDER BY relation').all(res.entries[s][e]);
  ok('source ownership does not make every entry about its subject', sem('patrick-knowledge', 'salvatore').defines_entity_id === salvatore
    && rel('patrick-knowledge', 'salvatore').length === 1 && rel('patrick-knowledge', 'salvatore')[0].relation === 'related');
  ok('subject relations are approved and native', rel('reiko-knowledge', 'fluid-domain')[0].entity_id === reiko && rel('reiko-knowledge', 'fluid-domain').every((r) => r.status === 'approved' && r.origin === 'native'));
  ok('the display path is kept as given', sem('reiko-knowledge', 'fluid-domain-limits').display_path === '["Quirk","Fluid Domain"]');
  ok('an entry without semantics stays unorganised', !sem('living-scene', 'unorganised-note'));
  ok('nothing is merely proposed', db.raw.prepare("SELECT (SELECT COUNT(*) FROM entry_semantics WHERE status<>'approved') + (SELECT COUNT(*) FROM entry_relations WHERE status<>'approved') + (SELECT COUNT(*) FROM source_entities WHERE status<>'approved') n").get().n === 0);
  ok('each source declares the people it speaks of, under the package refs', db.raw.prepare('SELECT local_ref FROM source_entities WHERE lorebook_id=? ORDER BY local_ref').all(res.sources['saint-material']).map((r) => r.local_ref).join() === 'patrick,reiko');
  const e = (s, r) => db.raw.prepare('SELECT * FROM lore_entries WHERE id=?').get(res.entries[s][r]);
  ok('activation arrives exactly', e('patrick-knowledge', 'childhood').case_sensitive === 1 && e('patrick-knowledge', 'childhood').secondary_keys === '["bakery"]'
    && e('patrick-knowledge', 'salvatore').probability === 80 && e('patrick-knowledge', 'salvatore').sticky === 2 && e('patrick-knowledge', 'salvatore').grp === 'family'
    && e('living-scene', 'stay-in-scene').constant === 1 && e('living-scene', 'unorganised-note').enabled === 0);
  ok('the legacy kind is read off the semantics, never guessed', e('patrick-knowledge', 'salvatore').kind === 'character' && e('living-scene', 'stay-in-scene').kind === 'direction' && e('living-scene', 'unorganised-note').kind === 'note');
  const story = db.getStory(res.stories[STORY]);
  ok('the story has its lead, persona, sources and recursion', story.characters[0].id === card.id && story.persona_id === persona.id && story.lorebookIds.length === 4
    && db.storyLorebookSettings(story.id).filter((r) => r.recursion === 'block').length === 3);
  ok('exclusions and lore-backed cast arrive', db.storyExclusionIds(story.id).has(res.entries['patrick-knowledge']['old-rumour'])
    && db.storyNpcs(story.id).length === 1 && db.storyNpcs(story.id)[0].entity_id === salvatore);
  ok('the story knows which card is which person', db.raw.prepare('SELECT character_id FROM story_entity_cards WHERE story_id=? AND entity_id=?').get(story.id, patrick)?.character_id === card.id);
  ok('directions and premise are the story’s own', story.settings.directions === 'Keep the harbour cold and the stakes personal.' && story.settings.premise.startsWith('A hero student'));
  ok('the import is recorded with the package id', db.getImport(res.importId).analysis.packageId === 'fixture.saint-like.v1' && db.importOf('story', story.id) === res.importId);
  ok('no old-style links and no link evidence were written', count(db, 'entry_character_links') + count(db, 'entry_entry_links') + count(db, 'legacy_entry_links') === 0);
}

// ---------------------------------------------------------------- C
console.log('\nC  round trips');
const E1 = exportStory(db, res.stories[STORY]);
{
  ok('export → the fixture, byte for byte (canonical form)', JSON.stringify(E1.package) === JSON.stringify(canonicalPackage(FIXTURE)));
  ok('no omissions were needed', E1.warnings.length === 0, JSON.stringify(E1.warnings));
  const db2 = fresh();
  const r2 = importPackage(db2, E1.package, { decisions: allCreate });
  const E2 = exportStory(db2, r2.stories[STORY]);
  ok('export → import → export is byte-identical (fresh library)', JSON.stringify(E2.package) === JSON.stringify(E1.package));
  const r3 = importPackage(db, E1.package, { decisions: allCreate });
  const E3 = exportStory(db, r3.stories[STORY]);
  ok('and again into the same library, alongside the first copy', JSON.stringify(E3.package) === JSON.stringify(E1.package) && r3.stories[STORY] !== res.stories[STORY]);
  const p = E2.package;
  ok('entity refs survive', p.entities.map((x) => x.ref).join() === 'patrick,reiko,salvatore');
  ok('Character Core and Persona Core survive', p.characters[0].core.appearance.startsWith('Tall') && p.personas[0].core.speechStyle.includes('Spanish'));
  ok('reusable ownership and story-only material survive', p.sources.find((s) => s.ref === 'reiko-knowledge').subject === 'reiko' && p.sources.find((s) => s.ref === 'saint-material').story === STORY);
  ok('subject / related / defines survive', JSON.stringify(entries(p, 'patrick-knowledge').find((x) => x.ref === 'salvatore').semantics) === '{"scope":"entity","category":"profile","defines":"salvatore","related":["patrick"],"displayPath":["Relationships"]}');
  ok('displayPath survives', JSON.stringify(entries(p, 'reiko-knowledge')[1].semantics.displayPath) === '["Quirk","Fluid Domain"]');
  ok('extensions survive where v1 keeps them', p.package.extensions?.fixture && p.extensions?.fixture?.suite === 'check-package' && p.characters[0].extensions?.fixture?.cardVariant === 'a' && p.sources.find((s) => s.ref === 'patrick-knowledge').extensions?.fixture);

  const sourceOnly = exportSources(db, [res.sources['reiko-knowledge']]);
  ok('a reusable source exports on its own', sourceOnly.package.sources.length === 1 && sourceOnly.package.stories.length === 0 && sourceOnly.package.entities.map((x) => x.ref).join() === 'reiko');
  const db4 = fresh();
  const r4 = importPackage(db4, sourceOnly.package);
  ok('and imports on its own, making no card or persona by default', count(db4, 'characters') === 0 && count(db4, 'personas') === 0 && count(db4, 'stories') === 0 && Object.keys(r4.sources).length === 1);
  ok('source-only round trip is byte-identical', JSON.stringify(exportSources(db4, [r4.sources['reiko-knowledge']]).package) === JSON.stringify(sourceOnly.package));
}

// ---------------------------------------------------------------- D
console.log('\nD  decisions meet the library you already have');
{
  const lib = fresh();
  const pre = inspectPackage(lib, FIXTURE);
  ok('in an empty library: new entities, a new card, a new persona', Object.values(pre.decisions.entities).every((d) => d.use === 'new') && pre.decisions.characters['patrick-card'].use === 'create' && pre.decisions.personas['reiko-ryuusui'].use === 'create');
  const existingCard = lib.writeCharacter({ name: 'Patrick Moretti', description: 'Someone already in the library.' });
  const withCard = inspectPackage(lib, FIXTURE);
  ok('a card with the same name is proposed, not assumed', withCard.decisions.characters['patrick-card'].use === 'existing' && withCard.decisions.characters['patrick-card'].id === existingCard && withCard.candidates.characters['patrick-card'].id === existingCard);
  const sourceOnly = clone(FIXTURE);
  sourceOnly.stories = [];
  sourceOnly.sources = sourceOnly.sources.filter((s) => !s.story);
  sourceOnly.package.role = 'character-material';
  ok('a package without stories makes no card unless asked', inspectPackage(lib, sourceOnly).decisions.characters['patrick-card'].use === 'skip');

  const r = importPackage(lib, FIXTURE, { decisions: { personas: { 'reiko-ryuusui': { use: 'create' } } } });
  ok('using an existing card leaves that card unbound: no guess written into it', lib.getCharacter(existingCard).entity_id === null
    && lib.getStory(r.stories[STORY]).characters[0].id === existingCard);
  ok('the story still records which person that card is here', lib.raw.prepare('SELECT character_id FROM story_entity_cards WHERE story_id=? AND entity_id=?').get(r.stories[STORY], r.entities.patrick)?.character_id === existingCard);

  const known = createEntity(lib, { type: 'person', name: 'Reiko Ryuusui' });
  const before = count(lib, 'lore_entities');
  const r2 = importPackage(lib, FIXTURE, { decisions: { entities: { reiko: { use: 'existing', id: known } }, ...allCreate } });
  ok('reusing an existing entity is an explicit choice, and honoured', r2.entities.reiko === known && count(lib, 'lore_entities') === before + 2
    && lib.raw.prepare('SELECT subject_entity_id FROM source_semantics WHERE lorebook_id=?').get(r2.sources['reiko-knowledge']).subject_entity_id === known);

  const place = createEntity(lib, { type: 'place', name: 'A Pier' });
  const snapshot = ['lore_entities', 'characters', 'personas', 'lorebooks', 'lore_entries', 'stories', 'entry_semantics', 'imports'].map((t) => count(lib, t)).join();
  let wrongType = null;
  try { importPackage(lib, FIXTURE, { decisions: { entities: { reiko: { use: 'existing', id: place } }, ...allCreate } }); } catch (e) { wrongType = e; }
  ok('an existing entity of the wrong type is refused', /is a place, not a person/.test(JSON.stringify(wrongType?.errors || [])));
  const bound = lib.writeCharacter({ name: 'Bound Card' });
  lib.raw.prepare('UPDATE characters SET entity_id=? WHERE id=?').run(known, bound);
  let conflict = null;
  try { importPackage(lib, FIXTURE, { decisions: { characters: { 'patrick-card': { use: 'existing', id: bound } }, personas: { 'reiko-ryuusui': { use: 'create' } } } }); } catch (e) { conflict = e; }
  ok('a card that already represents someone else is refused', /already represents a different person/.test(JSON.stringify(conflict?.errors || [])));
  let skipped = null;
  try { importPackage(lib, FIXTURE, { decisions: { characters: { 'patrick-card': { use: 'skip' } } } }); } catch (e) { skipped = e; }
  ok('skipping a cast member is refused with a reason', /no card was chosen/.test(JSON.stringify(skipped?.errors || [])));
  lib.raw.prepare('UPDATE characters SET entity_id=NULL WHERE id=?').run(bound);
  ok('a refused import leaves nothing behind', ['lore_entities', 'characters', 'personas', 'lorebooks', 'lore_entries', 'stories', 'entry_semantics', 'imports'].map((t) => count(lib, t)).join()
    === snapshot.split(',').map((n, i) => (i === 1 ? Number(n) + 1 : Number(n))).join(), 'one card was added by the test itself');
  ok('inspect warns that a package was imported before', inspectPackage(lib, FIXTURE).warnings.some((w) => /imported before/.test(w.message)));
}

// ---------------------------------------------------------------- E
console.log('\nE  export never launders a guess');
{
  const lib = fresh();
  const r = importPackage(lib, FIXTURE, { decisions: allCreate });
  const limits = r.entries['reiko-knowledge']['fluid-domain-limits'];
  lib.saveEntry(r.sources['reiko-knowledge'], { id: limits, content: 'Edited after approval.' });
  const childhood = r.entries['patrick-knowledge'].childhood;
  setEntrySemantics(lib, { entryId: childhood, scope: 'entity', category: 'backstory', origin: 'inferred', status: 'proposed' });
  const out = exportStory(lib, r.stories[STORY]);
  const find = (s, ref) => entries(out.package, s).find((x) => x.ref === ref);
  ok('an entry changed since approval goes out unorganised, with a warning', !find('reiko-knowledge', 'fluid-domain-limits').semantics && out.warnings.some((w) => /needs a recheck/.test(w.message)));
  ok('proposed semantics go out unorganised, with a warning', !find('patrick-knowledge', 'childhood').semantics && out.warnings.some((w) => /only proposed/.test(w.message)));
  const bare = lib.createLorebook('Unclassified notes', '');
  lib.setStoryLorebooks(r.stories[STORY], [...lib.getStory(r.stories[STORY]).lorebookIds, bare]);
  let blocked = null;
  try { exportStory(lib, r.stories[STORY]); } catch (e) { blocked = e; }
  ok('a source with no approved role blocks export instead of being given one', /no approved package role/.test(blocked?.message || ''));
  let foreign = null;
  try { exportSources(lib, [r.sources['saint-material']]); } catch (e) { foreign = e; }
  ok("a story's own material is not exported without its story", /another story's own material/.test(foreign?.message || ''));
}

// ---------------------------------------------------------------- F
console.log('\nF  story-only knowledge stays in its story');
{
  const lib = fresh();
  const a = importPackage(lib, FIXTURE, { decisions: allCreate });
  const b = importPackage(lib, FIXTURE, { decisions: allCreate });
  const owned = (id) => lib.raw.prepare('SELECT lorebook_id FROM source_semantics WHERE owner_story_id=?').all(id).map((r) => r.lorebook_id);
  ok('each story has its own material', owned(a.stories[STORY]).length === 1 && owned(b.stories[STORY]).length === 1 && owned(a.stories[STORY])[0] !== owned(b.stories[STORY])[0]);
  ok("neither story reads the other's", !lib.getStory(a.stories[STORY]).lorebookIds.includes(owned(b.stories[STORY])[0]));
  const later = lib.createStory({ title: 'Made afterwards', characterIds: [a.characters['patrick-card']] });
  ok('a story made later gets no knowledge attached by itself', lib.getStory(later).lorebookIds.length === 0);
}

// ---------------------------------------------------------------- G
console.log('\nG  through the server: no classifier, no model, Core reaches the prompt');
{
  let providerCalls = 0;
  const provider = createServer((req, rq) => { providerCalls++; rq.writeHead(500); rq.end('{}'); });
  await new Promise((r) => provider.listen(0, r));
  const PORT = 8900 + Math.floor(Math.random() * 90);
  const server = spawn(process.execPath, ['server.js'], {
    cwd: join(here, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: tmp(), OPENROUTER_ENDPOINT: `http://localhost:${provider.address().port}`, OPENROUTER_API_KEY: 'not-a-real-key' },
    stdio: 'ignore',
  });
  const B = `http://localhost:${PORT}`;
  for (let i = 0; i < 80; i++) { try { await fetch(B); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
  const J = (p, body) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const G = (p) => fetch(B + p).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const bad = clone(FIXTURE);
    entries(bad, 'reiko-knowledge')[0].visibility = 'private';
    const refusedRoute = await J('/api/packages/import', { package: bad });
    ok('the route refuses an invalid package and lists the problems', refusedRoute.status === 400 && refusedRoute.body.errors?.some((e) => /reserved/.test(e.message)));
    const inspected = await J('/api/packages/inspect', { package: FIXTURE });
    ok('inspect proposes decisions', inspected.status === 200 && inspected.body.decisions.characters['patrick-card'].use === 'create');
    const imported = await J('/api/packages/import', { package: FIXTURE, decisions: allCreate, filename: 'saint-like.json' });
    ok('import through the route', imported.status === 200 && imported.body.stories[STORY], JSON.stringify(imported.body).slice(0, 200));
    const sid = imported.body.stories[STORY];
    ok('no request reached the model provider', providerCalls === 0, `${providerCalls} calls`);
    const exported = await G(`/api/stories/${sid}/package`);
    ok('export through the route matches the fixture', exported.status === 200 && JSON.stringify(exported.body.package) === JSON.stringify(canonicalPackage(FIXTURE)));
    const story = await G(`/api/stories/${sid}`);
    ok("the story opens with its lead's first line", story.body.messages.length === 1 && story.body.messages[0].content.includes('You came alone'));

    const prompt = await G(`/api/stories/${sid}/prompt`);
    const stable = prompt.body.messages.find((m) => m.role === 'system' && !m.volatile)?.content || '';
    ok('Character Core slots reach the prompt under the character', /# Patrick\n[\s\S]*## Appearance\nTall, dark coat[\s\S]*## Behaviour\nListens[\s\S]*## Voice\nShort sentences/.test(stable));
    ok('Persona Core slots reach the prompt under the persona', /# Reiko Ryuusui\n[\s\S]*A second-year hero student[\s\S]*## Appearance\n[^\n]*tattoo/.test(stable));
    const all = prompt.body.messages.map((m) => m.content).join('\n');
    ok('persona knowledge is not flattened into the persona: unmatched entries stay out', !all.includes('Holding a shape for more than a minute') && !all.includes('will not use the quirk to drown'));
    ok('the always-on framework direction is in', all.includes('Never summarise what happens next'));
    ok('no request reached the model provider afterwards either', providerCalls === 0);

    const toSource = (await G('/api/library')).body;
    ok('the library still lists everything', Array.isArray(toSource.lorebooks) && toSource.lorebooks.length === 4);
  } finally {
    server.kill();
    provider.close();
  }
}

// ---------------------------------------------------------------- H
console.log('\nH  displayPath is presentation only; nothing heuristic is imported');
{
  const lib = fresh();
  const r = importPackage(lib, FIXTURE, { decisions: allCreate });
  const ids = Object.values(r.entries['reiko-knowledge']);
  const view = (id) => semanticViews(lib, lib.listEntries(r.sources['reiko-knowledge'])).get(id);
  const beforeView = JSON.stringify({ ...view(ids[0]), displayPath: null });
  const beforeEntries = JSON.stringify(lib.entriesForStory(r.stories[STORY]));
  lib.raw.prepare('UPDATE entry_semantics SET display_path=? WHERE entry_id IN (' + ids.map(() => '?').join(',') + ')').run('["Something Else","Entirely"]', ...ids);
  ok('changing a display path changes no entry the engine reads', JSON.stringify(lib.entriesForStory(r.stories[STORY])) === beforeEntries);
  ok('and nothing in the semantic reading except the path itself', JSON.stringify({ ...view(ids[0]), displayPath: null }) === beforeView && view(ids[0]).state === 'approved');

  const pkgDir = join(here, '..', 'src', 'package');
  const imports = readdirSync(pkgDir).flatMap((f) => [...readFileSync(join(pkgDir, f), 'utf8').matchAll(/from '([^']+)'/g)].map((m) => `${f}: ${m[1]}`));
  const forbidden = imports.filter((i) => /import\/|llm\/|builder\/|classify|compose|plan/.test(i));
  ok('the package modules import no classifier, composer, builder or provider', forbidden.length === 0, forbidden.join('; ') || imports.map((i) => i.split(': ')[1]).join(', '));
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exitCode = fail ? 1 : 0;
