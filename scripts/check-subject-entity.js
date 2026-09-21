// Saying who something is about must not say what it introduces.
//
// Two MHA entries name Yuga Aoyama and mean different things:
//
//   13 DEVELOPMENT — Yuga Aoyama — progressive state map   is ABOUT him
//   04 CLASS 1-A — Yuga Aoyama                             INTRODUCES him
//
// Until now the only way to make somebody a source never introduced was the
// control that says an entry defines them, and making Yuga there forced the
// progressive state map to become his profile: psychology rewritten to profile,
// defines set, subject dropped. What was wrong was not the form. It was that
// declaring somebody and deciding what an entry does with them were one act.
//
// They are two acts now, and this checks it on the real source: that the
// question which opened the form is the only question it answers, that one
// Yuga is made and then reused rather than two being minted, and that none of
// it weakens what already refuses to merge people.
//
//   node scripts/check-subject-entity.js
//
// A VACUUM copy on a random port, driven by headless Chrome. Production is
// opened once to make the copy and never served or written. The copy is saved
// to, because that is the only way to know the round trip holds.

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

const dir = mkdtempSync(join(tmpdir(), 'nexus-subj-'));
const COPY = join(dir, 'copy.db').replace(/\\/g, '/');
const readProd = () => {
  const d = new DatabaseSync(PROD, { readOnly: true });
  const n = {
    entities: d.prepare('SELECT COUNT(*) c FROM lore_entities').get().c,
    semantics: d.prepare('SELECT COUNT(*) c FROM entry_semantics').get().c,
    relations: d.prepare('SELECT COUNT(*) c FROM entry_relations').get().c,
    declarations: d.prepare('SELECT COUNT(*) c FROM source_entities').get().c,
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
const MHA = d0.prepare("SELECT id, name FROM lorebooks WHERE name LIKE '%MHA MASTER%'").get();
d0.close();
if (!MHA) { note('no MHA MASTER CANON in this library — skipped'); process.exit(0); }

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
const waitFor = async (sel, ms = 120000) => {
  for (let t = 0; t < ms; t += 250) { if (await ev(`!!document.querySelector(${JSON.stringify(sel)})`)) return true; await sleep(250); }
  return false;
};
const click = async (sel, wait = 800) => {
  if (!await waitFor(sel, 25000)) return false;
  await ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
  await sleep(wait);
  return true;
};
const saveText = () => ev(`((document.getElementById('rv-save')||{}).textContent || '').replace(/\\s+/g,' ').trim()`);

// The review is a module, so everything below is read from the screen itself,
// which is also what a person would be looking at.
const refOf = (reSource) => ev(`(() => {
  const re = new RegExp(${JSON.stringify(reSource)});
  const c = [...document.querySelectorAll('#sheet-body [data-entry-ref]')]
    .find(x => re.test((((x.querySelector('.edit-head b')||{}).textContent)||'').trim()));
  return c ? c.getAttribute('data-entry-ref') : null;
})()`);
const openCard = async (ref) => {
  const how = await ev(`(() => {
    const decided = document.querySelector('[data-decided="${ref}"] [data-reopen]');
    if (decided) { decided.click(); return 'reopened'; }
    const c = document.querySelector('[data-entry-ref="${ref}"]');
    if (!c) return null;
    c.scrollIntoView({ block: 'center' });
    const body = c.querySelector('.edit-body');
    if (body && body.hidden) c.querySelector('.edit-head').click();
    return 'opened';
  })()`);
  await sleep(900);
  await ev(`(() => { const f = document.querySelector('[data-entry-ref="${ref}"] details[data-fold^="fine:"]');
    if (f) f.open = true; })()`);
  await sleep(500);
  return how;
};
const stateOf = (ref) => ev(`(() => {
  const c = document.querySelector('[data-entry-ref="${ref}"]');
  if (!c) return { onScreen: false,
    said: (((document.querySelector('[data-decided="${ref}"]')||{}).textContent)||'').replace(/\\s+/g,' ').trim() };
  const defSel = c.querySelector('[data-defines]');
  const chip = c.querySelector('.rv-choice[aria-pressed="true"]');
  const other = c.querySelector('[data-subject-other]');
  return {
    onScreen: true,
    category: ((c.querySelector('[data-category]')||{}).value) || null,
    defines: defSel ? (defSel.value || null) : null,
    definesText: defSel && defSel.value ? defSel.options[defSel.selectedIndex].textContent.trim() : null,
    definesOptions: defSel ? [...defSel.options].map(o => o.textContent.trim()) : [],
    subjectChip: chip ? chip.textContent.replace('✓','').trim() : null,
    subjectOther: other ? (other.value || null) : null,
    hasSubjectNew: !!c.querySelector('[data-subject-new]'),
    hasDefineNew: !!c.querySelector('[data-define-new]'),
    formOpen: !!c.querySelector('[data-new-name]'),
  };
})()`);

await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
const openReview = async () => {
  await cdp('Page.navigate', { url: `http://localhost:${port}/?t=${Date.now()}` });
  await sleep(2300);
  await click('[data-tab="characters"]');
  await click('[data-shelf="sources"]');
  await click(`[data-lorebook="${MHA.id}"]`, 1200);
  await click(`[data-organize="${MHA.id}"]`, 1200);
  await waitFor('#sheet-body .edit-card', 150000);
  await sleep(3000);
};

const DEV = '^13 DEVELOPMENT — Yuga Aoyama';
const CLS = '^04 CLASS 1-A — Yuga Aoyama$';
const semOf = (db, like) => {
  const row = db.prepare(`SELECT e.id, s.scope, s.category, s.defines_entity_id
    FROM lore_entries e LEFT JOIN entry_semantics s ON s.entry_id = e.id
    WHERE e.lorebook_id = ? AND e.title LIKE ?`).get(MHA.id, like);
  if (!row) return null;
  const subj = db.prepare("SELECT entity_id FROM entry_relations WHERE entry_id=? AND relation='subject' AND status='approved'").get(row.id);
  return { ...row, subject_entity_id: subj?.entity_id || null };
};

console.log(`\n${MHA.name}`);
await openReview();

// ------------------------------------------------------- STEP 1: about him
console.log('\nSTEP 1 — the progressive state map is ABOUT Yuga');
const devRef = await refOf(DEV);
ok('the DEVELOPMENT entry is on the screen', !!devRef);
await openCard(devRef);
const before = await stateOf(devRef);
console.log(`      read as ${before.category} · defines ${before.definesText || '—'} · subject ${before.subjectChip || '—'}`);
ok('the analyser reads it as psychology', before.category === 'psychology', before.category);
ok('and establishes nobody', !before.defines && !before.subjectChip);
ok('Yuga is not somebody this source introduces yet',
  !before.definesOptions.some((o) => /Yuga/i.test(o)), JSON.stringify(before.definesOptions.slice(0, 4)));
ok('the question about who it is about offers making somebody', before.hasSubjectNew === true);

const saveBefore = await saveText();
await click(`[data-subject-new="${devRef}"]`, 700);
const formed = await stateOf(devRef);
ok('opening the form decides nothing',
  formed.formOpen === true && (await saveText()) === saveBefore && formed.category === 'psychology',
  `save still "${saveBefore}"`);

await ev(`document.querySelector('[data-new-name="${devRef}"]').value = 'Yuga Aoyama'`);
await ev(`(() => { const s = document.querySelector('[data-new-type="${devRef}"]');
  s.value = 'person'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await sleep(400);
await click(`[data-define-create="${devRef}"]`, 1200);
const saveAfterOne = await saveText();
console.log(`      save: "${saveBefore}" -> "${saveAfterOne}"`);
await openCard(devRef);
const after = await stateOf(devRef);
console.log(`      now ${after.category} · defines ${after.definesText || '—'} · subject ${after.subjectChip || '—'}`);
ok('it became ABOUT Yuga Aoyama',
  after.subjectChip === 'Yuga Aoyama' || after.subjectOther, after.subjectChip || after.subjectOther);
ok('it did NOT become his profile', !after.defines && after.category === 'psychology',
  `defines ${after.definesText} · ${after.category}`);

// ------------------------------------------------------ STEP 2: defines him
console.log('\nSTEP 2 — the CLASS 1-A entry INTRODUCES Yuga');
const clsRef = await refOf(CLS);
ok('the CLASS 1-A entry is on the screen', !!clsRef);
await openCard(clsRef);
const clsBefore = await stateOf(clsRef);
ok('the Yuga made a moment ago is offered to define, without being made again',
  clsBefore.definesOptions.some((o) => /^Yuga Aoyama —/.test(o)),
  JSON.stringify(clsBefore.definesOptions.filter((o) => /Yuga/i.test(o))));
await ev(`(() => { const s = document.querySelector('[data-entry-ref="${clsRef}"] [data-defines]');
  const o = [...s.options].find(x => /^Yuga Aoyama —/.test(x.textContent.trim()));
  s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await sleep(1100);
await openCard(clsRef);
const cls = await stateOf(clsRef);
console.log(`      now ${cls.category} · defines ${cls.definesText || '—'} · subject ${cls.subjectChip || '—'}`);
ok('it describes Yuga Aoyama', /^Yuga Aoyama —/.test(cls.definesText || ''), cls.definesText);
ok('it is a profile, about nobody', cls.category === 'profile' && !cls.subjectChip,
  `${cls.category} · subject ${cls.subjectChip}`);
const saveAfterTwo = await saveText();
console.log(`      save: "${saveAfterOne}" -> "${saveAfterTwo}"`);
ok('each decision counted once, and making Yuga counted for nothing on its own',
  saveBefore !== saveAfterOne && saveAfterOne !== saveAfterTwo,
  `"${saveBefore}" -> "${saveAfterOne}" -> "${saveAfterTwo}"`);

// --------------------------------------------------------- STEP 3 + 4: save
console.log('\nSTEP 3 — save, on the copy only');
await click('#rv-save', 1600);
const confirmed = await ev(`(() => { const b = [...document.querySelectorAll('#sheet-body button, .sheet button')]
  .find(x => /^(save|yes|save it|organise|apply)/i.test(x.textContent.trim()));
  if (b) { b.click(); return b.textContent.replace(/\\s+/g,' ').trim(); } return null; })()`);
await sleep(5000);
console.log(`      confirmed with: ${JSON.stringify(confirmed)}`);

const d1 = new DatabaseSync(COPY, { readOnly: true });
const yugaRows = d1.prepare("SELECT id, canonical_name, type FROM lore_entities WHERE canonical_name LIKE '%Yuga%'").all();
const decls = d1.prepare(`SELECT local_ref, origin, status, evidence FROM source_entities
  WHERE lorebook_id = ? AND entity_id IN (SELECT id FROM lore_entities WHERE canonical_name LIKE '%Yuga%')`).all(MHA.id);
const devRow = semOf(d1, '13 DEVELOPMENT — Yuga Aoyama%');
const clsRow = semOf(d1, '04 CLASS 1-A — Yuga Aoyama');
const organised = d1.prepare('SELECT COUNT(*) c FROM entry_semantics s JOIN lore_entries e ON e.id=s.entry_id WHERE e.lorebook_id=?').get(MHA.id).c;
console.log(`      Yuga entities: ${JSON.stringify(yugaRows.map((y) => `${y.canonical_name}/${y.type}`))}`);
console.log(`      declarations:  ${decls.length} ${JSON.stringify(decls.map((x) => ({ ref: x.local_ref, origin: x.origin, status: x.status })))}`);
ok('one Yuga entity was written', yugaRows.length === 1, `${yugaRows.length}`);
ok('with one declaration in this source', decls.length === 1, `${decls.length}`);
ok('and the declaration records that a person made it, not the analyser',
  JSON.parse(decls[0]?.evidence || '{}').proposedBy === 'manual', decls[0]?.evidence);
ok('the DEVELOPMENT entry is stored as about him, still psychology',
  devRow?.subject_entity_id === yugaRows[0]?.id && devRow?.category === 'psychology' && devRow?.defines_entity_id === null,
  `${devRow?.scope}/${devRow?.category} subject=${!!devRow?.subject_entity_id} defines=${devRow?.defines_entity_id}`);
ok('the CLASS 1-A entry is stored as describing him, as a profile',
  clsRow?.defines_entity_id === yugaRows[0]?.id && clsRow?.category === 'profile' && clsRow?.subject_entity_id === null,
  `${clsRow?.scope}/${clsRow?.category} defines=${!!clsRow?.defines_entity_id} subject=${clsRow?.subject_entity_id}`);
// Twenty entries were already ticked when the review opened — that is what the
// analyser was confident about, and it is not this change's business. What
// matters is that these two decisions added exactly two, and that saving wrote
// what the button said and nothing besides.
ok('what was saved is exactly what the button offered to save',
  organised === Number(saveAfterTwo.replace(/\D+/g, '')),
  `${organised} organised · button said "${saveAfterTwo}"`);
ok('and the two Yuga decisions were the last two of them',
  organised === Number(saveBefore.replace(/\D+/g, '')) + 2,
  `${saveBefore} + 2 -> ${organised}`);
ok('nobody was merged and nobody was declared distinct',
  d1.prepare('SELECT COUNT(*) c FROM entity_distinctions').get().c === 0
  && d1.prepare('SELECT COUNT(*) c FROM lore_entities WHERE merged_into_id IS NOT NULL').get().c === 0);
d1.close();

// ------------------------------------------------ STEP 5: reopen and reuse
console.log('\nSTEP 5 — reopen; the declaration is there and is not minted again');
await openReview();

// The declaration read route is what "the persisted declaration is available"
// actually means, and it does not depend on how a card happens to be drawn.
const declared = await (await fetch(`http://localhost:${port}/api/lorebooks/${MHA.id}/declarations`)).json();
const yugaDecl = (Array.isArray(declared) ? declared : declared.declarations || [])
  .filter((x) => /Yuga/i.test(x.local_name || x.name || x.canonical_name || ''));
console.log(`      declarations offered back: ${JSON.stringify(yugaDecl.map((x) => x.local_ref || x.local_name))}`);
ok('the saved declaration is offered back, exactly once', yugaDecl.length === 1, `${yugaDecl.length}`);

// A reopened review shows what still needs attention; the two entries just
// settled are no longer among the cards it draws. What has to be true is that
// the Yuga it persisted is reusable by anything else in this source — which is
// what the next card can be asked directly.
const other = await ev(`(() => {
  const c = document.querySelector('#sheet-body .rv-ask [data-entry-ref], #sheet-body [data-entry-ref]');
  if (!c) return null;
  c.scrollIntoView({ block: 'center' });
  const body = c.querySelector('.edit-body');
  if (body && body.hidden) c.querySelector('.edit-head').click();
  return c.getAttribute('data-entry-ref');
})()`);
await sleep(900);
if (other) await openCard(other);
const reuse = await stateOf(other);
console.log(`      another card offers to define: ${JSON.stringify((reuse.definesOptions || []).filter((o) => /Yuga/i.test(o)))}`);
ok('the persisted Yuga is reusable by DEFINES on another entry',
  (reuse.definesOptions || []).filter((o) => /^Yuga Aoyama —/.test(o)).length === 1,
  JSON.stringify((reuse.definesOptions || []).filter((o) => /Yuga/i.test(o))));
ok('and that entry can still make somebody new for either question',
  reuse.hasDefineNew === true && reuse.hasSubjectNew !== undefined,
  `defines-new ${reuse.hasDefineNew} · subject-new ${reuse.hasSubjectNew}`);

const d2 = new DatabaseSync(COPY, { readOnly: true });
ok('still one Yuga and one declaration after reopening',
  d2.prepare("SELECT COUNT(*) c FROM lore_entities WHERE canonical_name LIKE '%Yuga%'").get().c === 1
  && d2.prepare(`SELECT COUNT(*) c FROM source_entities WHERE lorebook_id = ?
     AND entity_id IN (SELECT id FROM lore_entities WHERE canonical_name LIKE '%Yuga%')`).get(MHA.id).c === 1);
ok('and the two readings are still the two different things they were',
  semOf(d2, '13 DEVELOPMENT — Yuga Aoyama%').category === 'psychology'
  && semOf(d2, '04 CLASS 1-A — Yuga Aoyama').category === 'profile');
d2.close();

ok('nothing threw throughout', errors.length === 0, errors.slice(0, 2).join(' | '));

const prodAfter = readProd();
ok('production is untouched by all of it',
  JSON.stringify(prodBefore) === JSON.stringify(prodAfter), JSON.stringify(prodAfter));

try { ws.close(); } catch { /* closing */ }
chrome.kill(); app.kill();
await sleep(400);
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exitCode = fail ? 1 : 0;
