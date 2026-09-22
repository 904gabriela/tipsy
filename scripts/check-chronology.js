// When a piece is true is a different fact from what it means.
//
// Timeline V1 places a piece in time by pointing at it. The piece keeps every
// word and every semantic reading; a row says "true from this position
// onward" in a named, ordered continuity. Nothing here reads the words to
// guess when they are true, and nothing here is read by retrieval: the
// compiled prompt before and after placing pieces is byte for byte the same,
// and so is a Package v1 export.
//
// The proof is Bakugo, on a throwaway copy of the real library. His Class 1-A
// profile and his progressive state map are two pieces from two filing
// groups, owned by one person, read as profile and psychology. Placed from
// DAY_1 and from POST_BATTLE_TRIAL they carry different applicability and are
// still one piece each, and his dossier is exactly what it was.
//
//   node scripts/check-chronology.js
//
// A VACUUM copy. Production is read with a read-only handle and NEVER opened
// with Nexus's own open(), because open() applies the schema and would create
// three empty tables there.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { open } from '../src/db/index.js';
import { createEntity, declareInSource, setEntrySemantics, setRelation } from '../src/semantics/store.js';
import { entityProfile } from '../src/semantics/profile.js';
import { sourceProjection } from '../src/semantics/source-projection.js';
import { exportSources } from '../src/package/export.js';
import { canonicalPackage } from '../src/package/format.js';
import {
  createContinuity, addPosition, placeEntry, unplaceEntry,
  chronologyView, sourceChronology, entityChronology, ChronologyError,
} from '../src/chronology/store.js';

const WT = process.cwd();
const PROD = join(WT, 'data', 'tipsy.db');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Bytes are hashed as bytes. Coercing a Buffer to a string first would hash a
// mangled decoding of the database, and report a stable but wrong SHA.
const sha = (s) => createHash('sha256').update(Buffer.isBuffer(s) ? s : String(s)).digest('hex');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
};
const note = (s) => console.log(`  NOTE  ${s}`);
const throwsChronology = (fn) => { try { fn(); return false; } catch (e) { return e instanceof ChronologyError; } };

if (!existsSync(PROD)) { note('no data/tipsy.db here — skipped'); process.exit(0); }

// ------------------------------------------------------- production, named
const MHA_ID = '0mu3i0q0sc50c6b7ecf23';
const namedCounts = () => {
  const d = new DatabaseSync(PROD, { readOnly: true });
  const q = (s, ...a) => d.prepare(s).get(...a).c;
  const has = (t) => !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const n = {};
  for (const t of ['lore_entries', 'lore_entities', 'source_entities', 'entry_semantics', 'entry_relations', 'source_semantics', 'entity_distinctions']) n[t] = q(`SELECT COUNT(*) c FROM ${t}`);
  for (const t of ['continuities', 'continuity_positions', 'entry_placements']) n[t] = has(t) ? q(`SELECT COUNT(*) c FROM ${t}`) : 'absent';
  n.MHA_entry_semantics = q('SELECT COUNT(*) c FROM entry_semantics s JOIN lore_entries e ON e.id=s.entry_id WHERE e.lorebook_id=?', MHA_ID);
  n.MHA_source_semantics = q('SELECT COUNT(*) c FROM source_semantics WHERE lorebook_id=?', MHA_ID);
  n.MHA_temporal_rows = has('entry_placements') ? q('SELECT COUNT(*) c FROM entry_placements pl JOIN lore_entries e ON e.id=pl.entry_id WHERE e.lorebook_id=?', MHA_ID) : 0;
  d.close();
  return n;
};
const prodSha = () => sha(readFileSync(PROD));
const prodBefore = namedCounts();
const shaBefore = prodSha();

const dir = mkdtempSync(join(tmpdir(), 'nexus-chrono-'));
const COPY = join(dir, 'copy.db').replace(/\\/g, '/');
{
  const src = new DatabaseSync(PROD, { readOnly: true }); src.exec(`VACUUM INTO '${COPY}'`); src.close();
  const c = new DatabaseSync(COPY); c.prepare("DELETE FROM settings WHERE key='auth'").run(); c.close();
}

// The prompt boundary is read through the running app, exactly as a story
// would be compiled, on the copy. Started now so "before" is before anything.
const port = 9900 + Math.floor(Math.random() * 90);
const app = spawn(process.execPath, ['server.js'], { cwd: WT, env: { ...process.env, PORT: String(port), DB_PATH: COPY }, stdio: 'ignore' });
for (let i = 0; i < 200; i++) { try { await fetch(`http://localhost:${port}/`); break; } catch { await sleep(200); } }
const api = async (p, init) => { const r = await fetch(`http://localhost:${port}${p}`, init); return { status: r.status, body: await r.json().catch(() => null) }; };
const STORY = '0mtxl6z6hd29a83d52b5a'; // Patrick 'The Saint' Moretti — 255 messages, The Saint attached
const stableOf = async () => (await api(`/api/stories/${STORY}/prompt`)).body?.messages?.find((m) => m.role === 'system' && !m.volatile)?.content || '';
const promptBefore = sha(await stableOf());

const db = open(COPY);
const SAINT = db.raw.prepare("SELECT id FROM lorebooks WHERE name LIKE '%Saint%'").get().id;
const entryByTitle = (like) => db.raw.prepare('SELECT id, title, content FROM lore_entries WHERE lorebook_id=? AND title LIKE ?').get(MHA_ID, like);
const semanticRows = (bookId) => JSON.stringify({
  sem: db.raw.prepare('SELECT s.* FROM entry_semantics s JOIN lore_entries e ON e.id=s.entry_id WHERE e.lorebook_id=? ORDER BY s.entry_id').all(bookId),
  rel: db.raw.prepare('SELECT r.* FROM entry_relations r JOIN lore_entries e ON e.id=r.entry_id WHERE e.lorebook_id=? ORDER BY r.entry_id, r.entity_id').all(bookId),
  dec: db.raw.prepare('SELECT * FROM source_entities WHERE lorebook_id=? ORDER BY entity_id').all(bookId),
  entries: db.raw.prepare('SELECT id, title, content, keys, display_index FROM lore_entries WHERE lorebook_id=? ORDER BY display_index').all(bookId),
});
const packageOf = (bookId) => sha(JSON.stringify(canonicalPackage(exportSources(db, [bookId]).package)));

// -------------------------------------------------- the pieces, by content
console.log('\nThe pieces, chosen for what their words say');
const day1 = entryByTitle('02 ACTIVE STATE — DAY 1%');
const usj = entryByTitle('11 TIMELINE — POST_USJ%');
const bakugoProfile = entryByTitle('04 CLASS 1-A — Katsuki Bakugo');
const bakugoMap = entryByTitle('13 DEVELOPMENT — Katsuki Bakugo%');
const midoriyaProfile = entryByTitle('04 CLASS 1-A — Izuku Midoriya');
ok('the real pieces are all here', !!(day1 && usj && bakugoProfile && bakugoMap && midoriyaProfile));
ok('the DAY 1 baseline says it is the first morning', /TIME: First morning/.test(day1.content));
ok('the POST_USJ state names what came before it', /PRECONDITION: POST_BATTLE_TRIAL/.test(usj.content));
ok('the profile carries a Day 1 state and says later development belongs elsewhere',
  /DAY 1 STATE:/.test(bakugoProfile.content) && /Later development belongs to timeline overlays/.test(bakugoProfile.content));
ok('the state map\'s first development is the Battle Trial',
  /^DAY 1:[\s\S]*?\nBATTLE TRIAL:/.test(bakugoMap.content));

// ------------------------------------- semantics first, by hand, on the copy
console.log('\nSemantics, approved by hand, before any chronology exists');
const bakugo = createEntity(db, { type: 'person', name: 'Katsuki Bakugo', aliases: ['Bakugo', 'Kacchan'] });
const midoriya = createEntity(db, { type: 'person', name: 'Izuku Midoriya', aliases: ['Midoriya', 'Deku'] });
for (const [id, ref] of [[bakugo, 'katsuki-bakugo'], [midoriya, 'izuku-midoriya']]) {
  declareInSource(db, { lorebookId: MHA_ID, entityId: id, localRef: ref, origin: 'manual', status: 'approved', evidence: { proposedBy: 'manual' } });
}
const manual = { origin: 'manual', status: 'approved', evidence: { proposedBy: 'manual', decidedIn: 'check' } };
setEntrySemantics(db, { entryId: bakugoProfile.id, scope: 'entity', category: 'profile', definesEntityId: bakugo, ...manual });
setEntrySemantics(db, { entryId: bakugoMap.id, scope: 'entity', category: 'psychology', ...manual });
setRelation(db, { entryId: bakugoMap.id, entityId: bakugo, relation: 'subject', ...manual });
setEntrySemantics(db, { entryId: midoriyaProfile.id, scope: 'entity', category: 'profile', definesEntityId: midoriya, ...manual });
setEntrySemantics(db, { entryId: day1.id, scope: 'world', category: 'background', ...manual });
setEntrySemantics(db, { entryId: usj.id, scope: 'world', category: 'event', ...manual });

const semanticsBefore = semanticRows(MHA_ID);
const saintBefore = semanticRows(SAINT);
const filingBefore = JSON.stringify(sourceProjection(db, MHA_ID).filing);
const dossierBefore = JSON.stringify(entityProfile(db, bakugo));
const packageBefore = packageOf(SAINT);
const entriesBefore = db.raw.prepare('SELECT COUNT(*) c FROM lore_entries').get().c;
const sections = (p) => p.knowledge.reusable.map((g) => `${g.name}(${g.count})`).join(' ');
console.log(`      Bakugo's dossier: ${sections(entityProfile(db, bakugo))}`);
ok('Bakugo owns two pieces from two filing groups',
  sections(entityProfile(db, bakugo)) === 'Profile(1) Psychology(1)');
ok('before any chronology exists, nothing is placed and nothing is asked to be',
  (() => { const c = sourceChronology(db, MHA_ID); return c.placedPieceCount === 0 && c.approvedPieceCount === 5 && c.approvedUnplacedPieceCount === 5; })());
ok('the read model reports no continuities at all, in its own units',
  (() => { const v = chronologyView(db); return v.continuityCount === 0 && v.continuities.length === 0; })());

// ------------------------------------------------------------ the continuity
console.log('\nA continuity, its positions in an explicit order, by hand');
const mha = createContinuity(db, { name: 'My Hero Academia canon', description: 'The canon continuity the MHA source is written against.', origin: 'manual', status: 'approved', evidence: { proposedBy: 'manual' } });
const pos = {};
// Ordinals are given, not derived. The tokens are the source's own handles.
for (const [ordinal, token, label] of [[0, 'DAY_1', 'Day 1, before the Quirk Apprehension Test'], [1, 'POST_QUIRK_TEST', 'After the Quirk Apprehension Test'], [2, 'POST_BATTLE_TRIAL', 'After the Battle Trial'], [3, 'POST_USJ', 'After U.S.J.']]) {
  pos[token] = addPosition(db, { continuityId: mha, ordinal, token, label, origin: 'manual', status: 'approved', evidence: { proposedBy: 'manual' } });
}
ok('a position cannot share an ordinal', throwsChronology(() => addPosition(db, { continuityId: mha, ordinal: 2, token: 'DUPLICATE', origin: 'manual', status: 'approved' })));
ok('nor a token', throwsChronology(() => addPosition(db, { continuityId: mha, ordinal: 9, token: 'POST_USJ', origin: 'manual', status: 'approved' })));
ok('a continuity needs a name', throwsChronology(() => createContinuity(db, { name: '  ', origin: 'manual', status: 'approved' })));
ok('a position needs a whole-number ordinal', throwsChronology(() => addPosition(db, { continuityId: mha, ordinal: 1.5, token: 'X', origin: 'manual', status: 'approved' })));
const view1 = chronologyView(db);
console.log(`      ${view1.continuities[0].name}: ${view1.continuities[0].positionCount} positions · ${view1.continuities[0].positions.map((p) => `${p.ordinal}:${p.token}`).join(' ')}`);
ok('one continuity, four positions, zero placed pieces — three numbers, three units',
  view1.continuityCount === 1 && view1.continuities[0].positionCount === 4 && view1.continuities[0].placedPieceCount === 0);
ok('positions read in ordinal order, not name order',
  view1.continuities[0].positions.map((p) => p.token).join(',') === 'DAY_1,POST_QUIRK_TEST,POST_BATTLE_TRIAL,POST_USJ');

// ------------------------------------------------------------- placements
console.log('\nPlacing four pieces, and not the fifth');
// The placer's judgment, said plainly: the state map's own first development
// section is the Battle Trial, and the source's continuity rule says
// development is overlay material, not Day 1. The profile IS the Day 1 state.
placeEntry(db, { entryId: day1.id, fromPositionId: pos.DAY_1, ...manual });
placeEntry(db, { entryId: bakugoProfile.id, fromPositionId: pos.DAY_1, ...manual });
placeEntry(db, { entryId: bakugoMap.id, fromPositionId: pos.POST_BATTLE_TRIAL, ...manual });
placeEntry(db, { entryId: usj.id, fromPositionId: pos.POST_USJ, ...manual });

ok('one piece is still one piece', db.raw.prepare('SELECT COUNT(*) c FROM lore_entries').get().c === entriesBefore
  && db.raw.prepare('SELECT COUNT(*) c FROM entry_placements').get().c === 4, `${entriesBefore} entries, 4 placements`);
ok('filing is unchanged', JSON.stringify(sourceProjection(db, MHA_ID).filing) === filingBefore);
ok('every semantic row is byte for byte what it was', semanticRows(MHA_ID) === semanticsBefore);
ok('The Saint is untouched', semanticRows(SAINT) === saintBefore);
ok('Bakugo\'s dossier is exactly what it was', JSON.stringify(entityProfile(db, bakugo)) === dossierBefore, sections(entityProfile(db, bakugo)));

const ec = entityChronology(db, bakugo);
console.log(`      Bakugo in time: ${ec.knowledge.map((k) => `${k.category}@${k.placements[0]?.from.token || 'unplaced'}`).join(' · ')}`);
ok('the same person carries two pieces at two different positions',
  ec.ownedPieceCount === 2 && ec.placedPieceCount === 2
  && ec.knowledge.map((k) => k.placements[0].from.ordinal).join(',') === '0,2');
ok('and they are still profile and psychology',
  ec.knowledge.map((k) => k.category).join(',') === 'profile,psychology');
ok('read in order of when they become true, earliest first',
  ec.knowledge[0].placements[0].from.token === 'DAY_1' && ec.knowledge[1].placements[0].from.token === 'POST_BATTLE_TRIAL');

const sc = sourceChronology(db, MHA_ID);
console.log(`      MHA: ${sc.approvedPieceCount} approved · ${sc.placedPieceCount} placed · ${sc.approvedUnplacedPieceCount} approved but unplaced`);
ok('an unplaced approved piece is still a valid piece, and is counted as unplaced',
  sc.approvedUnplacedPieceCount === 1 && sc.pieces.find((p) => p.pieceId === midoriyaProfile.id).semanticallyApproved
  && entityProfile(db, midoriya).counts.total === 1);
ok('placement is per continuity, once: placing again moves it rather than doubling it',
  (() => { placeEntry(db, { entryId: usj.id, fromPositionId: pos.POST_BATTLE_TRIAL, ...manual });
    const n = db.raw.prepare('SELECT COUNT(*) c FROM entry_placements WHERE entry_id=?').get(usj.id).c;
    placeEntry(db, { entryId: usj.id, fromPositionId: pos.POST_USJ, ...manual });
    return n === 1; })());
ok('unplacing removes the row and only the row',
  (() => { const removed = unplaceEntry(db, { entryId: usj.id, continuityId: mha });
    const still = !!db.raw.prepare('SELECT 1 FROM entry_semantics WHERE entry_id=?').get(usj.id);
    placeEntry(db, { entryId: usj.id, fromPositionId: pos.POST_USJ, ...manual });
    return removed === 1 && still; })());

// ------------------------------------------------------- provenance, stale
console.log('\nProposed is not approved, and a changed piece is not trusted');
ok('an inference cannot be approved as it stands',
  throwsChronology(() => placeEntry(db, { entryId: midoriyaProfile.id, fromPositionId: pos.DAY_1, origin: 'inferred', status: 'approved' })));
placeEntry(db, { entryId: midoriyaProfile.id, fromPositionId: pos.DAY_1, origin: 'inferred', status: 'proposed', confidence: 'medium', evidence: { proposedBy: 'check' } });
const proposed = entityChronology(db, midoriya).knowledge[0].placements[0];
ok('a proposed placement is reported as proposed, with no hash to stand on',
  proposed.state === 'proposed' && proposed.status === 'proposed'
  && db.raw.prepare('SELECT content_hash FROM entry_placements WHERE entry_id=?').get(midoriyaProfile.id).content_hash === null);
ok('and a source counts it as placed while the continuity counts it as proposed',
  chronologyView(db).continuities[0].proposedPlacementCount === 1 && chronologyView(db).continuities[0].approvedPlacementCount === 4);
unplaceEntry(db, { entryId: midoriyaProfile.id, continuityId: mha });

ok('an approved placement records the hash of the words it was approved over',
  db.raw.prepare('SELECT content_hash FROM entry_placements WHERE entry_id=?').get(bakugoProfile.id).content_hash?.length === 64);
db.raw.prepare('UPDATE lore_entries SET content = content || ?, keys = keys WHERE id=?').run('\nADDED LATER: something the placer never read.', bakugoProfile.id);
const after = entityChronology(db, bakugo).knowledge.find((k) => k.pieceId === bakugoProfile.id).placements[0];
ok('a piece whose words changed is marked for recheck, not silently trusted',
  after.state === 'recheck' && sourceChronology(db, MHA_ID).recheckPlacementCount === 1, after.state);
ok('the placement itself still stands, exactly as the semantic model treats a changed entry',
  after.status === 'approved' && after.from.token === 'DAY_1');
db.raw.prepare('UPDATE lore_entries SET content = ? WHERE id=?').run(bakugoProfile.content, bakugoProfile.id);
ok('and putting the words back clears it', entityChronology(db, bakugo).knowledge.find((k) => k.pieceId === bakugoProfile.id).placements[0].state === 'approved');
ok('placing an entry that is not there is refused', throwsChronology(() => placeEntry(db, { entryId: 'nope', fromPositionId: pos.DAY_1, ...manual })));
ok('placing at a position that is not there is refused', throwsChronology(() => placeEntry(db, { entryId: day1.id, fromPositionId: 'nope', ...manual })));

// --------------------------------------------------------- what it never does
console.log('\nWhat the temporal layer never does');
const storeSrc = readFileSync(join(WT, 'src', 'chronology', 'store.js'), 'utf8');
ok('the read model imports no analyser', !/conversion\/analy|assist\.js|analyzeSource/.test(storeSrc));
ok('and reads only its own tables and the pieces they point at',
  !/UPDATE lore_entries|UPDATE entry_semantics|UPDATE entry_relations|INSERT INTO lore_entries|INSERT INTO entry_semantics/.test(storeSrc));
ok('The Saint has approved knowledge and no chronology, and that is a whole answer',
  (() => { const c = sourceChronology(db, SAINT); return c.approvedPieceCount === 21 && c.placedPieceCount === 0 && c.approvedUnplacedPieceCount === 21; })());
ok('a Package v1 export of The Saint is byte for byte what it was', packageOf(SAINT) === packageBefore);

// ---------------------------------------------------------- prompt boundary
console.log('\nThe compiled prompt does not know any of this happened');
const promptAfter = sha(await stableOf());
console.log(`      before ${promptBefore.slice(0, 16)}… after ${promptAfter.slice(0, 16)}…`);
ok('the stable block of a real story\'s request is byte-identical', promptAfter === promptBefore && promptBefore !== sha(''));
const served = await api('/api/chronology');
ok('the read model is served, in its own units',
  served.status === 200 && served.body.continuityCount === 1 && served.body.continuities[0].positionCount === 4, JSON.stringify(served.body?.continuities?.[0]?.positionCount));
const servedEntity = await api(`/api/entities/${bakugo}/chronology`);
ok('and so is a person\'s place in time', servedEntity.status === 200 && servedEntity.body.placedPieceCount === 2);
const bad = await api(`/api/entries/${day1.id}/placement`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fromPositionId: pos.DAY_1, origin: 'inferred', status: 'approved' }) });
ok('the write route refuses the same things the store refuses', bad.status === 400, `${bad.status}`);

db.close();
app.kill();
await sleep(300);

// -------------------------------------------------------------- production
console.log('\nProduction, by name');
const prodAfter = namedCounts();
const shaAfter = prodSha();
for (const [k, v] of Object.entries(prodAfter)) console.log(`      ${k.padEnd(22)} = ${v}`);
ok('production is untouched, every named count', JSON.stringify(prodBefore) === JSON.stringify(prodAfter));
ok('production SHA is unchanged', shaBefore === shaAfter, shaAfter.slice(0, 16));
ok('production MHA has no semantics and no temporal rows',
  prodAfter.MHA_entry_semantics === 0 && prodAfter.MHA_source_semantics === 0 && prodAfter.MHA_temporal_rows === 0);

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exitCode = fail ? 1 : 0;
