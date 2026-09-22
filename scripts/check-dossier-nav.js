// Once Nexus knows somebody, they are one thing to open.
//
// The pieces do not go away — they are what gets retrieved, and the source
// screen still counts them. They stop being how a person is navigated. Tapping
// Patrick opens Patrick, with sections, and the three things written about his
// past read as Childhood, Foster System and Juvenile Detention, Recruitment,
// not as three rows in a table.
//
// What is checked here is that this is navigation and nothing more: the same
// dossier that already existed, reached a new way, over material nobody has
// re-read or re-approved. A source with nothing approved still opens no
// dossiers at all, and the whole path stays a GET.
//
//   node scripts/check-dossier-nav.js
//
// A VACUUM copy on a random port, driven by headless Chrome. Production is
// opened once to make the copy and never served or written.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const WT = process.cwd();
const PROD = join(WT, 'data', 'tipsy.db');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
};
const note = (s) => console.log(`  NOTE  ${s}`);

if (!existsSync(PROD)) { note('no data/tipsy.db here — dossier navigation checks skipped'); process.exit(0); }
if (!existsSync(CHROME)) { note('no Chrome here — dossier navigation checks skipped'); process.exit(0); }

const dir = mkdtempSync(join(tmpdir(), 'nexus-dossier-'));
const COPY = join(dir, 'copy.db').replace(/\\/g, '/');
const readProd = () => {
  const d = new DatabaseSync(PROD, { readOnly: true });
  const n = {
    entities: d.prepare('SELECT COUNT(*) c FROM lore_entities').get().c,
    semantics: d.prepare('SELECT COUNT(*) c FROM entry_semantics').get().c,
    relations: d.prepare('SELECT COUNT(*) c FROM entry_relations').get().c,
    entries: d.prepare('SELECT COUNT(*) c FROM lore_entries').get().c,
  };
  d.close();
  return n;
};
const prodBefore = readProd();
{
  const src = new DatabaseSync(PROD, { readOnly: true }); src.exec(`VACUUM INTO '${COPY}'`); src.close();
  const c = new DatabaseSync(COPY); c.prepare("DELETE FROM settings WHERE key='auth'").run(); c.close();
}
const d0 = new DatabaseSync(COPY, { readOnly: true });
const books = d0.prepare('SELECT id, name FROM lorebooks').all();
const copyBefore = {
  entries: d0.prepare('SELECT COUNT(*) c FROM lore_entries').get().c,
  semantics: d0.prepare('SELECT COUNT(*) c FROM entry_semantics').get().c,
  entities: d0.prepare('SELECT COUNT(*) c FROM lore_entities').get().c,
  relations: d0.prepare('SELECT COUNT(*) c FROM entry_relations').get().c,
};
d0.close();
const find = (re) => books.find((b) => re.test(b.name));
const MHA = find(/MHA MASTER/i);
const SAINT = find(/Saint/i);

const port = 9900 + Math.floor(Math.random() * 90);
const app = spawn(process.execPath, ['server.js'], { cwd: WT, env: { ...process.env, PORT: String(port), DB_PATH: COPY }, stdio: 'ignore' });
for (let i = 0; i < 200; i++) { try { await fetch(`http://localhost:${port}/`); break; } catch { await sleep(200); } }
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
const waitFor = async (sel, ms = 25000) => {
  for (let t = 0; t < ms; t += 200) { if (await ev(`!!document.querySelector(${JSON.stringify(sel)})`)) return true; await sleep(200); }
  return false;
};
const click = async (sel, wait = 800) => {
  if (!await waitFor(sel, 20000)) return false;
  await ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
  await sleep(wait);
  return true;
};
const text = (sel) => ev(`(document.querySelector(${JSON.stringify(sel)})||{}).textContent || ''`);
/** The dossier's own first-level sections, as a reader sees them. */
// A section is a row to open, not a box to expand. Nothing on the overview
// holds a body, so nothing on it can be found open.
const bands = () => ev(`[...document.querySelectorAll('#sheet-body .ent-group')].map(g => ({
  name: (g.querySelector('.edit-head b')||{}).textContent || '',
  n: ((g.querySelector('.edit-head .n')||{}).textContent || '').replace(/ pieces?$/, ''),
  open: !!(g.querySelector('.edit-body') && !g.querySelector('.edit-body').hidden),
}))`);
/** The pieces of one section, read on its page. */
const openSection = async (name) => {
  await click(`#sheet-body [data-section="${name}"]`, 900);
  return ev(`[...document.querySelectorAll('#sheet-body .ent-piece')].map(c => ({
    title: (c.querySelector('.ent-piece-title')||{}).textContent || '',
    prose: (c.querySelector('.ent-piece-text')||{}).textContent || '',
    edit: !!c.querySelector('[data-edit-knowledge]'),
    from: (c.querySelector('.ent-piece-from')||{}).textContent || '',
  }))`);
};
const openBook = async (id) => {
  await cdp('Page.navigate', { url: `http://localhost:${port}/?t=${Date.now()}` });
  await sleep(2200);
  await click('[data-tab="characters"]');
  await click('[data-shelf="sources"]');
  await click(`[data-lorebook="${id}"]`, 1200);
  return click(`[data-view-source="${id}"]`, 1600);
};
const entityRow = (name) => `[...document.querySelectorAll('#src-body .src-row[data-src-entity]')]
  .find(r => (((r.querySelector('.src-row-name')||{}).textContent)||'').trim() === ${JSON.stringify(name)})`;
const openEntity = async (name) => {
  const hit = await ev(`(() => { const r = ${entityRow(name)}; if (!r) return false; r.click(); return true; })()`);
  if (!hit) return false;
  // The dossier is fetched, so wait for it to be there rather than for a while.
  for (let t = 0; t < 20000; t += 200) {
    if (await ev(`document.getElementById('sheet-title').textContent === ${JSON.stringify(name)}
      && !document.getElementById('sheet-host').hidden
      && !!document.querySelector('#sheet-body .ent-hero')`)) return true;
    await sleep(200);
  }
  return false;
};

await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
const from = sent.length;

// ------------------------------------------------------------------ Patrick
console.log('\nThe Saint → What Nexus knows → Patrick Moretti');
if (!SAINT) note('no Saint source in this library — skipped');
else {
  await openBook(SAINT.id);
  const rows = await ev(`[...document.querySelectorAll('#src-body .src-row')].map(r => ({
    name: ((r.querySelector('.src-row-name')||{}).textContent||'').trim(),
    sub: ((r.querySelector('.src-row-sub')||{}).textContent||'').trim(),
    n: ((r.querySelector('.src-row-n')||{}).textContent||'').trim(),
    entity: r.getAttribute('data-src-entity'),
  }))`);
  const patrickRow = rows.find((r) => r.name === 'Patrick Moretti');
  ok('a person in the organised view is something to open, not a count',
    !!patrickRow?.entity && patrickRow.n === '', JSON.stringify(patrickRow));
  ok('the row still says what kind of thing they are', patrickRow?.sub === 'Person');
  ok('how much is written is still said, once, on the heading above',
    /4 people · 13 pieces/.test(await text('#src-body')));

  const sourceScrollBefore = await ev(`document.getElementById('src-scroll').scrollTop`);
  ok('tapping the person opens their dossier', await openEntity('Patrick Moretti'));
  ok('the dossier is titled with their name',
    (await text('#sheet-title')) === 'Patrick Moretti', await text('#sheet-title'));

  const secs = await bands();
  console.log(`      ${await text('#sheet-title')}`);
  for (const b of secs) console.log(`        ${b.name} · ${b.n} · ${b.open ? 'open' : 'closed'}`);
  ok('the dossier shows the five real sections',
    secs.map((b) => b.name).join(',') === 'Identity,Backstory,Psychology,Relationships,Goals',
    secs.map((b) => b.name).join(','));
  ok('the sections carry their real sizes',
    secs.map((b) => b.n).join(',') === '2,3,3,1,1', secs.map((b) => b.n).join(','));
  ok('no section is open by default, so a phone gets a list and not a wall',
    secs.every((b) => !b.open));
  ok('the dossier never calls anything an entry',
    !/\bentr(y|ies)\b/i.test(await text('#sheet-body')));

  // ------------------------------------------------------------- Backstory
  const inside = await openSection('Backstory');
  console.log(`        Backstory → ${inside.map((x) => x.title).join(' · ')}`);
  ok('Backstory holds its three real titles',
    inside.map((x) => x.title).join(',') === 'Childhood,Foster System and Juvenile Detention,Recruitment',
    inside.map((x) => x.title).join(','));
  ok('what is inside a section is named, not numbered',
    inside.every((x) => x.title && !/^\d+$/.test(x.title)));

  // ------------------------------------------------- provenance, read-only
  // The first piece as the section page shows it, and the way to its source
  // from the fold beneath the page.
  const piece = {
    ...inside[0],
    openSource: await ev(`((document.querySelector('#sheet-body details.ent-details [data-open-source]')||{}).textContent || '')`),
  };
  ok('imported material is not offered for editing here', piece.edit === false);
  ok('it says where it came from instead',
    /Open in Patrick Moretti — The Saint/.test(piece.openSource), piece.openSource.trim());
  ok('the words themselves are there to read', piece.prose.length > 100, `${piece.prose.length} characters`);

  // ------------------------------------------------------------ going back
  // From a section, Back is the dossier; from the dossier, Back is the source.
  await click('#sheet-body [data-back]', 900);
  ok('back from a section returns to the sections', (await bands()).length === 5 && !(await ev(`document.getElementById('sheet-host').hidden`)));
  await click('#sheet-body [data-back]', 900);
  const backTo = await ev(`document.getElementById('sheet-host').hidden`);
  ok('closing the dossier returns to the source view', backTo === true);
  ok('and to the same place in it',
    (await ev(`document.getElementById('src-scroll').scrollTop`)) === sourceScrollBefore
      && (await ev(`!document.querySelector('[data-screen="source"]').hidden`)) === true);

  // ----------------------------------------------- a place, and a faction
  console.log('\nThe same way in, for things that are not people');
  ok('a place opens the same dossier', await openEntity('Black Lotus'));
  const lotus = await bands();
  console.log(`      Black Lotus → ${lotus.map((b) => `${b.name}(${b.n})`).join(' ') || '(none)'}`);
  ok('a place shows only what is actually known about it',
    lotus.length === 1 && lotus[0].name === 'Profile' && lotus[0].n === '1',
    JSON.stringify(lotus));
  ok('no empty Geography or History is invented',
    !/Geography|History|Members/.test(await text('#sheet-body')));
  await click('#sheet-body [data-back]', 900);

  ok('a faction opens the same dossier', await openEntity('Vancetti Family'));
  const fam = await bands();
  console.log(`      Vancetti Family → ${fam.map((b) => `${b.name}(${b.n})`).join(' ') || '(none)'}`);
  ok('a faction is read the same generic way',
    fam.length === 1 && fam[0].name === 'Profile', JSON.stringify(fam));
  ok('it is named as the kind of thing it is',
    /Group in your lore|Character|Lore-backed/.test(await text('#sheet-body .ent-kind')),
    await text('#sheet-body .ent-kind'));
  await click('#sheet-body [data-back]', 900);
}

// ------------------------------------------------------------ MHA, still not
console.log('\nMHA — nothing approved, so nothing to open');
if (!MHA) note('no MHA MASTER CANON in this library — skipped');
else {
  await openBook(MHA.id);
  await click('[data-src-view="nexus"]');
  ok('an unorganised source still says it is not organised',
    /Not organised yet/i.test(await text('#src-body')));
  ok('no dossier is reachable from it',
    (await ev(`document.querySelectorAll('#src-body [data-src-entity]').length`)) === 0);
  await click('[data-src-view="filing"]');
  const filing = await ev(`[...document.querySelectorAll('#src-body .src-row')].map(r => ({
    entity: r.getAttribute('data-src-entity'), group: r.getAttribute('data-src-group'),
    ord: (r.querySelector('.src-ord')||{}).textContent || '',
    name: ((r.querySelector('.src-row-name')||{}).textContent||'').trim(),
  }))`);
  ok('source filing never becomes a way into an entity',
    filing.every((r) => !r.entity && r.group), `${filing.length} groups, none an entity`);
  ok('filing still counts its pieces, which is what that screen is for',
    /158 pieces of 158/.test(await text('#src-body')));
  ok('CLASS 1-A did not become a dossier',
    !!filing.find((r) => r.name === '04 CLASS 1-A')?.group);

  // The one presentational polish: the ordinal steps back, and stays.
  const cls = filing.find((r) => /CLASS 1-A/.test(r.name));
  ok('a file\'s own numbering is shown apart from the name it gave the section',
    cls?.ord === '04' && cls?.name === '04 CLASS 1-A', JSON.stringify(cls));
  ok('and the order the file chose is untouched',
    filing.map((r) => r.ord).join(',') === '00,01,02,03,04,05,06,07,08,09,10,11,12,13',
    filing.map((r) => r.ord).join(','));
}

// ---------------------------------------------------------------- GET only
console.log('\nNothing here writes');
const mine = sent.slice(from).filter((r) => r.url.includes(`localhost:${port}`));
const writes = mine.filter((r) => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(r.method));
ok('every request on the way to a dossier was a GET',
  writes.length === 0, writes.length ? JSON.stringify(writes.slice(0, 4)) : `${mine.length} requests, all GET`);
const d1 = new DatabaseSync(COPY, { readOnly: true });
const copyAfter = {
  entries: d1.prepare('SELECT COUNT(*) c FROM lore_entries').get().c,
  semantics: d1.prepare('SELECT COUNT(*) c FROM entry_semantics').get().c,
  entities: d1.prepare('SELECT COUNT(*) c FROM lore_entities').get().c,
  relations: d1.prepare('SELECT COUNT(*) c FROM entry_relations').get().c,
};
const mhaSem = MHA ? d1.prepare('SELECT COUNT(*) c FROM entry_semantics s JOIN lore_entries e ON e.id=s.entry_id WHERE e.lorebook_id=?').get(MHA.id).c : 0;
d1.close();
ok('no lore entry was created or changed by reading',
  JSON.stringify(copyBefore) === JSON.stringify(copyAfter), JSON.stringify(copyAfter));
ok('MHA is still unorganised after all of it', mhaSem === 0, `${mhaSem} semantic rows`);

// -------------------------------------------------------------- responsive
console.log('\nOn every width it has to work at');
for (const width of [320, 375, 390, 430, 1280]) {
  await cdp('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 2, mobile: width < 1000 });
  await sleep(300);
  if (!SAINT) break;
  await openBook(SAINT.id);
  const opened = await openEntity('Patrick Moretti');
  if (!opened) {
    ok(`${width}px · the dossier opens at all`, false,
      `rows on screen: ${await ev(`document.querySelectorAll('#src-body .src-row').length`)}`
      + ` · view: ${await ev(`(document.querySelector('[data-src-view].primary')||{}).textContent || '?'`)}`);
    continue;
  }
  const m = await ev(`(() => {
    const over = [...document.querySelectorAll('#sheet-body *')]
      .filter(el => el.getBoundingClientRect().right > window.innerWidth + 1)
      .map(el => el.className || el.tagName).slice(0, 3);
    // Only a section's own header. The item headers inside a collapsed section
    // are in a hidden box and measure zero, which is not a tap target at all.
    const heads = [...document.querySelectorAll('#sheet-body .ent-group > .edit-head')];
    return {
      page: document.documentElement.scrollWidth - window.innerWidth,
      over,
      name: (document.getElementById('sheet-title')||{}).getBoundingClientRect
        ? document.getElementById('sheet-title').getBoundingClientRect().width : 0,
      minTap: heads.length ? Math.min(...heads.map(h => h.getBoundingClientRect().height)) : 0,
      // Rows, not boxes: nothing on the overview has a body to be found open.
      closed: heads.length > 0 && !document.querySelector('#sheet-body .ent-group .edit-body'),
      groups: document.querySelectorAll('#sheet-body .ent-group').length,
      cards: document.querySelectorAll('#sheet-body .edit-card').length,
      empty: !!document.querySelector('#sheet-body .empty'),
      title: (document.getElementById('sheet-title')||{}).textContent,
    };
  })()`);
  ok(`${width}px · nothing over the edge, sections compact, name readable`,
    m.page <= 0 && m.over.length === 0 && m.minTap >= 40 && m.closed && m.name > 40,
    `page +${m.page}px · heads ${Math.round(m.minTap)}px · groups ${m.groups} · cards ${m.cards}`
    + `${m.empty ? ' · EMPTY' : ''} · "${m.title}"${m.over.length ? ` · over: ${m.over.join(', ')}` : ''}`);
  await click('#sheet-body [data-back]', 600);
}

ok('nothing threw while being used', errors.length === 0, errors.slice(0, 2).join(' | '));

const prodAfter = readProd();
ok('the real library is untouched by all of this',
  JSON.stringify(prodBefore) === JSON.stringify(prodAfter), JSON.stringify(prodAfter));

try { ws.close(); } catch { /* closing */ }
chrome.kill(); app.kill();
await sleep(400);
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exitCode = fail ? 1 : 0;
