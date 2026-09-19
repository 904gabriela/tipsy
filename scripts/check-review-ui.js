// A review is a screen for deciding things, not a report on an analyser.
//
// What is checked here is the shape of the work rather than the wording: three
// groups, by what is left for a person to do; readings Nexus settled shown one
// line each and still open-able; a real question on each card that needs one,
// with the entry's own words above it; suggestions on weaker evidence grouped
// and skippable, with nothing anywhere that accepts a group of them at once;
// and leaving something alone costing exactly nothing.
//
//   node scripts/check-review-ui.js
//
// Needs Chrome, and says so plainly if it cannot find one. Throwaway database,
// invented names, no real library is read.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from '../src/db/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
};
const chromePath = () => [process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean).find((p) => existsSync(p)) || null;

const chrome = chromePath();
if (!chrome) {
  console.log('No Chrome found, so the screen cannot be driven. Set CHROME_PATH to one and run again.');
  process.exitCode = 1;
  process.exit();
}

// A source shaped like a real large one: profiles Nexus will settle by itself,
// world material it cannot pin on anybody, an entry naming somebody the source
// never introduces, an entry that says something about a person without
// introducing them, and a long tail of weaker suggestions.
const work = mkdtempSync(join(tmpdir(), 'nexus-review-ui-'));
const dbPath = join(work, 'x.db');
const db = open(dbPath);
const bookId = db.createLorebook('HARBOUR CANON LOREBOOK — Day 1 Progressive Continuity', '');
const add = (e) => db.saveEntry(bookId, {
  order: 100, enabled: true, constant: false, probability: 100,
  keys: e.keys, kind: e.kind, title: e.title, content: e.content,
});
const PEOPLE = ['Aurelio Fontana', 'Renata Salk', 'Carlo Vancetti', 'Marco Durante'];
for (const name of PEOPLE) {
  add({
    kind: 'character', title: name, keys: [name, name.split(' ')[1]],
    content: `${name} keeps the books for three families and the patience of none of them. `
      + `He is careful, quiet, and owed favours by everyone in the district. ${name} has worked the harbour since he was fourteen.`,
  });
}
// Plainly world material, and nobody's in particular.
for (const [t, c] of [
  ['03 WORLD — Tides, charts, and the harbour law', 'The harbour is governed by tide tables and an older set of customs. Cargo is weighed at the north gate and again at the counting house. Nothing moves after the evening bell without a written pass.'],
  ['03 WORLD — The counting house and its rooms', 'The counting house holds the ledgers, a strong room, and the long gallery where disputes are heard. The gallery is cold in winter and nobody stays in it longer than they must.'],
]) add({ kind: 'rule', title: t, keys: ['harbour', 'law', 'counting house'], content: c });
// Names somebody the source never introduces.
add({
  kind: 'character', title: 'Ferry nights', keys: ['Ilario Bencivenni', 'Ilario'],
  content: 'Ilario Bencivenni runs the night ferry and asks no questions. He is watchful, superstitious, '
    + 'and loyal to whoever paid him last. Nobody at the counting house will say who that is.',
});
// Says something about somebody without introducing them.
add({
  kind: 'note', title: 'Aurelio Fontana — progressive state map',
  keys: ['Aurelio development', 'Aurelio state'],
  content: 'DAY 1: Aurelio Fontana is careful and slow to commit. HARBOUR SEASON: he begins to take sides, '
    + 'and the cost of it shows in how little he sleeps. LATER: he is still careful, and it is no longer enough.',
});
// The long tail of weaker suggestions, mostly directives.
for (let i = 0; i < 26; i++) {
  add({
    kind: 'direction', title: `02 NARRATION — how scenes are told ${i}`,
    keys: [`narration ${i}`, 'pacing and voice across a long scene, kept steady'],
    content: 'Keep scenes in the present tense and close on one person at a time. Let silences run. '
      + 'Do not summarise what a scene can show, and never explain a character to the reader.',
  });
}
db.close();

const port = 9000 + Math.floor(Math.random() * 900);
const app = spawn(process.execPath, ['server.js'], {
  cwd: root, env: { ...process.env, PORT: String(port), DB_PATH: dbPath }, stdio: 'ignore',
});
const cport = 9000 + Math.floor(Math.random() * 900);
const browser = spawn(chrome, ['--headless=new', `--remote-debugging-port=${cport}`,
  `--user-data-dir=${join(work, 'chrome')}`, '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const stop = () => { try { browser.kill(); } catch { /* */ } try { app.kill(); } catch { /* */ } };
process.on('exit', stop);

let ws;
try {
  for (let i = 0; i < 200; i++) { try { await fetch(`http://localhost:${port}/`); break; } catch { await sleep(200); } }
  let target = null;
  for (let i = 0; i < 80; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${cport}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* */ }
    if (target) break;
    await sleep(250);
  }
  if (!target) throw new Error('Chrome started but never offered a page to drive.');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
} catch (err) {
  console.log(`  Could not start a browser to drive: ${err.message}`);
  stop(); rmSync(work, { recursive: true, force: true });
  process.exitCode = 1;
  process.exit();
}
let seq = 0;
const pending = new Map();
const thrown = [];
ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  if (d.method === 'Runtime.exceptionThrown') thrown.push(String(d.params.exceptionDetails?.exception?.description || '').slice(0, 200));
});
const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description).slice(0, 200));
  return r.result?.result?.value;
};
await cdp('Page.enable');
await cdp('Runtime.enable');
const waitFor = async (sel, ms = 60000) => {
  for (let t = 0; t < ms; t += 250) { if (await ev(`!!document.querySelector(${JSON.stringify(sel)})`)) return true; await sleep(250); }
  return false;
};
const click = async (sel) => {
  if (!await waitFor(sel, 25000)) return false;
  await ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
  await sleep(700);
  return true;
};
const text = (sel) => ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(e=>e.textContent.replace(/\\s+/g,' ').trim()).join(' | ')`);
const count = (sel) => ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`);

await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await cdp('Page.navigate', { url: `http://localhost:${port}/` });
await sleep(2200);

console.log('the source screen');
{
  await click('[data-tab="characters"]');
  await click('[data-shelf="sources"]');
  await click(`[data-lorebook="${bookId}"]`);
  await sleep(900);
  const above = await ev(`(() => {
    const btn = document.querySelector('[data-organize]');
    const list = document.getElementById('lore-groups');
    if (!btn || !list) return null;
    return btn.getBoundingClientRect().top < list.getBoundingClientRect().top;
  })()`);
  ok('understanding the source is offered above the entries', above === true);
  ok('and it says the source is not organised yet', /not been told what anything in this source means/.test(await text('.organise-strip')));
}

console.log('\nthe review');
await click(`[data-organize="${bookId}"]`);
ok('it opens', await waitFor('#sheet-body .edit-card', 90000));
await sleep(2000);
{
  const groups = await text('#sheet-body > .edit-card > .edit-head > b');
  ok('there are three groups of work', /Sorted/.test(groups) && /Needs you/.test(groups) && /Optional/.test(groups), groups);
  ok('and no diagnostic feed above them', !/Needs your attention/.test(groups));
  const tally = await text('.rv-pip');
  ok('the tally counts work, not confidence', !/high|medium|low|understood|likely/i.test(tally), tally);
}

console.log('\nsorted readings are compact and still open-able');
{
  await click('#sheet-body .edit-card[data-section="sorted"] .edit-head');
  const rows = await count('[data-section="sorted"] .edit-card.compact');
  const said = Number(await ev(`(document.querySelector('[data-section="sorted"] > .edit-head > .n')||{}).textContent`));
  ok('every settled reading is one row, and no full cards', rows > 0 && rows === said, `${rows} rows for ${said} readings`);
  ok('none of them is expanded by default', await ev(`[...document.querySelectorAll('[data-section="sorted"] .edit-card.compact .edit-body')].filter(b=>!b.hidden).length`) === 0);
  ok('each can still be untimed by its own tick', await count('[data-section="sorted"] [data-tick]') === rows);
  await ev(`document.querySelector('[data-section="sorted"] .edit-card.compact .edit-head').click()`);
  await sleep(500);
  ok('and opening one shows the whole reading', await ev(`!document.querySelector('[data-section="sorted"] .edit-card.compact .edit-body').hidden`));
  ok('including the advanced detail, one level down', /Why Nexus/.test(await text('[data-section="sorted"] .edit-card.compact summary')));
}

console.log('\nwhat needs a person');
{
  ok('the questions are grouped by what is being asked', (await count('.rv-ask[data-ask]')) >= 1, await text('.rv-ask[data-ask] .rv-ask-head b'));
  const card = `[...document.querySelectorAll('.rv-ask[data-ask] .edit-card')]`;
  await ev(`${card}[0].querySelector('.edit-head').click()`);
  await sleep(600);
  const body = await ev(`${card}[0].textContent.replace(/\\s+/g,' ')`);
  ok("the entry's own words are on the card", (await count('.rv-ask[data-ask] .rv-excerpt')) >= 1);
  ok('and the whole entry is one tap away', /Open the entry/.test(body));
  ok('the choice offered is general material first', /General world material/.test(body));
  ok('leaving it alone is offered', /Leave for later/.test(body));
  ok('and nothing on the card states a confidence', !/\b(high|medium|low) confidence\b/i.test(body));
}

console.log('\nleaving something for later costs nothing');
{
  const before = await ev(`(document.getElementById('rv-save')||{}).textContent`);
  const ticksBefore = await ev(`document.querySelectorAll('[data-tick][aria-pressed="true"]').length`);
  ok('a card offers it', await ev(`!!document.querySelector('.rv-ask[data-ask] [data-later]')`));
  await ev(`(document.querySelector('.rv-ask[data-ask] [data-later]') || {click(){}}).click()`);
  await sleep(700);
  ok('the save count does not move', await ev(`(document.getElementById('rv-save')||{}).textContent`) === before, before);
  ok('and nothing became ticked', await ev(`document.querySelectorAll('[data-tick][aria-pressed="true"]').length`) === ticksBefore);
}

console.log('\nchoosing general world material');
{
  const before = await ev(`(document.getElementById('rv-save')||{}).textContent`);
  const picked = await ev(`(() => {
    const c = [...document.querySelectorAll('.rv-ask[data-ask] .edit-card')].find(x => x.querySelector('.rv-choice'));
    if (!c) return null;
    if (c.querySelector('.edit-body').hidden) c.querySelector('.edit-head').click();
    const chip = [...c.querySelectorAll('.rv-choice')].find(b => /General world material/.test(b.textContent));
    if (!chip) return null;
    chip.click();
    return c.getAttribute('data-entry-ref');
  })()`);
  await sleep(800);
  ok('it is a decision that counts towards Save', await ev(`(document.getElementById('rv-save')||{}).textContent`) !== before,
    `${before} -> ${await ev(`(document.getElementById('rv-save')||{}).textContent`)}`);
  const said = await ev(`(() => {
    const c = document.querySelector('[data-entry-ref="${picked}"]');
    return c ? c.textContent.replace(/\\s+/g,' ') : '';
  })()`);
  ok('and the reading it produced is shown back', /World information/.test(said), (said.match(/✓[^.]*\./) || [''])[0].slice(0, 90));
  ok('including the category it was recorded under', /World information · \w/.test(said));
}

console.log('\nweaker suggestions are offered, never applied in bulk');
{
  await click('#sheet-body .edit-card[data-section="optional"] .edit-head');
  ok('they are grouped rather than listed', (await count('[data-section="optional"] .rv-ask[data-optional]')) >= 1,
    await text('[data-section="optional"] .rv-ask[data-optional] .rv-ask-head b'));
  ok('no control accepts a whole group', await count('[data-accept-section]') === 0);
  const labels = await text('[data-section="optional"] button');
  ok('and no button offers to accept them all', !/accept all|use the \d+|all \d+/i.test(labels));
}

console.log('\nsaving says what it will do');
{
  await click('#rv-save');
  await sleep(900);
  const body = await text('#sheet-body');
  ok('it counts the readings', /Saved in total/.test(body));
  ok('it does not promise character cards', /No character cards are made/.test(body));
  ok('it does not say things are added to the library', !/added to your library/i.test(body));
  ok('and it says the rest is not lost', /left for later/.test(body) && /lost or changed/i.test(body));
}

ok('the screen threw no errors while being driven', thrown.length === 0, thrown.join(' / ').slice(0, 200));

try { ws.close(); } catch { /* */ }
stop();
await sleep(300);
rmSync(work, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exitCode = fail ? 1 : 0;
