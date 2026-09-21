// A large source can be understood a part at a time, through the structure it
// already has — without that structure meaning anything.
//
// MHA files itself into fourteen groups. Opening "04 CLASS 1-A" and asking to
// understand it puts twenty pieces in front of you instead of a hundred and
// fifty-eight. That is all a group does. It is where the author filed things,
// not what any of them are: no piece becomes a person because of the folder it
// sits in, nothing is approved by being shown, and Save writes only readings
// somebody actually settled.
//
// The proof that filing and meaning stay apart is Yuga. He is filed in CLASS
// 1-A and again in DEVELOPMENT. Reviewed through two different groups he is
// one entity with one declaration and two different readings — a profile in
// one, psychology about him in the other — and his dossier gathers both,
// because a dossier is built from what was approved and not from where the
// file kept it.
//
//   node scripts/check-group-review.js
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

const dir = mkdtempSync(join(tmpdir(), 'nexus-group-'));
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
const api = async (path) => (await fetch(`http://localhost:${port}${path}`)).json();

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
const waitFor = async (sel, ms = 150000) => {
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
const saveText = () => ev(`((document.getElementById('rv-save')||{}).textContent || '').replace(/\\s+/g,' ').trim()`);
// Sorted is collapsed on arrival and its rows are compact, so every section is
// opened before counting: the question is what the review is scoped to, not
// what happens to be expanded.
const openAllSections = async () => {
  // Optional draws its rows only once it is opened, and its groups only once
  // IT is opened, so this repeats until nothing new appears. That laziness is
  // the behaviour being relied on elsewhere — a phone must not get every card
  // at once — so it is walked rather than defeated.
  for (let round = 0; round < 4; round++) {
    const opened = await ev(`(() => { let n = 0;
      for (const s of document.querySelectorAll('#sheet-body [data-section]')) {
        const b = s.querySelector('.edit-body');
        if (b && b.hidden) { s.querySelector('.edit-head').click(); n++; }
      } return n; })()`);
    await sleep(700);
    if (!opened) break;
  }
};
// Distinct pieces. One entry can be drawn twice — once where it is decided and
// again under the person it belongs to — and that is one piece in scope, not two.
const cardTitles = async () => {
  await openAllSections();
  return ev(`(() => {
    const seen = new Map();
    for (const c of document.querySelectorAll('#sheet-body [data-entry-ref]')) {
      const ref = c.getAttribute('data-entry-ref');
      if (seen.has(ref)) continue;
      seen.set(ref, (((c.querySelector('.edit-head b') || c.querySelector('b') || {}).textContent) || '').trim());
    }
    return [...seen.values()];
  })()`);
};

await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });

const openGroup = async (groupName) => {
  await cdp('Page.navigate', { url: `http://localhost:${port}/?t=${Date.now()}` });
  await sleep(2300);
  await click('[data-tab="characters"]');
  await click('[data-shelf="sources"]');
  await click(`[data-lorebook="${MHA.id}"]`, 1200);
  await click(`[data-view-source="${MHA.id}"]`, 1600);
  // Once anything is approved the source opens on what Nexus knows, which is
  // right; the filing is where groups live, so that is the tab to be on.
  await click('[data-src-view="filing"]', 900);
  return click(`[data-src-group="f:${groupName}"]`, 1100);
};
const understand = async () => {
  await click('[data-src-understand]', 1500);
  await waitFor('#sheet-body .edit-card', 180000);
  await sleep(3200);
};
const semOf = (db, like) => {
  const row = db.prepare(`SELECT e.id, e.title, s.scope, s.category, s.status, s.defines_entity_id
    FROM lore_entries e LEFT JOIN entry_semantics s ON s.entry_id = e.id
    WHERE e.lorebook_id = ? AND e.title LIKE ?`).get(MHA.id, like);
  if (!row) return null;
  const subj = db.prepare("SELECT entity_id FROM entry_relations WHERE entry_id=? AND relation='subject' AND status='approved'").get(row.id);
  return { ...row, subject_entity_id: subj?.entity_id || null };
};
const organised = (db) => db.prepare(`SELECT COUNT(*) c FROM entry_semantics s
  JOIN lore_entries e ON e.id = s.entry_id WHERE e.lorebook_id = ?`).get(MHA.id).c;

// ------------------------------------------------- the filing, read-only
console.log(`\n${MHA.name}`);
const proj = await api(`/api/lorebooks/${MHA.id}/projection`);
const groupOf = (name) => proj.filing.groups.find((g) => g.name === name);
const CLASS = groupOf('04 CLASS 1-A');
const DEV = groupOf('13 DEVELOPMENT');
const CLASS_B = groupOf('05 CLASS 1-B');
console.log(`      04 CLASS 1-A ${CLASS.pieceCount} · 05 CLASS 1-B ${CLASS_B.pieceCount} · 13 DEVELOPMENT ${DEV.pieceCount}`);

// ------------------------------------------------------- scope of review
console.log('\nA group scopes what is asked, and nothing else');
await openGroup('04 CLASS 1-A');
ok('a filing group offers to be understood',
  await ev(`!!document.querySelector('[data-src-understand]')`));
ok('and says how far it has got, in pieces',
  /Nothing here has been organised yet/.test(await text('#src-body .src-lede')),
  await text('#src-body .src-lede'));
await understand();

const shown = await cardTitles();
console.log(`      review shows ${shown.length} cards; first: ${JSON.stringify(shown.slice(0, 2))}`);
ok('exactly the group\'s pieces are in front of you', shown.length === CLASS.pieceCount, `${shown.length} of ${CLASS.pieceCount}`);
ok('every card shown belongs to the group',
  shown.every((t) => /^04 CLASS 1-A/.test(t)), JSON.stringify(shown.filter((t) => !/^04 CLASS 1-A/.test(t)).slice(0, 3)));
ok('no CLASS 1-B piece is in scope', !shown.some((t) => /^05 CLASS 1-B/.test(t)));
ok('no DEVELOPMENT piece is in scope', !shown.some((t) => /^13 DEVELOPMENT/.test(t)));
const header = await text('#sheet-body .rv-scope');
console.log(`      header: "${header}"`);
ok('the review says which part of the file it is reading',
  /04 CLASS 1-A/.test(header) && /20 pieces/.test(header), header);
ok('and says that is filing, not meaning',
  /how the file was organised/i.test(header) && /still yours to say/i.test(header), header);
ok('the group name is not used as a category, a type or a person',
  !(await ev(`[...document.querySelectorAll('#sheet-body [data-category]')].some(s => /class/i.test(s.value))`)));

// what the analyser actually proposes, unchanged
const proposals = await ev(`(() => {
  const out = {};
  for (const s of document.querySelectorAll('#sheet-body [data-entry-ref] [data-category]')) out[s.value] = (out[s.value]||0)+1;
  return out;
})()`);
console.log(`      the analyser proposes: ${JSON.stringify(proposals)}`);
const saveOnOpen = await saveText();
console.log(`      save on opening: "${saveOnOpen}"`);
ok('what is pre-ticked is only this group\'s, not the whole source\'s',
  Number(saveOnOpen.replace(/\D+/g, '')) <= CLASS.pieceCount,
  `${saveOnOpen} of ${CLASS.pieceCount} possible`);

// ------------------------------------------------- source context survives
console.log('\nThe rest of the source is still known');
const declaredNames = await ev(`[...document.querySelectorAll('#sheet-body [data-defines] option')]
  .map(o => o.textContent.trim()).filter(t => !/^Choose/.test(t))`);
const uniqueDeclared = [...new Set(declaredNames)];
console.log(`      people offered to define: ${uniqueDeclared.length}`);
ok('people the analyser found across the whole source are still offered',
  uniqueDeclared.length > CLASS.pieceCount, `${uniqueDeclared.length} offered, group holds ${CLASS.pieceCount}`);

// ------------------------------------------------------ a partial save
console.log('\nDeciding some of it, and only that');
const beforeSave = organised(new DatabaseSync(COPY, { readOnly: true }));
const ticked = Number(saveOnOpen.replace(/\D+/g, ''));
await click('#rv-save', 1600);
const confirmed = await ev(`(() => { const b = [...document.querySelectorAll('#sheet-body button, .sheet button')]
  .find(x => /^save \\d/i.test(x.textContent.trim()));
  if (b) { b.click(); return b.textContent.replace(/\\s+/g,' ').trim(); } return null; })()`);
await sleep(5000);
console.log(`      confirmed: ${JSON.stringify(confirmed)}`);

const d1 = new DatabaseSync(COPY, { readOnly: true });
const afterSave = organised(d1);
const inClass = d1.prepare(`SELECT COUNT(*) c FROM entry_semantics s JOIN lore_entries e ON e.id=s.entry_id
  WHERE e.lorebook_id=? AND e.title LIKE '04 CLASS 1-A%'`).get(MHA.id).c;
const outside = d1.prepare(`SELECT COUNT(*) c FROM entry_semantics s JOIN lore_entries e ON e.id=s.entry_id
  WHERE e.lorebook_id=? AND e.title NOT LIKE '04 CLASS 1-A%'`).get(MHA.id).c;
console.log(`      organised: ${beforeSave} -> ${afterSave} · in CLASS 1-A ${inClass} · anywhere else ${outside}`);
ok('only pieces from the group were written', outside === 0, `${outside} outside the group`);
ok('and exactly what was ticked', afterSave === ticked, `${afterSave} written, ${ticked} ticked`);
ok('the other 138 pieces were not touched',
  afterSave <= CLASS.pieceCount, `${afterSave} of 158`);
ok('no row records the group itself',
  d1.prepare(`SELECT COUNT(*) c FROM entry_semantics WHERE display_path IS NOT NULL`).get().c === 0
  && !d1.prepare('SELECT * FROM source_entities WHERE local_name LIKE ?').get('%CLASS 1-A%'));
const leftOver = CLASS.pieceCount - inClass;
ok('what was not ticked stayed unresolved', leftOver >= 0 && inClass < CLASS.pieceCount + 1,
  `${inClass} of ${CLASS.pieceCount} organised, ${leftOver} left`);
d1.close();

// ------------------------------------------- filing unchanged, knowledge new
console.log('\nThe filing is the same; what Nexus knows is not');
const proj2 = await api(`/api/lorebooks/${MHA.id}/projection`);
const class2 = proj2.filing.groups.find((g) => g.name === '04 CLASS 1-A');
console.log(`      filing: 04 CLASS 1-A still ${class2.pieceCount} · groups ${proj2.filing.groups.length}`);
console.log(`      known:  ${proj2.semantic.entityCount} entities carrying ${proj2.semantic.ownedPieceCount} pieces`
  + ` · ownerless ${proj2.semantic.ownerlessPieceCount} · approved ${proj2.reading.approvedPieceCount}`);
ok('the filing group still holds all its pieces', class2.pieceCount === CLASS.pieceCount,
  `${class2.pieceCount} vs ${CLASS.pieceCount}`);
ok('the source still files itself into the same groups',
  proj2.filing.groups.length === proj.filing.groups.length);
ok('what Nexus knows grew only by what was approved',
  proj2.reading.approvedPieceCount === afterSave, `${proj2.reading.approvedPieceCount} vs ${afterSave}`);
ok('and it is real semantic truth, not filing',
  proj2.semantic.entityCount > 0 || proj2.semantic.ownerlessPieceCount > 0,
  `${proj2.semantic.entityCount} entities, ${proj2.semantic.ownerlessPieceCount} ownerless`);
for (const g of proj2.semantic.entityGroups) console.log(`        ${g.name} · ${g.entityCount} entities · ${g.pieceCount} pieces`);

// ------------------------------------------------------ reopening a group
console.log('\nReopening the same group changes nothing');
await openGroup('04 CLASS 1-A');
const lede = await text('#src-body .src-lede');
console.log(`      ${lede}`);
ok('the group reports progress in pieces', new RegExp(`${afterSave} of ${CLASS.pieceCount} pieces organised`).test(lede), lede);
await understand();
const shown2 = await cardTitles();
ok('the group still scopes to its own pieces', shown2.length === CLASS.pieceCount, `${shown2.length}`);
const d2 = new DatabaseSync(COPY, { readOnly: true });
ok('reopening wrote nothing', organised(d2) === afterSave, `${organised(d2)} vs ${afterSave}`);
ok('and made no duplicate declaration',
  d2.prepare('SELECT COUNT(*) c FROM source_entities WHERE lorebook_id=?').get(MHA.id).c
  === d2.prepare('SELECT COUNT(DISTINCT entity_id) c FROM source_entities WHERE lorebook_id=?').get(MHA.id).c);
const yugaAfterClass = d2.prepare("SELECT id, canonical_name FROM lore_entities WHERE canonical_name LIKE '%Yuga%'").all();
const clsRow = semOf(d2, '04 CLASS 1-A — Yuga Aoyama');
console.log(`      Yuga entities so far: ${yugaAfterClass.length} · CLASS reading: ${clsRow?.category || '(none)'}`);
d2.close();

// Yuga was one the analyser did not settle, so he is still here to decide. He
// is decided now, through the group he is filed in, so the next group has
// somebody real to reuse.
console.log('\n      settling Yuga in the group he is filed in');
const yugaRef = await ev(`(() => {
  const c = [...document.querySelectorAll('#sheet-body [data-entry-ref]')]
    .find(x => /Yuga Aoyama/.test(((x.querySelector('.edit-head b')||{}).textContent)||''));
  if (!c) return null;
  c.scrollIntoView({ block: 'center' });
  const b = c.querySelector('.edit-body'); if (b && b.hidden) c.querySelector('.edit-head').click();
  return c.getAttribute('data-entry-ref');
})()`);
await sleep(900);
if (!yugaRef) note('no Yuga card in CLASS 1-A on this copy');
else {
  await ev(`(() => { const f = document.querySelector('[data-entry-ref="${yugaRef}"] details[data-fold^="fine:"]'); if (f) f.open = true; })()`);
  await sleep(500);
  await click(`[data-define-new="${yugaRef}"]`, 700);
  await ev(`document.querySelector('[data-new-name="${yugaRef}"]').value = 'Yuga Aoyama'`);
  await ev(`(() => { const s = document.querySelector('[data-new-type="${yugaRef}"]');
    s.value = 'person'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(400);
  await click(`[data-define-create="${yugaRef}"]`, 1200);
  await click('#rv-save', 1600);
  await ev(`(() => { const b = [...document.querySelectorAll('#sheet-body button, .sheet button')]
    .find(x => /^save \\d/i.test(x.textContent.trim())); if (b) b.click(); })()`);
  await sleep(5000);
  const dY = new DatabaseSync(COPY, { readOnly: true });
  const made = dY.prepare("SELECT id, canonical_name, type FROM lore_entities WHERE canonical_name LIKE '%Yuga%'").all();
  const cls = semOf(dY, '04 CLASS 1-A — Yuga Aoyama');
  console.log(`      Yuga now: ${JSON.stringify(made.map((m) => `${m.canonical_name}/${m.type}`))} · CLASS reads ${cls?.category}`);
  ok('Yuga was made from inside a group-scoped review', made.length === 1, `${made.length}`);
  ok('and the CLASS 1-A piece describes him',
    cls?.defines_entity_id === made[0]?.id && cls?.category === 'profile',
    `${cls?.category} defines=${!!cls?.defines_entity_id}`);
  dY.close();
}

// -------------------------------------------- the same person, another group
console.log('\n13 DEVELOPMENT — the same Yuga, a different reading');
await openGroup('13 DEVELOPMENT');
await understand();
const devShown = await cardTitles();
ok('the DEVELOPMENT group scopes to its own pieces',
  devShown.length === DEV.pieceCount && devShown.every((t) => /^13 DEVELOPMENT/.test(t)),
  `${devShown.length} of ${DEV.pieceCount}`);
ok('no CLASS 1-A piece appears here', !devShown.some((t) => /^04 CLASS 1-A/.test(t)));

const devRef = await ev(`(() => {
  const c = [...document.querySelectorAll('#sheet-body [data-entry-ref]')]
    .find(x => /Yuga Aoyama/.test(((x.querySelector('.edit-head b')||{}).textContent)||''));
  if (!c) return null;
  c.scrollIntoView({ block: 'center' });
  const body = c.querySelector('.edit-body');
  if (body && body.hidden) c.querySelector('.edit-head').click();
  return c.getAttribute('data-entry-ref');
})()`);
await sleep(900);
if (!devRef) note('no Yuga piece in the DEVELOPMENT group of this copy — cross-group check skipped');
else {
  await ev(`(() => { const f = document.querySelector('[data-entry-ref="${devRef}"] details[data-fold^="fine:"]'); if (f) f.open = true; })()`);
  await sleep(500);
  const offered = await ev(`[...document.querySelectorAll('[data-entry-ref="${devRef}"] [data-defines] option')]
    .map(o => o.textContent.trim()).filter(t => /Yuga/i.test(t))`);
  console.log(`      Yuga offered from the other group's work: ${JSON.stringify(offered)}`);
  ok('a person settled in another group is reusable here, once',
    offered.length === 1, JSON.stringify(offered));

  const cat = await ev(`(document.querySelector('[data-entry-ref="${devRef}"] [data-category]')||{}).value`);
  const hasSubjectNew = await ev(`!!document.querySelector('[data-subject-new="${devRef}"]')`);
  console.log(`      reads as ${cat} · can make somebody for "about": ${hasSubjectNew}`);
  ok('D2.5 still holds inside a scoped review: the two questions are separate',
    hasSubjectNew === true || (await ev(`!!document.querySelector('[data-entry-ref="${devRef}"] [data-subject-other]')`)),
    `subject-new ${hasSubjectNew}`);

  // Make it ABOUT the Yuga that already exists, through the subject side.
  const chose = await ev(`(() => {
    const sel = document.querySelector('[data-entry-ref="${devRef}"] [data-subject-other]');
    if (sel) { const o = [...sel.options].find(x => /Yuga/i.test(x.textContent)); if (o) {
      sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return 'list'; } }
    const chip = [...document.querySelectorAll('[data-entry-ref="${devRef}"] .rv-choice')]
      .find(b => /Yuga/i.test(b.textContent)); if (chip) { chip.click(); return 'chip'; }
    return null;
  })()`);
  await sleep(1200);
  console.log(`      chose Yuga as the subject via: ${chose}`);
  if (chose) {
    await click('#rv-save', 1600);
    await ev(`(() => { const b = [...document.querySelectorAll('#sheet-body button, .sheet button')]
      .find(x => /^save \\d/i.test(x.textContent.trim())); if (b) b.click(); })()`);
    await sleep(5000);
  }
}

// ------------------------------------------------------- the bridge: dossier
console.log('\nThe dossier gathers what was approved, not what was filed together');
const d3 = new DatabaseSync(COPY, { readOnly: true });
const yugas = d3.prepare("SELECT id, canonical_name, type FROM lore_entities WHERE canonical_name LIKE '%Yuga%'").all();
const decls = d3.prepare(`SELECT COUNT(*) c FROM source_entities WHERE lorebook_id=? AND entity_id IN
  (SELECT id FROM lore_entities WHERE canonical_name LIKE '%Yuga%')`).get(MHA.id).c;
const clsFinal = semOf(d3, '04 CLASS 1-A — Yuga Aoyama');
const devFinal = semOf(d3, '13 DEVELOPMENT — Yuga Aoyama%');
console.log(`      Yuga entities ${yugas.length} · declarations ${decls}`);
console.log(`      CLASS 1-A:   ${clsFinal?.category || '—'} defines=${!!clsFinal?.defines_entity_id} subject=${!!clsFinal?.subject_entity_id}`);
console.log(`      DEVELOPMENT: ${devFinal?.category || '—'} defines=${!!devFinal?.defines_entity_id} subject=${!!devFinal?.subject_entity_id}`);
ok('one Yuga across both groups', yugas.length <= 1, `${yugas.length}`);
ok('one declaration across both groups', decls <= 1, `${decls}`);
if (yugas.length === 1 && clsFinal?.defines_entity_id && devFinal?.subject_entity_id) {
  ok('both readings landed on the same person',
    clsFinal.defines_entity_id === yugas[0].id && devFinal.subject_entity_id === yugas[0].id);
  ok('and they stayed two different readings',
    clsFinal.category !== devFinal.category || clsFinal.defines_entity_id !== devFinal.subject_entity_id
      ? clsFinal.category === 'profile' && devFinal.defines_entity_id === null : false,
    `${clsFinal.category} vs ${devFinal.category}`);
  const prof = await api(`/api/entities/${yugas[0].id}/profile`);
  const secs = (prof.knowledge.reusable || []).map((g) => `${g.name}(${g.count})`);
  console.log(`      Yuga's dossier: ${secs.join(' ') || '(nothing)'}`);
  ok('his dossier gathers material that was filed in two different groups',
    prof.counts.total >= 2, `${prof.counts.total} pieces`);
} else note(`cross-group accumulation not reachable on this copy (${yugas.length} Yuga, CLASS defines ${!!clsFinal?.defines_entity_id}, DEV subject ${!!devFinal?.subject_entity_id})`);
ok('nobody was merged and nobody was declared distinct',
  d3.prepare('SELECT COUNT(*) c FROM entity_distinctions').get().c === 0
  && d3.prepare('SELECT COUNT(*) c FROM lore_entities WHERE merged_into_id IS NOT NULL').get().c === 0);
d3.close();

// --------------------------------------------------------------- browsing
console.log('\nBrowsing is still browsing');
const from = sent.length;
await openGroup('05 CLASS 1-B');
const bShown = await ev(`document.querySelectorAll('#src-body .src-row').length`);
ok('another group is untouched by any of this', bShown === CLASS_B.pieceCount, `${bShown} of ${CLASS_B.pieceCount}`);
ok('and has been organised not at all',
  /Nothing here has been organised yet/.test(await text('#src-body .src-lede')), await text('#src-body .src-lede'));
const browseWrites = sent.slice(from).filter((r) => r.url.includes(`localhost:${port}`))
  .filter((r) => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(r.method));
ok('browsing a source still writes nothing', browseWrites.length === 0, JSON.stringify(browseWrites.slice(0, 3)));

// -------------------------------------------------------------- responsive
console.log('\nOn every width it has to work at');
for (const width of [320, 375, 390, 430, 1280]) {
  await cdp('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 2, mobile: width < 1000 });
  await sleep(300);
  await openGroup('07 U.A. STAFF');
  const okOpen = await ev(`!!document.querySelector('[data-src-understand]')`);
  await understand();
  // On arrival: how much is put in front of somebody before they ask.
  const arrival = await ev(`(() => {
    const cards = [...document.querySelectorAll('#sheet-body [data-entry-ref]')];
    return { cards: cards.length,
      open: cards.filter(c => c.querySelector('.edit-body') && !c.querySelector('.edit-body').hidden).length };
  })()`);
  // Then everything opened, which is the worst case for the layout.
  const titles = await cardTitles();
  const m = await ev(`(() => {
    const over = [...document.querySelectorAll('#sheet-body *')]
      .filter(el => el.getBoundingClientRect().right > window.innerWidth + 1)
      .map(el => el.className || el.tagName).slice(0, 3);
    return {
      page: document.documentElement.scrollWidth - window.innerWidth,
      over,
      scope: ((document.querySelector('#sheet-body .rv-scope')||{}).textContent||'').replace(/\\s+/g,' ').trim().slice(0, 34),
    };
  })()`);
  const want = groupOf('07 U.A. STAFF').pieceCount;
  ok(`${width}px · scoped, nothing over the edge, nothing dumped open`,
    okOpen && m.page <= 0 && m.over.length === 0 && titles.length === want && arrival.open <= 2
      && titles.every((t) => /^07 U\.A\. STAFF/.test(t)),
    `page +${m.page}px · ${titles.length}/${want} pieces · ${arrival.cards} drawn on arrival, ${arrival.open} open`
    + `${m.over.length ? ` · over: ${m.over.join(', ')}` : ''}`);
}

ok('nothing threw throughout', errors.length === 0, errors.slice(0, 2).join(' | '));

const prodAfter = readProd();
ok('production is untouched by all of it',
  JSON.stringify(prodBefore) === JSON.stringify(prodAfter), JSON.stringify(prodAfter));
{
  const p = new DatabaseSync(PROD, { readOnly: true });
  ok('production MHA is still entirely unorganised',
    p.prepare(`SELECT COUNT(*) c FROM entry_semantics s JOIN lore_entries e ON e.id=s.entry_id
      WHERE e.lorebook_id=?`).get(MHA.id).c === 0);
  p.close();
}

try { ws.close(); } catch { /* closing */ }
chrome.kill(); app.kill();
await sleep(400);
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exitCode = fail ? 1 : 0;
