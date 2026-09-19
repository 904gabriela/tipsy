// A phone screen scrolls up and down. It does not scroll sideways.
//
// A source with long trigger words used to break that. A card is a grid item,
// and a grid item is at least as wide as its longest unbreakable line, so one
// entry whose trigger word ran to eighty characters made its column that wide,
// every card in the list with it, and the whole screen could then be dragged
// sideways off the edge. The key line was already asked to cut itself short
// with an ellipsis, but it was a bare span, and overflow does nothing at all
// to an inline box, so it never did.
//
// What is asserted here is the contract, not the repair: the page itself, and
// every region that scrolls, may scroll up and down and must not scroll
// sideways. A small strip inside one that is meant to be swiped — the tag
// filters, the story tools — is free to, and is not one of these regions.
//
//   node scripts/check-layout.js
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

const chromePath = () => {
  const named = process.env.CHROME_PATH;
  const guesses = [named,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return guesses.find((p) => existsSync(p)) || null;
};

const chrome = chromePath();
if (!chrome) {
  console.log('No Chrome found, so the screen cannot be measured. Set CHROME_PATH to one and run again.');
  process.exitCode = 1;
  process.exit();
}

// A source shaped like a real one: long titles, and trigger words that are
// whole clauses rather than names. That last part is what used to do it.
const work = mkdtempSync(join(tmpdir(), 'nexus-layout-'));
const dbPath = join(work, 'x.db');
const db = open(dbPath);
const bookId = db.createLorebook('HARBOUR CANON LOREBOOK — Day 1 Progressive Continuity', '');
const LONG_KEY = 'STATE: POST_HARBOUR_TRIAL, after the harbour trial and before the winter audit';
for (let i = 0; i < 24; i++) {
  db.saveEntry(bookId, {
    order: 100 + i, enabled: true, constant: false, probability: 100,
    kind: i % 3 === 0 ? 'character' : 'note',
    keys: [`Aurelio Fontana ${i}`, LONG_KEY, 'a second trigger word of considerable length', 'Fontana'],
    title: `11 TIMELINE — POST_HARBOUR_TRIAL_${i} — harbour trial complete and the ledger reopened`,
    content: `NAME: Aurelio Fontana ${i}\nHOLDS: the books for three families, and the patience of none of them.\n`
      + 'STABLE CORE: careful, quiet, owed favours by everyone, and unwilling to collect on any of them yet.',
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
  console.log(`  Could not start a browser to measure with: ${err.message}`);
  stop();
  rmSync(work, { recursive: true, force: true });
  process.exitCode = 1;
  process.exit();
}

let seq = 0;
const pending = new Map();
ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
});
const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description).slice(0, 200));
  return r.result?.result?.value;
};
await cdp('Page.enable');
await cdp('Runtime.enable');
const waitFor = async (sel, ms = 30000) => {
  for (let t = 0; t < ms; t += 200) { if (await ev(`!!document.querySelector(${JSON.stringify(sel)})`)) return true; await sleep(200); }
  return false;
};
const click = async (sel) => {
  if (!await waitFor(sel)) throw new Error(`nothing matched ${sel}`);
  await ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
  await sleep(700);
};

// The page, and every region that scrolls. A carousel is not one of these.
const MEASURE = `(() => {
  const regions = [
    ['the page', document.documentElement],
    ...[...document.querySelectorAll('.scroll, .sheet-body')].map((el) => [el.id ? '#' + el.id : el.className.trim().split(/\\s+/)[0], el]),
  ];
  const vw = document.documentElement.clientWidth;
  const out = [];
  for (const [name, el] of regions) {
    const r = el.getBoundingClientRect();
    if (el !== document.documentElement && (r.width === 0 || r.height === 0)) continue;
    out.push({ name, sideways: el.scrollWidth - el.clientWidth });
  }
  let worst = null;
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const over = r.right - vw;
    if (over > 0.5 && (!worst || over > worst.over)) {
      worst = { over: Math.round(over), tag: el.tagName.toLowerCase(),
        cls: (typeof el.className === 'string' ? el.className : '').slice(0, 40), width: Math.round(r.width) };
    }
  }
  return { regions: out, worst };
})()`;

const check = async (label) => {
  const m = await ev(MEASURE);
  const bad = m.regions.filter((r) => r.sideways > 1);
  ok(label, bad.length === 0, bad.length
    ? `${bad.map((b) => `${b.name} scrolls ${b.sideways}px sideways`).join('; ')}${m.worst ? ` — widest is ${m.worst.tag}.${m.worst.cls} at ${m.worst.width}px, ${m.worst.over}px past the edge` : ''}`
    : `${m.regions.length} region${m.regions.length === 1 ? '' : 's'}, none scroll sideways`);
};

// The widths of the phones this is actually read on, and one desktop, because
// a fix for a phone that cost the desktop its layout would be no fix.
const WIDTHS = [320, 375, 390, 430, 1280];

for (const width of WIDTHS) {
  console.log(`\n${width}px${width >= 1000 ? '  (desktop)' : ''}`);
  await cdp('Emulation.setDeviceMetricsOverride', {
    width, height: width >= 1000 ? 900 : 844, deviceScaleFactor: 1, mobile: width < 1000,
  });
  await cdp('Page.navigate', { url: `http://localhost:${port}/?t=${width}` });
  await sleep(1800);
  await click('[data-tab="characters"]');
  await click('[data-shelf="sources"]');
  await click(`[data-lorebook="${bookId}"]`);
  await sleep(900);
  await check('a source of long entries does not drag sideways');

  await click(`[data-organize="${bookId}"]`);
  const opened = await waitFor('#sheet-body .edit-card', 60000);
  await sleep(1200);
  ok('  the review opens', opened);
  if (opened) await check('  and the review does not drag sideways either');
}

// The two rules the repair rests on, so that removing one of them fails here
// with its reason rather than somewhere else without it.
console.log('\nwhy it holds');
{
  const card = await ev(`(() => { const c = document.querySelector('.card'); if (!c) return null; const s = getComputedStyle(c); return { minWidth: s.minWidth }; })()`);
  const keys = await ev(`(() => { const k = document.querySelector('.card-keys'); if (!k) return null; const s = getComputedStyle(k); return { display: s.display, overflow: s.overflowX, ellipsis: s.textOverflow }; })()`);
  ok('a card cannot force its column wider than itself', card?.minWidth === '0px', `min-width ${card?.minWidth}`);
  ok('and the key line can actually cut itself short', keys && keys.display !== 'inline' && keys.overflow === 'hidden' && keys.ellipsis === 'ellipsis',
    keys ? `display ${keys.display}, overflow ${keys.overflow}, text-overflow ${keys.ellipsis}` : '(no key line on screen)');
}

try { ws.close(); } catch { /* */ }
stop();
await sleep(300);
rmSync(work, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exitCode = fail ? 1 : 0;
