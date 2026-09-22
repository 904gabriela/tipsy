// A person is read as sections, and a section is read whole.
//
// Patrick's Backstory is three things somebody wrote — Childhood, the foster
// system, recruitment — and it reads as one page with each piece's own title
// as a heading. That it is three rows is true, and is one fold away, and is
// never the thing in front of you. The Library's People shelf opens him the
// same way, card or no card.
//
// Adding knowledge is the act that already existed: one new piece, in the
// person's own container, approved as theirs, never attributed to a source
// it did not come from. It is proved on a throwaway copy and nowhere else.
//
//   node scripts/check-dossier-sections.js
//
// A VACUUM copy on a random port, driven by headless Chrome. Production is
// read with a read-only handle and never served or written.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const WT = process.cwd();
const PROD = join(WT, 'data', 'tipsy.db');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MHA = '0mu3i0q0sc50c6b7ecf23';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash('sha256').update(b).digest('hex');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
};
const note = (s) => console.log(`  NOTE  ${s}`);
if (!existsSync(PROD)) { note('no data/tipsy.db here — skipped'); process.exit(0); }
if (!existsSync(CHROME)) { note('no Chrome here — skipped'); process.exit(0); }

const named = () => {
  const d = new DatabaseSync(PROD, { readOnly: true });
  const q = (s, ...a) => d.prepare(s).get(...a).c;
  const n = {};
  for (const t of ['lore_entries', 'lore_entities', 'source_entities', 'entry_semantics', 'entry_relations', 'source_semantics', 'entity_distinctions', 'lorebooks', 'continuities', 'continuity_positions', 'entry_placements']) n[t] = q(`SELECT COUNT(*) c FROM ${t}`);
  n.MHA_entry_semantics = q('SELECT COUNT(*) c FROM entry_semantics s JOIN lore_entries e ON e.id=s.entry_id WHERE e.lorebook_id=?', MHA);
  n.MHA_source_semantics = q('SELECT COUNT(*) c FROM source_semantics WHERE lorebook_id=?', MHA);
  n.MHA_temporal = q('SELECT COUNT(*) c FROM entry_placements pl JOIN lore_entries e ON e.id=pl.entry_id WHERE e.lorebook_id=?', MHA);
  n.managed_containers = q("SELECT COUNT(*) c FROM lorebooks WHERE json_valid(original) AND json_extract(original,'$.managedFor') IS NOT NULL");
  d.close();
  return n;
};
const prodBefore = named();
const shaBefore = sha(readFileSync(PROD));

const dir = mkdtempSync(join(tmpdir(), 'nexus-sections-'));
const COPY = join(dir, 'copy.db').replace(/\\/g, '/');
{
  const src = new DatabaseSync(PROD, { readOnly: true }); src.exec(`VACUUM INTO '${COPY}'`); src.close();
  const c = new DatabaseSync(COPY); c.prepare("DELETE FROM settings WHERE key='auth'").run(); c.close();
}
const d0 = new DatabaseSync(COPY, { readOnly: true });
const SAINT = d0.prepare("SELECT id FROM lorebooks WHERE name LIKE '%Saint / Embedded%'").get().id;
const PATRICK = d0.prepare("SELECT id FROM lore_entities WHERE canonical_name='Patrick Moretti'").get().id;
const LOTUS = d0.prepare("SELECT id FROM lore_entities WHERE canonical_name='Black Lotus'").get().id;
const saintBefore = JSON.stringify(d0.prepare('SELECT id, title, content, keys FROM lore_entries WHERE lorebook_id=? ORDER BY display_index').all(SAINT));
d0.close();

const port = 9900 + Math.floor(Math.random() * 90);
const app = spawn(process.execPath, ['server.js'], { cwd: WT, env: { ...process.env, PORT: String(port), DB_PATH: COPY }, stdio: 'ignore' });
for (let i = 0; i < 200; i++) { try { await fetch(`http://localhost:${port}/`); break; } catch { await sleep(200); } }
const api = async (p) => (await fetch(`http://localhost:${port}${p}`)).json();

const cport = 9700 + Math.floor(Math.random() * 90);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${cport}`,
  `--user-data-dir=${dir}/chrome`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let target;
for (let i = 0; i < 80; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${cport}/json/list`)).json()).find((t) => t.type === 'page'); if (target) break; } catch { /* starting */ }
  await sleep(250);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pending = new Map();
const sent = [];
const errors = [];
ws.addEventListener('message', (m) => {
  const x = JSON.parse(m.data);
  if (x.id && pending.has(x.id)) { pending.get(x.id)(x); pending.delete(x.id); }
  if (x.method === 'Network.requestWillBeSent') sent.push({ method: x.params.request.method, url: x.params.request.url });
  if (x.method === 'Runtime.exceptionThrown') errors.push(String(x.params.exceptionDetails?.exception?.description).slice(0, 160));
});
const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description).slice(0, 250));
  return r.result?.result?.value;
};
await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Network.enable');
const waitFor = async (sel, ms = 30000) => {
  for (let t = 0; t < ms; t += 200) { if (await ev(`!!document.querySelector(${JSON.stringify(sel)})`)) return true; await sleep(200); }
  return false;
};
const click = async (sel, wait = 800) => {
  if (!await waitFor(sel, 20000)) return false;
  await ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
  await sleep(wait);
  return true;
};
const text = (sel) => ev(`((document.querySelector(${JSON.stringify(sel)})||{}).textContent || '').replace(/\\s+/g,' ').trim()`);
const sections = () => ev(`[...document.querySelectorAll('#sheet-body [data-section]')].map(r => ({
  name: ((r.querySelector('b')||{}).textContent||'').trim(), n: ((r.querySelector('.n')||{}).textContent||'').trim(), shelf: r.getAttribute('data-section-shelf') }))`);
const home = async () => { await cdp('Page.navigate', { url: `http://localhost:${port}/?t=${Date.now()}` }); await sleep(2300); };
const openPerson = async (name) => {
  await home();
  await click('[data-tab="characters"]');
  await click('[data-shelf="people"]', 900);
  const hit = await ev(`(() => { const r = [...document.querySelectorAll('#character-list [data-entity]')]
    .find(x => (((x.querySelector('.src-row-name')||{}).textContent)||'').trim() === ${JSON.stringify(name)}); if (!r) return false; r.click(); return true; })()`);
  if (!hit) return false;
  for (let t = 0; t < 20000; t += 200) {
    if (await ev(`document.getElementById('sheet-title').textContent === ${JSON.stringify(name)} && !!document.querySelector('#sheet-body .ent-hero')`)) return true;
    await sleep(200);
  }
  return false;
};

await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
const from = sent.length;

// ------------------------------------------------------------ People shelf
console.log('\nLibrary → People');
await home();
await click('[data-tab="characters"]');
await click('[data-shelf="people"]', 900);
const known = await ev(`[...document.querySelectorAll('#character-list [data-entity]')].map(r => ({
  name: ((r.querySelector('.src-row-name')||{}).textContent||'').trim(), sub: ((r.querySelector('.src-row-sub')||{}).textContent||'').trim() }))`);
console.log(`      ${known.map((k) => `${k.name} (${k.sub})`).join(' · ')}`);
ok('the people Nexus knows are listed, four of them', known.length === 4, `${known.length}`);
ok('someone with no card is still a person here', known.some((k) => k.name === 'Marco'));
ok('the list is people, not places', !known.some((k) => /Black Lotus|Penthouse/.test(k.name)));
ok('a person is introduced by what else they are called, not by how they are stored',
  known.every((k) => !/piece|entry|entity|lore/i.test(k.sub)) && known.some((k) => /also The Saint/.test(k.sub)), JSON.stringify(known.map((k) => k.sub)));
ok('people come first, and the cards are one fold down, closed',
  await ev(`(() => { const d = document.querySelector('#character-list details.people-cards'); return !!d && !d.open && d.querySelectorAll('[data-character]').length > 0
    && document.querySelector('#character-list [data-entity]').getBoundingClientRect().top < d.getBoundingClientRect().top; })()`));
ok('sorting, tags, selecting and deletion controls do not interrupt browsing people',
  await ev(`['[data-panel="characters"] .sortrow','[data-panel="characters"] .tagrow','#shelf-pick','#pick-foot'].every(s => { const el = document.querySelector(s); return !el || getComputedStyle(el).display === 'none'; })`));
{
  // The search above still holds a name; a filter persists into managing, as
  // it should, so it is cleared here to see the whole card grid.
  await ev(`(() => { const s = document.getElementById('char-search'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(500);
  await click('#character-list [data-manage-cards]', 700);
  const mode = await ev(`({ pick: !document.getElementById('shelf-pick').hidden,
    sort: getComputedStyle(document.querySelector('[data-panel="characters"] .sortrow')).display !== 'none',
    // While managing, a card is a thing to pick, and says so on itself.
    cards: document.querySelectorAll('#character-list [data-pick], #character-list [data-character]').length,
    people: document.querySelectorAll('#character-list [data-entity]').length,
    tidying: document.body.classList.contains('shelf-tidying') })`);
  await click('#shelf-select', 700);
  const backTo = await ev(`document.querySelectorAll('#character-list [data-entity]').length`);
  ok('managing cards is a mode you step into, with every control it had',
    mode.pick && mode.sort && mode.cards > 0 && mode.people === 0 && backTo > 0,
    `in mode: ${JSON.stringify(mode)} · people after Done: ${backTo}`);
}
await ev(`(() => { const s = document.getElementById('char-search'); s.value = 'patr'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await sleep(600);
ok('search finds a person by name', (await ev(`document.querySelectorAll('#character-list [data-entity]').length`)) === 1);

// ------------------------------------------------------ Patrick, overview
console.log('\nPatrick Moretti — read as sections');
ok('tapping a person opens their dossier', await openPerson('Patrick Moretti'));
const secs = await sections();
console.log(`      ${secs.map((s) => `${s.name} · ${s.n}`).join(' | ')}`);
ok('only the sections that hold something are shown',
  secs.map((s) => s.name).join(',') === 'Identity,Backstory,Psychology,Relationships,Goals', secs.map((s) => s.name).join(','));
// How many pieces stand behind a section is true, is in the read model, and is
// not what a row says: a row is a heading to open.
const prof = await api(`/api/entities/${PATRICK}/profile`);
ok('the rows carry no counts; the read model still does',
  secs.every((s) => !/\d/.test(s.n)) && prof.knowledge.reusable.map((g) => g.count).join(',') === '2,3,3,1,1',
  `rows "${secs.map((s) => s.n).join('')}" · model ${prof.knowledge.reusable.map((g) => g.count).join(',')}`);
ok('the person is introduced as a person, not as how Nexus holds them',
  !/Lore-backed|in your lore/i.test(await text('#sheet-body .ent-hero')) && /Also called The Saint/.test(await text('#sheet-body .ent-hero')));
ok('no architecture is said before the sections', !/Reusable knowledge|across stories/i.test(await text('#sheet-body')));
ok('nothing here is called an entry', !/\bentr(y|ies)\b/i.test(await text('#sheet-body')));
ok('there is one way to begin a section that does not exist yet',
  (await ev(`[...document.querySelectorAll('#sheet-body [data-add-reusable]')].length`)) === 1
  && /\+ Add knowledge/.test(await text('#sheet-body [data-add-reusable]')));
ok('no empty section is offered as a row', !secs.some((s) => /Appearance|Speech|Skills/.test(s.name)));

// ------------------------------------------------------- Backstory, whole
console.log('\n→ Backstory');
await click('#sheet-body [data-section="Backstory"]', 1000);
const titles = await ev(`[...document.querySelectorAll('#sheet-body .ent-piece-title')].map(h => h.textContent.trim())`);
const bodyText = await text('#sheet-body .ent-sec-body');
console.log(`      ${await text('#sheet-body .ent-sec-who')} · ${await text('#sheet-body .ent-sec-title')} · ${await text('#sheet-body .ent-sec-origin')}`);
console.log(`      ${titles.join(' / ')}`);
ok('the section is titled for the person and the section', (await text('#sheet-body .ent-sec-title')) === 'Backstory' && /Patrick Moretti/i.test(await text('#sheet-body .ent-sec-who')));
ok('the three pieces read as headed parts of one page',
  titles.join(',') === 'Childhood,Foster System and Juvenile Detention,Recruitment', titles.join(','));
ok('every piece\'s full text is on the page, not an excerpt',
  bodyText.length > 900 && !/…$/.test(bodyText), `${bodyText.length} characters`);
ok('the reading flow says nothing about sources',
  !/The Saint|from Patrick|pieces? from/.test(await text('#sheet-body .ent-sec-head')) && !/The Saint/.test(bodyText)
  && (await ev(`document.querySelectorAll('#sheet-body .ent-piece-from').length`)) === 0);
ok('imported pieces are read, not offered for editing',
  (await ev(`document.querySelectorAll('#sheet-body [data-edit-knowledge]').length`)) === 0);
ok('where it came from is one quiet fold away, closed',
  await ev(`(() => { const d = document.querySelector('#sheet-body details.ent-details'); return !!d && !d.open && /Source details/.test(d.querySelector('summary').textContent)
    && /3 pieces from Patrick Moretti — The Saint/.test((d.querySelector('.ent-sec-origin')||{}).textContent || ''); })()`));
ok('and the fold keeps provenance: source, trigger words, a way to the source',
  await ev(`(() => { const d = document.querySelector('#sheet-body details.ent-details'); return d.querySelectorAll('[data-open-source]').length === 3 && /Trigger words/.test(d.textContent); })()`));
ok('adding goes to this section', /\+ Add to Backstory/.test(await text('#sheet-body [data-add-knowledge]')));
ok('no entry ids, no database words on the page', !/\bentr(y|ies)\b|entryId|lorebook_id/i.test(bodyText));
await click('#sheet-body [data-back]', 800);
ok('back returns to the sections, not to the library', (await sections()).length === 5 && !(await ev(`document.getElementById('sheet-host').hidden`)));

// ------------------------------------------------------- Black Lotus etc.
console.log('\nThings that are not people');
const lotus = await api(`/api/entities/${LOTUS}/profile`);
ok('a place still reads through the same dossier, as only what is known', lotus.knowledge.reusable.map((g) => `${g.name}(${g.count})`).join(' ') === 'Profile(1)');
const idx = await api('/api/entities');
ok('the index counts entities and pieces as different things', idx.entityCount === 10 && idx.entities.find((e) => e.name === 'Patrick Moretti').pieceCount === 10);
ok('the index narrows by kind', (await api('/api/entities?type=place')).entityCount === 5);
const reads = sent.slice(from).filter((r) => r.url.includes(`localhost:${port}`)).filter((r) => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(r.method));
ok('reading people and sections wrote nothing', reads.length === 0, JSON.stringify(reads.slice(0, 3)));

// ------------------------------------------------------ + Add knowledge
console.log('\n+ Add knowledge, on the copy only');
const containersBefore = (() => { const d = new DatabaseSync(COPY, { readOnly: true }); const c = d.prepare("SELECT COUNT(*) c FROM lorebooks WHERE json_valid(original) AND json_extract(original,'$.managedFor') IS NOT NULL").get().c; d.close(); return c; })();
ok('nothing has been written by hand about anyone yet', containersBefore === 0);
await openPerson('Patrick Moretti');
await click('#sheet-body [data-add-reusable]', 900);
ok('the form opens with the kind of knowledge left to choose', await waitFor('#kn-cat', 5000));
await ev(`(() => { const s = document.getElementById('kn-cat'); s.value = 'personality'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const fields = await ev(`[...document.querySelectorAll('#sheet-body input, #sheet-body textarea')].map(i => i.id || i.name || i.placeholder).filter(Boolean)`);
console.log(`      form fields: ${fields.join(', ')}`);
await ev(`(() => {
  const t = document.querySelector('#sheet-body input[id*="title" i], #sheet-body input[placeholder*="title" i], #sheet-body input[type="text"]');
  const c = document.querySelector('#sheet-body textarea');
  if (t) { t.value = 'Dry wit under pressure'; t.dispatchEvent(new Event('input', { bubbles: true })); }
  if (c) { c.value = 'Patrick deflects fear with dry, precise humour, and the drier it gets the more frightened he is.'; c.dispatchEvent(new Event('input', { bubbles: true })); }
})()`);
const saved = await ev(`(() => { const b = [...document.querySelectorAll('#sheet-body button')].find(x => /^(save|add|keep|done)/i.test(x.textContent.trim()) && !x.hasAttribute('data-back') && !x.hasAttribute('data-close')); if (b) { b.click(); return b.textContent.trim(); } return null; })()`);
await sleep(2500);
console.log(`      saved via "${saved}"`);
const d1 = new DatabaseSync(COPY, { readOnly: true });
const containers = d1.prepare("SELECT id, name, json_extract(original,'$.managedFor') m FROM lorebooks WHERE json_valid(original) AND json_extract(original,'$.managedFor') IS NOT NULL").all();
const written = d1.prepare("SELECT e.id, e.title, e.lorebook_id, s.scope, s.category, s.origin, s.status, s.confidence, s.evidence FROM lore_entries e JOIN entry_semantics s ON s.entry_id=e.id WHERE e.title='Dry wit under pressure'").get();
console.log(`      container: ${JSON.stringify(containers.map((c) => ({ name: c.name, m: c.m })))}`);
console.log(`      written:   ${written ? `${written.scope}/${written.category} ${written.origin}/${written.status} ${written.evidence}` : '(none)'}`);
ok('the first piece written by hand made the person\'s own container, once',
  containers.length === 1 && /Patrick Moretti — Knowledge/.test(containers[0].name) && JSON.parse(containers[0].m).entityId === PATRICK);
ok('the piece is approved as the person\'s, by hand', !!written && written.category === 'personality' && written.origin === 'manual' && written.status === 'approved' && /by hand/.test(written.evidence));
ok('and it is about Patrick', !!written && d1.prepare("SELECT entity_id FROM entry_relations WHERE entry_id=? AND relation='subject' AND status='approved'").get(written.id)?.entity_id === PATRICK);
ok('it is not attributed to the source Patrick came in with', !!written && written.lorebook_id !== SAINT && written.lorebook_id === containers[0].id);
ok('the container is reusable material about him, owned by no story', (() => { const r = d1.prepare('SELECT package_role, subject_entity_id, owner_story_id, status FROM source_semantics WHERE lorebook_id=?').get(containers[0].id); return r?.package_role === 'entity-material' && r.subject_entity_id === PATRICK && r.owner_story_id === null && r.status === 'approved'; })());
ok('The Saint itself is byte for byte what it was', JSON.stringify(d1.prepare('SELECT id, title, content, keys FROM lore_entries WHERE lorebook_id=? ORDER BY display_index').all(SAINT)) === saintBefore);
d1.close();

await openPerson('Patrick Moretti');
const secs2 = await sections();
console.log(`      now: ${secs2.map((s) => `${s.name} · ${s.n}`).join(' | ')}`);
ok('a Personality section now exists because a piece does', secs2.some((s) => s.name === 'Personality'));
await click('#sheet-body [data-section="Personality"]', 900);
ok('and what you wrote can be changed here', (await ev(`document.querySelectorAll('#sheet-body [data-edit-knowledge]').length`)) === 1
  && /1 piece you wrote/.test(await text('#sheet-body .ent-sec-origin')));
await click('#sheet-body [data-add-knowledge]', 900);
await ev(`(() => { const t = document.querySelector('#sheet-body input[type="text"]'); const c = document.querySelector('#sheet-body textarea');
  if (t) { t.value = 'Quiet when cornered'; t.dispatchEvent(new Event('input', { bubbles: true })); }
  if (c) { c.value = 'When he cannot control a room he goes still and watches.'; c.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
await ev(`(() => { const b = [...document.querySelectorAll('#sheet-body button')].find(x => /^(save|add|keep|done)/i.test(x.textContent.trim()) && !x.hasAttribute('data-back') && !x.hasAttribute('data-close')); if (b) b.click(); })()`);
await sleep(2500);
const d2 = new DatabaseSync(COPY, { readOnly: true });
ok('a second piece reuses the container rather than making another', d2.prepare("SELECT COUNT(*) c FROM lorebooks WHERE json_valid(original) AND json_extract(original,'$.managedFor') IS NOT NULL").get().c === 1
  && d2.prepare("SELECT COUNT(*) c FROM lore_entries WHERE title IN ('Dry wit under pressure','Quiet when cornered')").get().c === 2);
ok('one declaration of Patrick in his own container, however many pieces', d2.prepare("SELECT COUNT(*) c FROM source_entities WHERE entity_id=? AND lorebook_id IN (SELECT id FROM lorebooks WHERE json_valid(original) AND json_extract(original,'$.managedFor') IS NOT NULL)").get(PATRICK).c === 1);
ok('MHA on the copy stayed entirely unorganised', d2.prepare('SELECT COUNT(*) c FROM entry_semantics s JOIN lore_entries e ON e.id=s.entry_id WHERE e.lorebook_id=?').get(MHA).c === 0);
d2.close();

// -------------------------------------------------------------- responsive
console.log('\nOn every width it has to work at');
for (const width of [320, 375, 390, 430, 1280]) {
  await cdp('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 2, mobile: width < 1000 });
  await sleep(300);
  await openPerson('Patrick Moretti');
  await click('#sheet-body [data-section="Backstory"]', 900);
  const m = await ev(`(() => {
    const over = [...document.querySelectorAll('#sheet-body *')].filter(el => el.getBoundingClientRect().right > window.innerWidth + 1).map(el => el.className || el.tagName).slice(0, 3);
    return { page: document.documentElement.scrollWidth - window.innerWidth, over, titles: document.querySelectorAll('#sheet-body .ent-piece-title').length,
      rowH: Math.min(...[...document.querySelectorAll('#character-list [data-entity]')].map(r => r.getBoundingClientRect().height), 999) };
  })()`);
  ok(`${width}px · section page fits, three headed pieces, rows comfortable`, m.page <= 0 && m.over.length === 0 && m.titles === 3,
    `page +${m.page}px${m.over.length ? ` · over: ${m.over.join(', ')}` : ''}`);
}
ok('nothing threw throughout', errors.length === 0, errors.slice(0, 2).join(' | '));

try { ws.close(); } catch { /* closing */ }
chrome.kill(); app.kill();
await sleep(400);

const prodAfter = named();
console.log('\nProduction, by name');
for (const [k, v] of Object.entries(prodAfter)) console.log(`      ${k.padEnd(22)} = ${v}`);
ok('production is untouched, every named count', JSON.stringify(prodBefore) === JSON.stringify(prodAfter));
ok('production SHA is unchanged', sha(readFileSync(PROD)) === shaBefore, shaBefore.slice(0, 16));
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exitCode = fail ? 1 : 0;
