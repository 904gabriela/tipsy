// What a source IS, is a decision about the source.
//
// The review has always shown Nexus's reading of that — "mostly one person's
// material", "a narrative framework" — and has always sent it along with
// whatever else was being saved. So deciding that one entry in CLASS 1-A is
// Izuku's profile also settled, permanently and silently, what the whole
// hundred-and-fifty-eight-piece source is for. Nobody chose that.
//
// Three states, and only one of them may be written here:
//
//   approved   somebody settled it before. Saving anything else leaves it
//              exactly where it is — by saying nothing about it at all.
//   proposed   the analyser's reading. A suggestion. Opening the screen is
//              not agreeing, and neither is saving an unrelated entry.
//   decided    somebody said so, here, just now.
//
// The same question is asked of the subject a source is about, and of the
// people a source declares — an entity being available to a review is not a
// decision that the source is about them.
//
//   node scripts/check-source-role.js
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

if (!existsSync(PROD)) { note('no data/tipsy.db here — skipped'); process.exit(0); }
if (!existsSync(CHROME)) { note('no Chrome here — skipped'); process.exit(0); }

const dir = mkdtempSync(join(tmpdir(), 'nexus-role-'));
const COPY = join(dir, 'copy.db').replace(/\\/g, '/');
const named = (dbPath, MHAid) => {
  const d = new DatabaseSync(dbPath, { readOnly: true });
  const q = (s, ...a) => d.prepare(s).get(...a).c;
  const n = {
    lore_entities: q('SELECT COUNT(*) c FROM lore_entities'),
    source_entities: q('SELECT COUNT(*) c FROM source_entities'),
    entry_semantics: q('SELECT COUNT(*) c FROM entry_semantics'),
    entry_relations: q('SELECT COUNT(*) c FROM entry_relations'),
    source_semantics: q('SELECT COUNT(*) c FROM source_semantics'),
    entity_distinctions: q('SELECT COUNT(*) c FROM entity_distinctions'),
    MHA_entry_semantics: MHAid ? q('SELECT COUNT(*) c FROM entry_semantics s JOIN lore_entries e ON e.id=s.entry_id WHERE e.lorebook_id=?', MHAid) : 0,
    MHA_source_semantics: MHAid ? q('SELECT COUNT(*) c FROM source_semantics WHERE lorebook_id=?', MHAid) : 0,
  };
  d.close();
  return n;
};
{
  const d = new DatabaseSync(PROD, { readOnly: true });
  const m = d.prepare("SELECT id FROM lorebooks WHERE name LIKE '%MHA MASTER%'").get();
  d.close();
  if (!m) { note('no MHA MASTER CANON in this library — skipped'); process.exit(0); }
}
const dP = new DatabaseSync(PROD, { readOnly: true });
const MHA = dP.prepare("SELECT id, name FROM lorebooks WHERE name LIKE '%MHA MASTER%'").get();
const SAINT = dP.prepare("SELECT id, name FROM lorebooks WHERE name LIKE '%Saint%'").get();
dP.close();
const prodBefore = named(PROD, MHA.id);
{
  const src = new DatabaseSync(PROD, { readOnly: true }); src.exec(`VACUUM INTO '${COPY}'`); src.close();
  const c = new DatabaseSync(COPY); c.prepare("DELETE FROM settings WHERE key='auth'").run(); c.close();
}

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
const errors = [];
ws.addEventListener('message', (m) => {
  const x = JSON.parse(m.data);
  if (x.id && pending.has(x.id)) { pending.get(x.id)(x); pending.delete(x.id); }
  if (x.method === 'Runtime.exceptionThrown') errors.push(String(x.params.exceptionDetails?.exception?.description).slice(0, 160));
});
const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description).slice(0, 250));
  return r.result?.result?.value;
};
await cdp('Page.enable'); await cdp('Runtime.enable');
const waitFor = async (sel, ms = 180000) => {
  for (let t = 0; t < ms; t += 250) { if (await ev(`!!document.querySelector(${JSON.stringify(sel)})`)) return true; await sleep(250); }
  return false;
};
const click = async (sel, wait = 900) => {
  if (!await waitFor(sel, 30000)) return false;
  await ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
  await sleep(wait);
  return true;
};
const text = (sel) => ev(`((document.querySelector(${JSON.stringify(sel)})||{}).textContent || '').replace(/\\s+/g,' ').trim()`);
const saveNow = async () => {
  const enabled = await ev(`(() => { const b = document.getElementById('rv-save');
    return b ? { text: b.textContent.trim(), disabled: b.disabled } : null; })()`);
  if (!enabled || enabled.disabled) return { saved: false, why: enabled ? enabled.text : 'no button' };
  await click('#rv-save', 1600);
  const confirmed = await ev(`(() => { const b = [...document.querySelectorAll('#sheet-body button, .sheet button')]
    .find(x => /^save\\b/i.test(x.textContent.trim()) && x.id !== 'rv-save');
    if (b) { b.click(); return b.textContent.replace(/\\s+/g,' ').trim(); } return null; })()`);
  await sleep(5000);
  return { saved: !!confirmed, why: confirmed };
};
// What the app itself calls a role, taken from its own control rather than
// guessed at: "reference-pack" is shown to a person as words, not as an id.
const labelFor = async (value) => {
  await click('#rv-change-role', 700);
  const label = await ev(`(() => { const o = document.querySelector('#rv-role option[value=${JSON.stringify(value)}]');
    return o ? o.textContent.trim() : null; })()`);
  await click('#rv-change-role', 700);
  return label;
};
const roleRow = (bookId) => {
  const d = new DatabaseSync(COPY, { readOnly: true });
  const r = d.prepare('SELECT package_role, subject_entity_id, origin, status, evidence FROM source_semantics WHERE lorebook_id=?').get(bookId);
  const n = d.prepare('SELECT COUNT(*) c FROM source_semantics WHERE lorebook_id=?').get(bookId).c;
  d.close();
  return { row: r || null, rows: n };
};
const openReview = async (bookId, group = null) => {
  await cdp('Page.navigate', { url: `http://localhost:${port}/?t=${Date.now()}` });
  await sleep(2300);
  await click('[data-tab="characters"]');
  await click('[data-shelf="sources"]');
  await click(`[data-lorebook="${bookId}"]`, 1200);
  if (group) {
    await click(`[data-view-source="${bookId}"]`, 1600);
    await click('[data-src-view="filing"]', 800);
    await click(`[data-src-group="f:${group}"]`, 1100);
    await click('[data-src-understand]', 1500);
  } else {
    await click(`[data-organize="${bookId}"]`, 1400);
  }
  await waitFor('#sheet-body .edit-card', 180000);
  await sleep(3000);
};

await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });

// ------------------------------------------------------- MHA: proposed only
console.log(`\n${MHA.name} — nothing settled about it`);
const mhaBefore = roleRow(MHA.id);
ok('this source has never been settled as anything', mhaBefore.rows === 0, `${mhaBefore.rows} rows`);

await openReview(MHA.id, '04 CLASS 1-A');
const said = await text('#sheet-body .rv-said');
const shown = await text('#sheet-body .rv-role');
const why = await text('#sheet-body .rv-summary .why');
console.log(`      "${said}" ${shown}`);
console.log(`      "${why}"`);
ok('the reading is offered as a reading', /Nexus thinks this is/.test(said), said);
ok('and says plainly that nothing is saved about it',
  /Nothing is saved about this unless you choose it/i.test(why), why.slice(-60));

const ticked = Number((await text('#rv-save')).replace(/\D+/g, ''));
console.log(`      saving ${ticked} entry decisions, touching the role not at all`);
await saveNow();

const afterEntries = roleRow(MHA.id);
const d1 = new DatabaseSync(COPY, { readOnly: true });
const wrote = d1.prepare('SELECT COUNT(*) c FROM entry_semantics s JOIN lore_entries e ON e.id=s.entry_id WHERE e.lorebook_id=?').get(MHA.id).c;
d1.close();
ok('the entry decisions were saved', wrote === ticked, `${wrote} of ${ticked}`);
ok('and no source role was invented from a suggestion',
  afterEntries.rows === 0, `${afterEntries.rows} source_semantics rows`);
ok('nor any source subject', afterEntries.row === null);

// -------------------------------------------------- MHA: an actual decision
console.log('\nNow actually deciding what the source is');
await openReview(MHA.id, '04 CLASS 1-A');
await click('#rv-change-role', 800);
const options = await ev(`[...document.querySelectorAll('#rv-role option')].map(o => o.value)`);
const pick = options.find((o) => o === 'reference-pack') || options.find((o) => o && o !== 'entity-material');
await ev(`(() => { const s = document.getElementById('rv-role');
  s.value = ${JSON.stringify(pick)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await sleep(900);
const saidNow = await text('#sheet-body .rv-said');
console.log(`      chose ${pick} → "${saidNow}"`);
ok('the screen says it is now yours, not Nexus\'s', /You have said this is/.test(saidNow), saidNow);
const roleSave = await saveNow();
console.log(`      saved via: ${JSON.stringify(roleSave)}`);
ok('deciding what the source is can be saved on its own, with no entry decided alongside it',
  roleSave.saved === true, JSON.stringify(roleSave));

const afterChoice = roleRow(MHA.id);
console.log(`      stored: ${JSON.stringify(afterChoice.row)}`);
ok('an explicit decision is written', afterChoice.rows === 1 && afterChoice.row.package_role === pick,
  `${afterChoice.rows} row · ${afterChoice.row?.package_role}`);
ok('exactly once', afterChoice.rows === 1);
ok('and it is recorded as a person\'s decision',
  JSON.parse(afterChoice.row.evidence || '{}').proposedBy === 'manual', afterChoice.row.evidence);
ok('a role that is not entity-material carries no subject',
  afterChoice.row.subject_entity_id === null, String(afterChoice.row.subject_entity_id));

// ------------------------------------------- MHA: approved survives a save
console.log('\nAnd now it is settled, an unrelated save must leave it alone');
await openReview(MHA.id, '05 CLASS 1-B');
const saidAfter = await text('#sheet-body .rv-said');
const shownAfter = await text('#sheet-body .rv-role');
console.log(`      "${saidAfter}" ${shownAfter}`);
const pickLabel = await labelFor(pick);
ok('the settled answer is shown, not the analyser\'s',
  /was settled as/.test(saidAfter) && shownAfter === pickLabel,
  `shows "${shownAfter}", stored role reads "${pickLabel}"`);
ok('and it says it will not change by itself',
  /Nothing you do here changes it unless you change it/i.test(await text('#sheet-body .rv-summary .why')));
await saveNow();
const stillThere = roleRow(MHA.id);
ok('saving other entries left the settled role exactly as it was',
  stillThere.rows === 1 && stillThere.row.package_role === pick
  && stillThere.row.evidence === afterChoice.row.evidence,
  `${stillThere.row?.package_role} · ${stillThere.row?.evidence}`);

// ---------------------------------------------------------------- Patrick
console.log(`\n${SAINT ? SAINT.name : 'The Saint'} — already settled as mixed`);
if (!SAINT) note('no Saint source in this library — skipped');
else {
  const before = roleRow(SAINT.id);
  console.log(`      before: ${JSON.stringify(before.row)}`);
  ok('it starts approved as mixed, about nobody',
    before.row?.package_role === 'mixed' && before.row?.subject_entity_id === null && before.row?.status === 'approved');
  const beforeEvidence = before.row.evidence;

  await openReview(SAINT.id);
  const saidSaint = await text('#sheet-body .rv-said');
  const shownSaint = await text('#sheet-body .rv-role');
  console.log(`      review shows: "${saidSaint}" ${shownSaint}`);
  const mixedLabel = await labelFor('mixed');
  ok('the review shows what was settled, not what the analyser would say',
    /was settled as/.test(saidSaint) && shownSaint === mixedLabel,
    `shows "${shownSaint}", "mixed" reads "${mixedLabel}"`);

  // Touch an entry, nothing else, and save.
  const beforeEntries = (() => { const d = new DatabaseSync(COPY, { readOnly: true });
    const c = d.prepare('SELECT COUNT(*) c FROM entry_semantics s JOIN lore_entries e ON e.id=s.entry_id WHERE e.lorebook_id=?').get(SAINT.id).c;
    d.close(); return c; })();
  const ready = Number((await text('#rv-save')).replace(/\D+/g, '') || '0');
  if (ready) await saveNow(); else note('nothing left to save in The Saint; the role check stands on its own');

  const after = roleRow(SAINT.id);
  console.log(`      after:  ${JSON.stringify(after.row)}`);
  ok('the role is still mixed', after.row?.package_role === 'mixed', after.row?.package_role);
  ok('the subject is still nobody', after.row?.subject_entity_id === null);
  ok('its provenance is untouched', after.row?.evidence === beforeEvidence, after.row?.evidence);
  ok('and there is still exactly one row for this source', after.rows === 1, `${after.rows}`);
  const afterEntriesCount = (() => { const d = new DatabaseSync(COPY, { readOnly: true });
    const c = d.prepare('SELECT COUNT(*) c FROM entry_semantics s JOIN lore_entries e ON e.id=s.entry_id WHERE e.lorebook_id=?').get(SAINT.id).c;
    d.close(); return c; })();
  ok('Patrick\'s own material is unharmed', afterEntriesCount >= beforeEntries, `${beforeEntries} -> ${afterEntriesCount}`);
}

// --------------------------------------- context is not a source-level decision
console.log('\nBeing available to a review is not being decided about');
const d2 = new DatabaseSync(COPY, { readOnly: true });
const declaredMHA = d2.prepare('SELECT COUNT(*) c FROM source_entities WHERE lorebook_id=?').get(MHA.id).c;
const usedMHA = d2.prepare(`SELECT COUNT(DISTINCT x.id) c FROM lore_entities x
  WHERE x.id IN (SELECT defines_entity_id FROM entry_semantics s JOIN lore_entries e ON e.id=s.entry_id
                 WHERE e.lorebook_id=? AND s.defines_entity_id IS NOT NULL)
     OR x.id IN (SELECT r.entity_id FROM entry_relations r JOIN lore_entries e ON e.id=r.entry_id
                 WHERE e.lorebook_id=?)`).get(MHA.id, MHA.id).c;
d2.close();
const offered = await (async () => {
  await openReview(MHA.id, '13 DEVELOPMENT');
  return ev(`new Set([...document.querySelectorAll('#sheet-body [data-defines] option')]
    .map(o => o.textContent.trim()).filter(t => !/^Choose/.test(t))).size`);
})();
console.log(`      offered to review: ${offered} · declared in the source: ${declaredMHA} · actually used: ${usedMHA}`);
ok('far more people are available than were declared',
  offered > declaredMHA, `${offered} offered vs ${declaredMHA} declared`);
ok('only the ones an approved entry actually used were declared',
  declaredMHA === usedMHA, `${declaredMHA} declared, ${usedMHA} used`);

ok('nothing threw throughout', errors.length === 0, errors.slice(0, 2).join(' | '));

// -------------------------------------------------------------- production
const prodAfter = named(PROD, MHA.id);
ok('production is untouched by all of it',
  JSON.stringify(prodBefore) === JSON.stringify(prodAfter), JSON.stringify(prodAfter));
ok('production MHA has no entry semantics', prodAfter.MHA_entry_semantics === 0);
ok('production MHA has no source semantics', prodAfter.MHA_source_semantics === 0);

try { ws.close(); } catch { /* closing */ }
chrome.kill(); app.kill();
await sleep(400);
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exitCode = fail ? 1 : 0;
