// A 158-piece source, read on a phone.
//
// D1 built the projection; this is the screen over it. What is checked here is
// that the screen never says more than the projection knows:
//
//   * a source opens on its groups, not on every piece it holds;
//   * the filing its author wrote is shown as filing, never as meaning;
//   * a source with nothing approved says so, instead of showing empty
//     People and Places as though the answer were none;
//   * entity counts and piece counts are both named, and never each other;
//   * a file with no structure of its own is not given one;
//   * and none of it writes: every interaction is a GET.
//
//   node scripts/check-source-view.js
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

if (!existsSync(PROD)) { note('no data/tipsy.db here — source view checks skipped'); process.exit(0); }
if (!existsSync(CHROME)) { note('no Chrome here — source view checks skipped'); process.exit(0); }

const dir = mkdtempSync(join(tmpdir(), 'nexus-srcview-'));
const COPY = join(dir, 'copy.db').replace(/\\/g, '/');
const readProd = () => {
  const d = new DatabaseSync(PROD, { readOnly: true });
  const n = {
    entities: d.prepare('SELECT COUNT(*) c FROM lore_entities').get().c,
    semantics: d.prepare('SELECT COUNT(*) c FROM entry_semantics').get().c,
    relations: d.prepare('SELECT COUNT(*) c FROM entry_relations').get().c,
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
};
d0.close();
const find = (re) => books.find((b) => re.test(b.name));
const MHA = find(/MHA MASTER/i);
const SAINT = find(/Saint/i);
const ULTRA = find(/UltraExplicit/i);

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
const waitFor = async (sel, ms = 30000) => {
  for (let t = 0; t < ms; t += 200) { if (await ev(`!!document.querySelector(${JSON.stringify(sel)})`)) return true; await sleep(200); }
  return false;
};
const click = async (sel, wait = 700) => {
  if (!await waitFor(sel, 20000)) return false;
  await ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
  await sleep(wait);
  return true;
};
const text = (sel) => ev(`(document.querySelector(${JSON.stringify(sel)})||{}).textContent || ''`);
const rows = () => ev(`[...document.querySelectorAll('#src-body .src-row')].map(r => ({
  name: (r.querySelector('.src-row-name')||{}).textContent || '',
  n: (r.querySelector('.src-row-n')||{}).textContent || '',
  sub: (r.querySelector('.src-row-sub')||{}).textContent || '',
  group: r.getAttribute('data-src-group'), piece: r.getAttribute('data-src-piece'),
}))`);
const sections = () => ev(`[...document.querySelectorAll('#src-body .src-sect')].map(s => ({
  heading: (s.querySelector('h3')||{}).textContent || '',
  units: (s.querySelector('.src-units')||{}).textContent || '',
  rows: s.querySelectorAll('.src-row').length,
}))`);

const openBook = async (id) => {
  await cdp('Page.navigate', { url: `http://localhost:${port}/?t=${Date.now()}` });
  await sleep(2200);
  await click('[data-tab="characters"]');
  await click('[data-shelf="sources"]');
  await click(`[data-lorebook="${id}"]`, 1200);
  return click(`[data-view-source="${id}"]`, 1600);
};

await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });

// ------------------------------------------------------------------- MHA
console.log('\nMHA MASTER CANON — 158 pieces, nothing approved, iPhone width');
const writesFrom = sent.length;
if (!MHA) note('no MHA MASTER CANON in this library — skipped');
else {
  ok('a source opens from its own screen', await openBook(MHA.id));
  const first = await rows();
  const secs = await sections();
  console.log(`      ${await text('#src-name')} · ${await text('#src-sub')}`);
  for (const r of first) console.log(`        ${String(r.n).padStart(4)}  ${r.name}`);

  ok('the first screen shows groups, not every piece',
    first.length === 14 && first.length < 158, `${first.length} rows`);
  ok('the group counts add up to the whole source',
    first.reduce((n, r) => n + Number(r.n.replace(/,/g, '')), 0) === 158,
    `${first.reduce((n, r) => n + Number(r.n.replace(/,/g, '')), 0)}`);
  ok('07 U.A. STAFF is there, with 13',
    first.some((r) => r.name === '07 U.A. STAFF' && r.n === '13'));
  ok('no empty Unfiled group is shown', !first.some((r) => /Unfiled/i.test(r.name)));
  ok('filing is named as filing, not as meaning',
    /how the file was organised, not what Nexus knows/i.test(await text('#src-lede') || await text('#src-body')));
  ok('an unorganised source opens on its filing, not on nothing',
    (await ev(`document.querySelector('[data-src-view="filing"]').classList.contains('primary')`)) === true);

  // What Nexus knows, for a source where nobody has said anything.
  await click('[data-src-view="nexus"]');
  const nsecs = await sections();
  ok('a source with nothing approved says so',
    /Not organised yet/i.test(await text('#src-body')), (await text('.src-lede')).slice(0, 60));
  ok('no empty People or Places are shown as if the answer were none',
    nsecs.length === 0, `${nsecs.length} sections`);
  ok('no proposed reading is shown as approved',
    !/People|Places|Factions/.test(await text('#src-body')));

  // Into a group.
  await click('[data-src-view="filing"]');
  await click('[data-src-group="f:04 CLASS 1-A"]', 900);
  const pieces = await rows();
  console.log(`      › ${await text('#src-name')} · ${await text('#src-sub')}`);
  for (const r of pieces.slice(0, 4)) console.log(`          ${r.name}`);
  ok('opening CLASS 1-A shows its 20 pieces', pieces.length === 20, `${pieces.length}`);
  ok('a piece inside a group drops the prefix it shares with the group',
    pieces.some((r) => r.name === 'Yuga Aoyama'), pieces[0]?.name);

  // Into a piece.
  await click('[data-src-piece]', 1200);
  const body = await text('#src-body');
  console.log(`      › ${await text('#src-name')}`);
  ok('a piece shows the words that are stored', body.length > 200, `${body.length} characters on screen`);
  ok('a piece names the filing it came from', /Source filing/.test(body) && /04 CLASS 1-A/.test(body));
  ok('a piece with nothing approved says it is not organised',
    /Nexus organisation/.test(body) && /Not organised yet/.test(body));
  ok('no entity is claimed for an unorganised piece', !/who is a person/.test(body));

  // Back, twice, and still where we were.
  await click('#src-back', 800);
  ok('back from a piece returns to its group', (await text('#src-sub')) === '20 pieces');
  await click('#src-back', 800);
  ok('back from a group returns to the source', (await text('#src-sub')) === '158 pieces');
}

// ----------------------------------------------------------------- The Saint
console.log('\nThe Saint — 23 pieces, 21 approved');
if (!SAINT) note('no Saint source in this library — skipped');
else {
  await openBook(SAINT.id);
  ok('an organised source opens on what Nexus knows',
    (await ev(`document.querySelector('[data-src-view="nexus"]').classList.contains('primary')`)) === true);
  const secs = await sections();
  for (const s of secs) console.log(`      ${s.heading} · ${s.units} · ${s.rows} rows`);
  const by = (h) => secs.find((s) => s.heading === h);
  ok('people are counted as people and as pieces, separately',
    by('People')?.units === '4 people · 13 pieces', by('People')?.units);
  ok('places are counted as places and as pieces, separately',
    by('Places')?.units === '5 places · 5 pieces', by('Places')?.units);
  ok('one faction reads as one faction and one piece',
    by('Factions')?.units === '1 faction · 1 piece', by('Factions')?.units);
  ok('world material is counted in pieces only, having no entities',
    by('World')?.units === '2 pieces', by('World')?.units);
  ok('the two unsettled pieces are named, not just counted',
    by('Needs attention')?.rows === 2 && by('Needs attention')?.units === '2 pieces');
  ok('the source header counts all 23 pieces, not the 21 that are read',
    (await text('#src-sub')) === '23 pieces', await text('#src-sub'));
  ok('the source says how many of its pieces have been read',
    /21 pieces of 23 have been read/i.test(await text('.src-lede')), (await text('.src-lede')).slice(-44));

  const people = await ev(`[...document.querySelectorAll('#src-body .src-sect')]
    .find(s => (s.querySelector('h3')||{}).textContent === 'People')
    .querySelectorAll('.src-row').length`);
  ok('four people are listed under People', people === 4, `${people}`);
  await click(`[data-src-group="e:${await ev(`document.querySelector('#src-body .src-sect .src-row').getAttribute('data-src-group').slice(2)`)}"]`, 900)
    || await click('#src-body .src-row', 900);
  ok('opening the person with ten pieces shows ten', (await rows()).length === 10, await text('#src-sub'));

  // The file's own structure is still available, and still called that.
  await click('#src-back', 700);
  await click('[data-src-view="filing"]', 700);
  ok('an organised source can still be read as the file it came from',
    /no structure of its own|filed by whoever wrote this file/i.test(await text('.src-lede')));
}

// ------------------------------------------------------------- UltraExplicit
console.log('\nUltraExplicit — 125 pieces, no filing of its own');
if (!ULTRA) note('no UltraExplicit source in this library — skipped');
else {
  await openBook(ULTRA.id);
  const lede = await text('.src-lede');
  const first = await rows();
  console.log(`      ${await text('#src-sub')} · ${lede.slice(0, 70)}`);
  ok('a file with no structure is not given one',
    /no structure of its own/i.test(lede), lede.slice(0, 60));
  ok('its pieces are still reachable, behind one row',
    first.length === 1 && first[0].n === '125' && first[0].name === 'All of it', JSON.stringify(first[0] || {}));
  await click('[data-src-group="f:Unfiled"]', 1200);
  const shown = await ev(`document.querySelectorAll('#src-body .src-row').length`);
  ok('125 pieces are not all poured onto one screen at once',
    shown === 50 && (await ev(`!!document.querySelector('[data-src-all]')`)), `${shown} shown`);
  await click('[data-src-all]', 900);
  ok('and the rest come when asked for',
    (await ev(`document.querySelectorAll('#src-body .src-row').length`)) === 125);
}

// -------------------------------------------------------------- GET only
console.log('\nNothing here writes');
const mine = sent.slice(writesFrom).filter((r) => r.url.includes(`localhost:${port}`));
const writes = mine.filter((r) => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(r.method));
ok('every request the source screen made was a GET',
  writes.length === 0, writes.length ? JSON.stringify(writes.slice(0, 4)) : `${mine.length} requests, all GET`);
const d1 = new DatabaseSync(COPY, { readOnly: true });
const copyAfter = {
  entries: d1.prepare('SELECT COUNT(*) c FROM lore_entries').get().c,
  semantics: d1.prepare('SELECT COUNT(*) c FROM entry_semantics').get().c,
  entities: d1.prepare('SELECT COUNT(*) c FROM lore_entities').get().c,
};
const mhaSem = MHA ? d1.prepare('SELECT COUNT(*) c FROM entry_semantics s JOIN lore_entries e ON e.id=s.entry_id WHERE e.lorebook_id=?').get(MHA.id).c : 0;
d1.close();
ok('the database behind the screen is unchanged',
  JSON.stringify(copyBefore) === JSON.stringify(copyAfter), JSON.stringify(copyAfter));
ok('MHA is still unorganised after being read', mhaSem === 0, `${mhaSem} semantic rows`);

// ------------------------------------------------------------- responsive
console.log('\nOn every width it has to work at');
for (const width of [320, 375, 390, 430, 1280]) {
  await cdp('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 2, mobile: width < 1000 });
  await sleep(300);
  if (MHA) { await openBook(MHA.id); } else { await openBook(books[0].id); }
  const m = await ev(`(() => {
    const de = document.documentElement;
    const over = [...document.querySelectorAll('#src-body *')]
      .filter(el => el.getBoundingClientRect().right > window.innerWidth + 1)
      .map(el => el.className || el.tagName).slice(0, 3);
    const rows = [...document.querySelectorAll('#src-body .src-row')];
    return {
      page: de.scrollWidth - window.innerWidth,
      over,
      minTap: Math.min(...rows.map(r => r.getBoundingClientRect().height)),
      nums: rows.every(r => !r.querySelector('.src-row-n') || r.querySelector('.src-row-n').getBoundingClientRect().right <= window.innerWidth),
    };
  })()`);
  ok(`${width}px · no sideways scroll, nothing over the edge, comfortable rows`,
    m.page <= 0 && m.over.length === 0 && m.minTap >= 44 && m.nums,
    `page +${m.page}px · tallest-min ${Math.round(m.minTap)}px${m.over.length ? ` · over: ${m.over.join(', ')}` : ''}`);
}

ok('the screen threw no errors while being used', errors.length === 0, errors.slice(0, 2).join(' | '));

// --------------------------------------------------------------- production
const prodAfter = readProd();
ok('the real library is untouched by all of this',
  JSON.stringify(prodBefore) === JSON.stringify(prodAfter), JSON.stringify(prodAfter));

try { ws.close(); } catch { /* closing */ }
chrome.kill(); app.kill();
await sleep(400);
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exitCode = fail ? 1 : 0;
