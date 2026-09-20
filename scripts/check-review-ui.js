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
// A name standing where a subject goes that this source never establishes.
// Nothing here is engineered towards one reading or another: the analyser
// decides what it decides, and the point of the entry is that what it MEANS
// cannot be told from the flag alone.
add({
  kind: 'note', title: 'Ottavia Ferri', keys: ['north gate'],
  content: 'Aurelio Fontana wants the north gate contract and Renata Salk means to stop him. '
    + 'The counting house has not ruled, and the tide tables say it must by the evening bell.',
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
// A second, smaller source, because the state the next section is about — a
// name standing where a subject goes that the source never establishes — is
// one the analyser only reaches on some shapes of material, and the large
// fixture above is not one of them. Nothing is bent to produce it: this is
// six ordinary people and one entry whose title is a seventh name.
const fragmentId = db.createLorebook('HARBOUR FRAGMENT — the north gate', '');
const addTo = (book, e) => db.saveEntry(book, {
  order: 100, enabled: true, constant: false, probability: 100,
  keys: e.keys, kind: e.kind, title: e.title, content: e.content,
});
for (const name of [...PEOPLE, 'Giulia Prato', 'Tomas Reali']) {
  addTo(fragmentId, {
    kind: 'character', title: name, keys: [name, name.split(' ')[1]],
    content: `${name} has worked the harbour since before the new law. ${name} is careful, quiet, and owed `
      + `favours by everyone in the district. People bring ${name} their disputes before the counting house.`,
  });
}
addTo(fragmentId, {
  kind: 'note', title: 'Ottavia Ferri', keys: ['north gate'],
  content: 'Aurelio Fontana wants the north gate contract and Renata Salk means to stop him. '
    + 'The counting house has not ruled, and the tide tables say it must by the evening bell.',
});
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

// What a card shows before anything is opened. Everything inside a <details>
// is a tap away and does not count as primary.
const PRIMARY = (find) => `(() => {
  const c = ${find};
  if (!c) return null;
  const copy = c.cloneNode(true);
  for (const d of copy.querySelectorAll('details')) d.remove();
  return copy.textContent.replace(/\\s+/g, ' ').trim();
})()`;
const DETAILS = (find) => `(() => {
  const c = ${find};
  if (!c) return null;
  return [...c.querySelectorAll('details')].map(d => d.textContent.replace(/\\s+/g,' ')).join(' ');
})()`;
const ASK_CARD = `[...document.querySelectorAll('.rv-ask[data-ask] .edit-card')].find(x => !x.querySelector('.edit-body').hidden)`;

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
console.log("\nthe analyser's workings are not the decision");
{
  const primary = await ev(PRIMARY(ASK_CARD));
  const details = await ev(DETAILS(ASK_CARD));
  ok('no evidence score on the primary card', !/\d+\s*points?\b/i.test(primary), (primary || '').slice(0, 90));
  ok('no "likeliest subject" wording on it either', !/likeliest|evidence is thin/i.test(primary));
  ok('and nothing about how sure Nexus is', !/\b(high|medium|low)\b/i.test(primary));
  ok('but the workings are still there, one tap down', /How sure Nexus is/.test(details || ''));
  ok('asking a model is not a primary action', !/look closer/i.test(primary));
  ok('though it is still offered underneath', /look closer/i.test(details || ''));
  ok('and the semantic controls are still reachable',
    /Type of information/.test(details || '') && /Also connected to/.test(details || ''));
}

// A tick means one thing: this reading will be saved. What the analyser
// proposed is a different fact and is shown as that, because a proposal
// wearing a tick is a proposal claiming to be somebody's decision — and on a
// card that says nothing will be saved, both cannot be true.
console.log('\na proposal is not a decision');
{
  const mismatched = await ev(`(() => {
    const bad = [];
    for (const c of document.querySelectorAll('#sheet-body .edit-card[data-entry-ref]')) {
      const tick = c.querySelector('[data-tick]');
      if (!tick || tick.getAttribute('aria-pressed') === 'true') continue;
      if (c.querySelector('[data-correct]')) continue;
      const pressed = [...c.querySelectorAll('.rv-choice[aria-pressed="true"]')].map(b => b.textContent.trim());
      if (pressed.length) bad.push(((c.querySelector('.edit-head b')||{}).textContent||'?').trim() + ' → ' + pressed.join(', '));
    }
    return bad;
  })()`);
  ok('nothing that will not be saved shows as chosen', mismatched.length === 0, mismatched.slice(0, 3).join(' | '));
  const suggested = await ev(`document.querySelectorAll('#sheet-body .rv-choice.rv-suggested').length`);
  ok("and what Nexus read is still shown, as its reading", suggested > 0, `${suggested} marked as Nexus’s reading`);
  ok('marked in words, not only by styling',
    /Nexus’s reading/.test(await text('#sheet-body .rv-choice.rv-suggested')));
  ok('and a suggested chip is not pressed',
    await ev(`[...document.querySelectorAll('#sheet-body .rv-choice.rv-suggested')].every(b => b.getAttribute('aria-pressed') === 'false')`));
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
    const p = document.querySelector('[data-decided="${picked}"]');
    return p ? p.textContent.replace(/\\s+/g,' ').trim() : '';
  })()`);
  ok('and the reading it produced is shown back', /World information/.test(said), said.slice(0, 90));
  ok('including the category it was recorded under', /World information · \w/.test(said));
  ok('it says whose decision it was', /Decided by you/.test(said));
  ok('and the reading can still be changed', /Change this reading/.test(said));

  // Reopened, it is the same decision with every control back.
  await ev(`document.querySelector('[data-decided="${picked}"] [data-reopen]').click()`);
  await sleep(800);
  const find = `document.querySelector('[data-entry-ref="${picked}"]')`;
  const primary = await ev(PRIMARY(find));
  ok('the decision is what the card says', /✓ World information/.test(primary || ''));
  ok("Nexus's earlier doubt is no longer on the primary card",
    !/could not settle|isn't sure|likeliest/i.test(primary || ''), (primary || '').slice(0, 100));
  // Now, and only now, does the choice show as chosen.
  ok('the chosen reading shows as chosen', await ev(`(() => {
    const c = ${find};
    const chip = [...c.querySelectorAll('.rv-choice')].find(b => /General world material/.test(b.textContent));
    return chip ? chip.getAttribute('aria-pressed') === 'true' && !chip.classList.contains('rv-suggested') : false;
  })()`));
  ok('and its entry is ticked to be saved',
    await ev(`${find}.querySelector('[data-tick]').getAttribute('aria-pressed')`) === 'true');
  await ev(`document.querySelector('[data-done="${picked}"]').click()`);
  await sleep(700);
}

console.log('\nweaker suggestions are offered, never applied in bulk');
{
  await click('#sheet-body .edit-card[data-section="optional"] .edit-head');
  const subs = await count('[data-section="optional"] [data-optional]');
  ok('they are grouped rather than listed', subs >= 1, await text('[data-section="optional"] [data-optional] > .edit-head > b'));
  ok('and each group is shut until it is asked for',
    await count('[data-section="optional"] [data-optional] .edit-card') === 0, `${subs} groups, no cards rendered`);
  await ev(`document.querySelector('[data-section="optional"] [data-optional] .edit-head').click()`);
  await sleep(700);
  ok('opening one shows its suggestions', await count('[data-section="optional"] [data-optional] .edit-card') > 0);
  ok('no control accepts a whole group', await count('[data-accept-section]') === 0);
  const labels = await text('[data-section="optional"] button');
  ok('and no button offers to accept them all', !/accept all|use the \d+|all \d+/i.test(labels));
}

// Saying what an entry introduces, and making the thing it introduces. Both
// live under the fine detail, both are a person's own act, and neither is ever
// begun by Nexus.
console.log('\nsaying what an entry defines');
{
  // A review of its own, so what this does to one entry cannot depend on, or
  // disturb, what the sections before it decided.
  await cdp('Page.navigate', { url: `http://localhost:${port}/` });
  await sleep(2200);
  await click('[data-tab="characters"]');
  await click('[data-shelf="sources"]');
  await click(`[data-lorebook="${bookId}"]`);
  await sleep(800);
  await click(`[data-organize="${bookId}"]`);
  await waitFor('#sheet-body .edit-card', 90000);
  await sleep(1800);
  const ref = await ev(`(() => {
    const c = document.querySelector('.rv-ask[data-ask] .edit-card[data-entry-ref]');
    if (!c) return null;
    if (c.querySelector('.edit-body').hidden) c.querySelector('.edit-head').click();
    return c.getAttribute('data-entry-ref');
  })()`);
  ok('there is a card to decide about', !!ref);
  await sleep(600);
  const at = (sel) => `document.querySelector('[data-entry-ref="${ref}"] ${sel}')`;
  ok('it is offered, and only under the fine detail', await ev(`(() => {
    const c = document.querySelector('[data-entry-ref="${ref}"]');
    const sel = c.querySelector('[data-defines]');
    return !!sel && !!sel.closest('details');
  })()`));
  ok('nothing is chosen for it', await ev(`${at('[data-defines]')}.value`) === '');
  ok('and the words are about things, not people', /defines something/i.test(await ev(`${at('[data-defines]')}.closest('.field').textContent`)));
  ok('no form is open yet', await ev(`!${at('[data-new-name]')}`));

  const saveBefore = await ev(`(document.getElementById('rv-save')||{}).textContent`);
  const tickBefore = await ev(`${at('[data-tick]')}.getAttribute('aria-pressed')`);
  await ev(`${at('[data-define-new]')}.click()`);
  await sleep(700);
  ok('opening the form decides nothing', await ev(`(document.getElementById('rv-save')||{}).textContent`) === saveBefore, saveBefore);
  ok('and ticks nothing', await ev(`${at('[data-tick]')}.getAttribute('aria-pressed')`) === tickBefore);
  ok('the name starts empty', await ev(`${at('[data-new-name]')}.value`) === '');
  ok('no kind is chosen for it', await ev(`${at('[data-new-type]')}.value`) === '');
  const types = await ev(`[...${at('[data-new-type]')}.options].map(o => o.value).filter(Boolean)`);
  ok('every kind of thing is offered', types.length === 6
    && ['person', 'place', 'faction', 'item', 'event', 'concept'].every((t) => types.includes(t)), types.join(', '));

  await ev(`${at('[data-define-create]')}.click()`);
  await sleep(500);
  ok('it will not make something with no name', /name/i.test(await ev(`${at('[data-new-trouble]')}.textContent`))
    && await ev(`${at('[data-defines]')}.value`) === '');
  await ev(`${at('[data-new-name]')}.value = 'The Harbour Board'`);
  await ev(`${at('[data-define-create]')}.click()`);
  await sleep(500);
  ok('nor without being told what kind of thing it is', /kind/i.test(await ev(`${at('[data-new-trouble]')}.textContent`))
    && await ev(`${at('[data-defines]')}.value`) === '');
  ok('and it still has not ticked anything', await ev(`${at('[data-tick]')}.getAttribute('aria-pressed')`) === tickBefore);

  await ev(`(() => { const s = ${at('[data-new-type]')}; s.value = 'faction'; return true; })()`);
  await ev(`${at('[data-define-create]')}.click()`);
  await sleep(900);
  // Deciding moves the entry into Sorted, which is shut until asked for.
  await ev(`(() => { const s = document.querySelector('[data-section="sorted"]'); if (s && s.querySelector('.edit-body').hidden) s.querySelector('.edit-head').click(); return true; })()`);
  await sleep(700);
  await ev(`(() => { const c = document.querySelector('[data-entry-ref="${ref}"]'); if (c && c.querySelector('.edit-body').hidden) c.querySelector('.edit-head').click(); return true; })()`);
  await sleep(600);
  // Deciding must not take the card away from under the finger that decided.
  const pinned = `document.querySelector('[data-decided="${ref}"]')`;
  ok('the entry is still on screen', await ev(`!!${pinned}`));
  ok('in the group it was decided in', await ev(`${pinned}.closest('.rv-ask[data-ask]') !== null`));
  const says = await ev(`${pinned}.textContent.replace(/\\s+/g,' ').trim()`);
  ok('saying what it now introduces', /Describes The Harbour Board/.test(says), says.slice(0, 80));
  ok('what kind of thing that is, and how it is filed', /Group · Profile/.test(says));
  ok('and whose decision it was', /Decided by you/.test(says));
  ok('it does not claim to have been saved', !/\bsaved\b/i.test(says));
  ok('the save count moved', await ev(`(document.getElementById('rv-save')||{}).textContent`) !== saveBefore,
    `${saveBefore} → ${await ev(`(document.getElementById('rv-save')||{}).textContent`)}`);
  ok('and nothing is drawn twice', await ev(`document.querySelectorAll('[data-entry-ref="${ref}"]').length`) === 0);

  console.log('  changing it back');
  await ev(`${pinned}.querySelector('[data-reopen]').click()`);
  await sleep(900);
  ok('the controls come back in the same place', await ev(`(() => {
    const c = document.querySelector('[data-entry-ref="${ref}"]');
    return !!c && !!c.closest('.rv-ask[data-ask]') && !!c.querySelector('[data-defines]');
  })()`));
  ok('still holding the decision', await ev(`${at('[data-defines]')}.value`) === 'the-harbour-board');
  ok('as a profile', await ev(`${at('[data-category]')}.value`) === 'profile');
  ok('about nobody', await ev(`(() => { const s = ${at('[data-subject-other]')}; return s ? s.value : ''; })()`) === '');
  ok('ticked to be saved', await ev(`${at('[data-tick]')}.getAttribute('aria-pressed')`) === 'true');
  ok('and nothing was made a second time',
    await ev(`[...${at('[data-defines]')}.options].filter(o => /Harbour Board/.test(o.textContent)).length`) === 1);

  // Apply refuses an entry that both introduces something and is about
  // something, so the screen must never hold both.
  await ev(`(() => {
    const c = document.querySelector('[data-entry-ref="${ref}"]');
    for (const d of c.querySelectorAll('details')) d.open = true;
    const chip = [...c.querySelectorAll('.rv-choice')].find(b => /General world material/.test(b.textContent));
    chip.click(); return true;
  })()`);
  await sleep(900);
  await ev(`(() => { const p = document.querySelector('[data-decided="${ref}"] [data-reopen]'); if (p) p.click(); return true; })()`);
  await sleep(800);
  ok('changing to an ordinary reading clears what it defined', await ev(`(() => {
    const s = document.querySelector('[data-entry-ref="${ref}"] [data-defines]');
    return s ? s.value : 'card gone';
  })()`) !== 'the-harbour-board');

  console.log('  and moving on');
  await ev(`(() => { const b = document.querySelector('[data-done="${ref}"]'); if (b) b.click(); return true; })()`);
  await sleep(900);
  ok('the confirmation goes when it is dismissed', await ev(`!document.querySelector('[data-decided="${ref}"]')`));
  await ev(`(() => { const s = document.querySelector('[data-section="sorted"]'); if (s && s.querySelector('.edit-body').hidden) s.querySelector('.edit-head').click(); return true; })()`);
  await sleep(800);
  ok('and the entry is simply in Sorted, one line, once', await ev(`(() => {
    const all = document.querySelectorAll('[data-entry-ref="${ref}"]');
    return all.length === 1 && all[0].classList.contains('compact') && !!all[0].closest('[data-section="sorted"]');
  })()`), `${await ev(`document.querySelectorAll('[data-entry-ref="${ref}"]').length`)} in the page`);
}

// The same transition, for a decision that has nothing to do with defining:
// the behaviour belongs to deciding, not to one control.
console.log('\nan ordinary decision is acknowledged the same way');
{
  await cdp('Page.navigate', { url: `http://localhost:${port}/` });
  await sleep(2200);
  await click('[data-tab="characters"]');
  await click('[data-shelf="sources"]');
  await click(`[data-lorebook="${bookId}"]`);
  await sleep(800);
  await click(`[data-organize="${bookId}"]`);
  await waitFor('#sheet-body .edit-card', 90000);
  await sleep(1800);
  ok('a review opened afresh has nothing pinned', await ev(`document.querySelectorAll('[data-decided]').length`) === 0);
  const ref = await ev(`(() => {
    const c = [...document.querySelectorAll('.rv-ask[data-ask] .edit-card[data-entry-ref]')]
      .find(x => x.querySelector('.rv-choice'));
    if (!c) return null;
    if (c.querySelector('.edit-body').hidden) c.querySelector('.edit-head').click();
    return c.getAttribute('data-entry-ref');
  })()`);
  await sleep(600);
  await ev(`(() => {
    const c = document.querySelector('[data-entry-ref="${ref}"]');
    [...c.querySelectorAll('.rv-choice')].find(b => /General world material/.test(b.textContent)).click();
    return true;
  })()`);
  await sleep(900);
  const says = await ev(`(() => { const p = document.querySelector('[data-decided="${ref}"]'); return p ? p.textContent.replace(/\\s+/g,' ').trim() : null; })()`);
  ok('it stays where it was decided', !!says);
  ok('saying what was understood', /World information/.test(says || ''), (says || '').slice(0, 70));
  ok('and whose decision it was', /Decided by you/.test(says || ''));
  ok('without claiming to be saved', !/\bsaved\b/i.test(says || ''));
  await ev(`document.querySelector('[data-done="${ref}"]').click()`);
  await sleep(800);
  ok('Done puts it away', await ev(`!document.querySelector('[data-decided="${ref}"]')`));
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


// A name the source never establishes means exactly that, and nothing more.
// It does not mean the entry introduces that person, describes them, is about
// them, or that they should be made. Two real entries carry this same flag and
// need opposite answers — one is the named person's own profile, the other is
// guidance about somebody else — so the card must claim neither.
console.log('\na name the source never establishes claims nothing');
{
  await cdp('Page.navigate', { url: `http://localhost:${port}/` });
  await sleep(2200);
  await click('[data-tab="characters"]');
  await click('[data-shelf="sources"]');
  await click(`[data-lorebook="${fragmentId}"]`);
  await sleep(800);
  await click(`[data-organize="${fragmentId}"]`);
  await waitFor('#sheet-body .edit-card', 90000);
  await sleep(1800);
  const named = `[...document.querySelectorAll('.rv-ask[data-ask="named"] .edit-card')][0]`;
  const found = await ev(`(() => { const c = ${named}; if (!c) return false; if (c.querySelector('.edit-body').hidden) c.querySelector('.edit-head').click(); return true; })()`);
  ok('the fixture produces one to look at', found === true);
  if (found) {
    await sleep(700);
    const primary = await ev(PRIMARY(named));
    const details = await ev(DETAILS(named));
    ok('it does not call the entry that person’s own', !/own entry|own profile/i.test(primary), primary.slice(0, 120));
    ok('it does not say the entry introduces or defines them', !/\b(introduces?|defines?)\b/i.test(primary));
    ok('it does not say the entry is about them', !/\bis about\b/i.test(primary));
    ok('it says only that the name is not established', /mentions .*(a name|names) Nexus hasn’t established/i.test(primary));
    // Every answer available for such an entry is a fallback, and a fallback in
    // the place the recommended answer goes reads as the recommended answer.
    ok('no reading is offered as the primary answer', !/General world material/.test(primary));
    ok('leaving it is offered', /Leave for later/.test(primary));
    ok('and asking a model is offered', /Ask Nexus to look closer/.test(primary));
    ok('the readings are still all there, one tap down', /General world material/.test(details || ''));
    ok('including the semantic controls', /Type of information/.test(details || '') && /Also connected to/.test(details || ''));
    ok('and rendering the card selected nothing',
      await ev(`${named}.querySelector('[data-tick]').getAttribute('aria-pressed')`) === 'false');
  }
}


ok('the screen threw no errors while being driven', thrown.length === 0, thrown.join(' / ').slice(0, 200));

try { ws.close(); } catch { /* */ }
stop();
await sleep(300);
rmSync(work, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exitCode = fail ? 1 : 0;
