// Saving a reviewed draft: what it writes, what it refuses, and what it never touches.
//
//   node scripts/check-review-apply.js
//
// Throwaway databases and invented material. Applying is the only way a legacy
// source becomes organised, so this is where the promises are kept.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open } from '../src/db/index.js';
import { analyzeSource } from '../src/conversion/analyze.js';
import { applyReview, correctionImpact } from '../src/conversion/apply.js';
import { createEntity, sourceOrganization, semanticViews } from '../src/semantics/store.js';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0; let fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? `  — ${d}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? `  — ${d}` : ''}`); }
};
const tmp = () => join(mkdtempSync(join(tmpdir(), 'tipsy-review-')), 'r.db');

const ENTRIES = [
  { title: 'Nora Vale', kind: 'note', keys: ['Nora Vale', 'Nora'], content: 'Nora Vale: patient, exacting, quietly funny. She runs the ferry office and keeps the company books.' },
  { title: 'Vale Company', kind: 'character', keys: ['Vale Company'], content: 'The Vale Company, led by Nora Vale, moves cargo along the river and pays for silence.' },
  { title: 'The Iron Gate', kind: 'note', keys: ['Iron Gate'], content: 'The Iron Gate is a prestigious nightclub and neutral ground. Violence inside is forbidden by the rules that keep it useful.' },
  { title: 'Childhood', kind: 'premise', keys: ['childhood'], content: 'Nora Vale grew up above a bakery and learned to read a room before entering it.' },
  { title: 'The Bargain', kind: 'note', keys: ['bargain'], content: 'First deliberate deal: nineteen, a riverside warehouse, no audience. The paper was an engraved deed Sorrento had given her.' },
  { title: 'Don Rafael Sorrento', kind: 'character', keys: ['Sorrento'], content: 'At seventeen, Don Rafael Sorrento took her in: clothes, a roof, rules. Nora believed for a year that it was family.' },
  { title: 'Ferry Office', kind: 'note', enabled: false, keys: ['ferry office'], content: 'The ferry office is a low building on the quay with a stove and two desks.' },
];

const library = () => {
  const db = open(tmp());
  const id = db.createLorebook('Harbour Files', '');
  for (const e of ENTRIES) db.saveEntry(id, { order: 100, enabled: true, constant: false, probability: 100, keys: [], ...e });
  return { db, id };
};

/**
 * The draft as Review would send it back: each complete proposal accepted as proposed.
 * An entry whose subject the engine could not settle is left undecided, exactly as the
 * screen leaves it until a person chooses.
 */
const complete = (e) => e.proposal && !(e.proposal.scope === 'entity' && !e.proposal.subject && !e.proposal.defines);
const reviewed = (draft, { approve = complete, edit = (e) => e, role = true } = {}) => ({
  role: role && draft.source.proposedRole.role !== 'mixed'
    ? { role: draft.source.proposedRole.role, subject: draft.source.proposedRole.subject }
    : role ? { role: 'mixed', subject: null } : null,
  entities: draft.entities.map((x) => ({ ref: x.ref, type: x.type, name: x.name, aliases: x.aliases, decision: 'new' })),
  entries: draft.entries.filter((e) => e.proposal).map((e) => edit({
    ref: e.ref, entryId: e.entryId, hash: e.hash, approve: approve(e), confidence: e.confidence,
    scope: e.proposal.scope, category: e.proposal.category, defines: e.proposal.defines,
    subject: e.proposal.subject, related: e.proposal.related, displayPath: e.proposal.displayPath,
  })),
  matches: [],
  evidence: Object.fromEntries(draft.entries.map((e) => [e.ref, e.evidence])),
});

const loreFingerprint = (db, id) => createHash('sha256').update(JSON.stringify(
  db.raw.prepare('SELECT * FROM lore_entries WHERE lorebook_id=? ORDER BY id').all(id))).digest('hex');
const count = (db, t, where = '') => db.raw.prepare(`SELECT COUNT(*) n FROM ${t} ${where}`).get().n;

// ---------------------------------------------------------------- A
console.log('A  what applying writes');
const { db, id } = library();
const before = loreFingerprint(db, id);
const draft = analyzeSource(db, id);
{
  const result = applyReview(db, id, reviewed(draft));
  const sem = (title) => {
    const entry = db.listEntries(id).find((e) => e.title === title);
    return db.raw.prepare('SELECT * FROM entry_semantics WHERE entry_id=?').get(entry.id);
  };
  ok('entities are created and declared by the source', count(db, 'lore_entities') === draft.entities.length
    && count(db, 'source_entities', `WHERE lorebook_id='${id}' AND status='approved'`) === draft.entities.length);
  ok('what the person approved is approved, and marked as converted', sem('Nora Vale').status === 'approved' && sem('Nora Vale').origin === 'converted');
  ok('the proposal it came from is kept as the reason', JSON.parse(sem('Nora Vale').evidence).why.length > 0
    && JSON.parse(sem('Nora Vale').evidence).proposedBy === 'deterministic-conversion' && JSON.parse(sem('Nora Vale').evidence).decidedIn === 'review');
  ok('a profile defines its entity', sem('Vale Company').defines_entity_id === result.entities[draft.entities.find((x) => x.name === 'Vale Company').ref]);
  const childhood = db.listEntries(id).find((e) => e.title === 'Childhood');
  ok('an entry about someone gets one approved subject', db.raw.prepare("SELECT COUNT(*) n FROM entry_relations WHERE entry_id=? AND relation='subject' AND status='approved'").get(childhood.id).n === 1);
  ok('related entities are recorded as related', db.raw.prepare("SELECT COUNT(*) n FROM entry_relations WHERE relation='related' AND status='approved'").get().n >= 1);
  ok('the source keeps its role', db.raw.prepare('SELECT * FROM source_semantics WHERE lorebook_id=?').get(id)?.status === 'approved');
  ok('nothing was left proposed', count(db, 'entry_semantics', "WHERE status<>'approved'") === 0 && count(db, 'entry_relations', "WHERE status<>'approved'") === 0);
}

// ---------------------------------------------------------------- B
console.log('\nB  the entries themselves are never touched');
{
  ok('titles, content, stored kind, keywords and activation are byte for byte as they were', loreFingerprint(db, id) === before);
  const office = db.listEntries(id).find((e) => e.title === 'Ferry Office');
  ok('a disabled entry stays disabled, and is still organised', office.enabled === false
    && db.raw.prepare('SELECT status FROM entry_semantics WHERE entry_id=?').get(office.id)?.status === 'approved');
  ok('the stored kind still disagrees, and is left alone', db.listEntries(id).find((e) => e.title === 'Vale Company').kind === 'character');
}

// ---------------------------------------------------------------- C
console.log('\nC  organising a piece at a time');
{
  const { db: d2, id: i2 } = library();
  const draft2 = analyzeSource(d2, i2);
  const hard = ['The Bargain'];
  applyReview(d2, i2, reviewed(draft2, { approve: (e) => !hard.includes(e.title) }));
  const state = sourceOrganization(d2, i2);
  const bargain = d2.listEntries(i2).find((e) => e.title === 'The Bargain');
  ok('the difficult entry is left alone', !d2.raw.prepare('SELECT 1 FROM entry_semantics WHERE entry_id=?').get(bargain.id));
  ok('the rest is organised', state.coverage === 'partial' && state.approved === draft2.entries.filter((e) => e.proposal).length - 1, JSON.stringify(state));
  ok('one hard entry does not hold up a source', state.approved >= 5);
  // …and finishing it later completes the source.
  const draft3 = analyzeSource(d2, i2);
  applyReview(d2, i2, reviewed(draft3, {
    approve: (e) => hard.includes(e.title),
    edit: (e) => (e.subject === null && e.scope === 'entity' ? { ...e, subject: draft3.entities.find((x) => x.name === 'Nora Vale').ref } : e),
  }));
  ok('deciding it later organises the whole source', sourceOrganization(d2, i2).coverage === 'organized', JSON.stringify(sourceOrganization(d2, i2)));
  ok('a reopened review shows what was already approved', analyzeSource(d2, i2).entries.every((e) => e.current === 'approved'));
}

// ---------------------------------------------------------------- D
console.log('\nD  applying twice, and changing your mind');
{
  const { db: d3, id: i3 } = library();
  const draft3 = analyzeSource(d3, i3);
  const first = applyReview(d3, i3, reviewed(draft3));
  const counts = () => [count(d3, 'lore_entities'), count(d3, 'source_entities'), count(d3, 'entry_semantics'), count(d3, 'entry_relations')].join(',');
  const afterFirst = counts();
  const second = applyReview(d3, i3, reviewed(analyzeSource(d3, i3)));
  ok('applying the same decisions again changes nothing', counts() === afterFirst && JSON.stringify(second.entities) === JSON.stringify(first.entities));
  const childhood = d3.listEntries(i3).find((e) => e.title === 'Childhood');
  const sorrento = draft3.entities.find((x) => x.name === 'Don Rafael Sorrento').ref;
  applyReview(d3, i3, {
    ...reviewed(analyzeSource(d3, i3), { approve: (e) => e.title === 'Childhood' }),
    entries: [{ ...reviewed(analyzeSource(d3, i3)).entries.find((e) => e.entryId === childhood.id), subject: sorrento, related: [], approve: true }],
  });
  const rel = d3.raw.prepare('SELECT entity_id, relation FROM entry_relations WHERE entry_id=?').all(childhood.id);
  ok('changing who an entry is about replaces the old decision', rel.length === 1 && rel[0].entity_id === first.entities[sorrento] && rel[0].relation === 'subject');
  ok('and leaves no duplicate rows behind', counts().split(',')[3] === afterFirst.split(',')[3]);
}

// ---------------------------------------------------------------- E
console.log('\nE  refusing what it should refuse');
{
  const { db: d4, id: i4 } = library();
  const draft4 = analyzeSource(d4, i4);
  const nothing = () => [count(d4, 'lore_entities'), count(d4, 'entry_semantics'), count(d4, 'entry_relations'), count(d4, 'source_semantics')].join(',');
  const clean = nothing();

  // The source changed after the review was opened.
  const childhood = d4.listEntries(i4).find((e) => e.title === 'Childhood');
  d4.saveEntry(i4, { id: childhood.id, content: 'Rewritten while the review was open.' });
  let stale = null;
  try { applyReview(d4, i4, reviewed(draft4)); } catch (e) { stale = e; }
  ok('a review of text that has since changed is refused', stale?.status === 409 && /open the review again/i.test(stale.message));
  ok('it says which entry moved under it', stale?.stale?.some((s) => s.title === 'Childhood' || s.ref));
  ok('and writes nothing at all', nothing() === clean);

  // Decisions that do not make sense.
  const fresh = analyzeSource(d4, i4);
  const bad = reviewed(fresh);
  bad.entries[0] = { ...bad.entries[0], scope: 'entity', category: 'identity', subject: null, defines: null };
  let invalid = null;
  try { applyReview(d4, i4, bad); } catch (e) { invalid = e; }
  ok('an entry about nobody in particular is refused', invalid?.status === 400 && invalid.problems.some((p) => /which one/.test(p.message)));
  const unknown = reviewed(fresh);
  unknown.entries[0] = { ...unknown.entries[0], related: ['nobody-here'] };
  let missing = null;
  try { applyReview(d4, i4, unknown); } catch (e) { missing = e; }
  ok('a decision pointing at someone who is not in the review is refused', missing?.problems.some((p) => /not one of the people/.test(p.message)));
  ok('still nothing written', nothing() === clean);

  // A failure part-way through leaves nothing behind.
  const wrongType = reviewed(fresh);
  const place = createEntity(d4, { type: 'place', name: 'Somewhere Else' });
  const personRef = fresh.entities.find((x) => x.type === 'person').ref;
  wrongType.entities = wrongType.entities.map((x) => (x.ref === personRef ? { ...x, decision: 'existing', entityId: place } : x));
  let rolledBack = null;
  try { applyReview(d4, i4, wrongType); } catch (e) { rolledBack = e; }
  ok('choosing a place where a person belongs is refused', rolledBack !== null && /is a place, not a person/.test(rolledBack.message));
  ok('and the half-written transaction is rolled back', count(d4, 'lore_entities') === 1 && count(d4, 'entry_semantics') === 0 && count(d4, 'source_entities') === 0);
}

// ---------------------------------------------------------------- F
console.log('\nF  two sources, one name');
{
  const { db: d5, id: i5 } = library();
  const other = d5.createLorebook('Ledger of the North', '');
  d5.saveEntry(other, { title: 'Nora Vale', kind: 'character', keys: ['Nora Vale'], content: 'Nora Vale is a cartographer in the northern reach. She has never seen the sea.', order: 100, enabled: true, keys2: [] });
  const otherDraft = analyzeSource(d5, other);
  applyReview(d5, other, reviewed(otherDraft));
  const theirNora = d5.raw.prepare("SELECT entity_id FROM source_entities WHERE lorebook_id=?").get(other).entity_id;

  const mine = analyzeSource(d5, i5, { compareWith: [other] });
  const noraRef = mine.entities.find((x) => x.name === 'Nora Vale').ref;
  ok('the match is offered, not taken', mine.matches.some((m) => m.entity === noraRef) && count(d5, 'entity_distinctions') === 0);

  // Deciding nothing leaves them separate and undecided.
  const later = { ...reviewed(mine), matches: [{ entity: noraRef, entityId: theirNora, decision: 'later' }] };
  applyReview(d5, i5, later);
  const myNora = d5.raw.prepare('SELECT entity_id FROM source_entities WHERE lorebook_id=? AND local_ref=?').get(i5, noraRef).entity_id;
  ok('deciding later makes a separate person, and no claim either way', myNora !== theirNora && count(d5, 'entity_distinctions') === 0);

  // Deciding they are different records that decision.
  const separate = { ...reviewed(analyzeSource(d5, i5, { compareWith: [other] })), matches: [{ entity: noraRef, entityId: theirNora, decision: 'separate' }] };
  applyReview(d5, i5, separate);
  ok('"keep separate" is written down as a decision', count(d5, 'entity_distinctions') === 1);
  const after = analyzeSource(d5, i5, { compareWith: [other] });
  ok('and the match stops being offered', !after.matches.some((m) => m.candidate.entityId === theirNora)
    && after.suppressedMatches.some((m) => /not the same/.test(m.reason)));

  // Deciding they are the same reuses the entity that already exists.
  const { db: d6, id: i6 } = library();
  const far = d6.createLorebook('Another shelf', '');
  d6.saveEntry(far, { title: 'Nora Vale', kind: 'character', keys: ['Nora Vale'], content: 'Nora Vale: patient, exacting, quietly funny. She runs the ferry office.', order: 100, enabled: true });
  applyReview(d6, far, reviewed(analyzeSource(d6, far)));
  const hers = d6.raw.prepare('SELECT entity_id FROM source_entities WHERE lorebook_id=?').get(far).entity_id;
  const d6draft = analyzeSource(d6, i6, { compareWith: [far] });
  const ref6 = d6draft.entities.find((x) => x.name === 'Nora Vale').ref;
  applyReview(d6, i6, { ...reviewed(d6draft), matches: [{ entity: ref6, entityId: hers, decision: 'same' }] });
  ok('"same person" reuses the person who already exists', d6.raw.prepare('SELECT entity_id FROM source_entities WHERE lorebook_id=? AND local_ref=?').get(i6, ref6).entity_id === hers);
  ok('both sources now declare that one person', count(d6, 'source_entities', `WHERE entity_id='${hers}'`) === 2);
}

// ---------------------------------------------------------------- G
console.log('\nG  the state of a source, and changing it afterwards');
{
  const { db: d7, id: i7 } = library();
  ok('before anything is decided it is unorganised', sourceOrganization(d7, i7).coverage === 'unorganized');
  const draft7 = analyzeSource(d7, i7);
  applyReview(d7, i7, reviewed(draft7, { approve: (e) => e.confidence === 'high' }));
  ok('after approving some of it, partially organised', sourceOrganization(d7, i7).coverage === 'partial');
  applyReview(d7, i7, reviewed(analyzeSource(d7, i7), {
    approve: () => true,
    edit: (e) => (e.scope === 'entity' && !e.subject && !e.defines ? { ...e, subject: draft7.entities.find((x) => x.name === 'Nora Vale').ref } : e),
  }));
  ok('once every entry is decided, organised', sourceOrganization(d7, i7).coverage === 'organized');
  const nora = d7.listEntries(i7).find((e) => e.title === 'Nora Vale');
  d7.saveEntry(i7, { id: nora.id, content: `${nora.content} She has started locking the office at night.` });
  const state = sourceOrganization(d7, i7);
  ok('editing an approved entry asks for a recheck, and keeps the decision', state.display === 'needs_recheck' && state.recheck === 1
    && d7.raw.prepare('SELECT status FROM entry_semantics WHERE entry_id=?').get(nora.id).status === 'approved');
  const reopened = analyzeSource(d7, i7);
  ok('reopening shows it as needing a recheck', reopened.entries.find((e) => e.title === 'Nora Vale').current === 'recheck');
  ok('and the others still read as approved', reopened.entries.filter((e) => e.title !== 'Nora Vale').every((e) => e.current === 'approved'));
  const views = semanticViews(d7, d7.listEntries(i7));
  ok('the approved reading is still used while it is stale', views.get(nora.id).authoritative === true && views.get(nora.id).stale === true);
}

// ---------------------------------------------------------------- H
console.log('\nH  through the server');
{
  const path = tmp();
  const seed = open(path);
  const sid = seed.createLorebook('Harbour Files', '');
  for (const e of ENTRIES) seed.saveEntry(sid, { order: 100, enabled: true, constant: false, keys: [], ...e });
  const loreBefore = loreFingerprint(seed, sid);
  seed.close();
  const PORT = 8960 + Math.floor(Math.random() * 30);
  const server = spawn(process.execPath, ['server.js'], { cwd: join(here, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: path, OPENROUTER_API_KEY: '' }, stdio: 'ignore' });
  const B = `http://localhost:${PORT}`;
  for (let i = 0; i < 80; i++) { try { await fetch(B); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
  const J = (p, body) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const preview = await J(`/api/lorebooks/${sid}/semantic-preview`, {});
    const decisions = reviewed(preview.body);
    const applied = await J(`/api/lorebooks/${sid}/semantic-apply`, decisions);
    ok('apply through the route reports what it did', applied.status === 200 && applied.body.entries.length >= 5 && applied.body.organization.coverage);
    const check = open(path);
    ok('the lore itself is untouched', loreFingerprint(check, sid) === loreBefore);
    ok('semantics are approved and converted', check.raw.prepare("SELECT COUNT(*) n FROM entry_semantics WHERE status='approved' AND origin='converted'").get().n === applied.body.entries.length);
    check.close();
    const stale = await J(`/api/lorebooks/${sid}/semantic-apply`, { ...decisions, entries: decisions.entries.map((e) => ({ ...e, hash: 'not-the-hash' })) });
    ok('a stale review is refused with 409 and an explanation', stale.status === 409 && Array.isArray(stale.body.stale) && /review again/i.test(stale.body.error));
    const broken = await J(`/api/lorebooks/${sid}/semantic-apply`, { ...decisions, entries: decisions.entries.map((e) => ({ ...e, category: 'quirk' })) });
    ok('an impossible category is refused with the reasons', broken.status === 400 && broken.body.problems.some((p) => /not a category/.test(p.message)));
  } finally {
    server.kill();
  }
}

// ---------------------------------------------------------------- I
console.log('\nI  how a reading was produced is stored, and never lied about');
{
  const { db, id } = library();
  const draft = analyzeSource(db, id);
  const d = reviewed(draft);
  // Three readings approved in the same moment, produced three different ways.
  const [first, second, third] = d.entries.filter((e) => e.approve);
  first.proposedBy = 'deterministic-conversion';
  second.proposedBy = 'model-assist';
  second.model = 'some-provider/some-model';
  third.proposedBy = 'manual';
  applyReview(db, id, d);

  const why = (entryId) => JSON.parse(db.raw.prepare('SELECT evidence FROM entry_semantics WHERE entry_id=?').get(entryId).evidence);
  ok('a deterministic reading says so', why(first.entryId).proposedBy === 'deterministic-conversion', why(first.entryId).proposedBy);
  ok('a reading taken from a model says so', why(second.entryId).proposedBy === 'model-assist', why(second.entryId).proposedBy);
  ok('and names the model that proposed it', why(second.entryId).model === 'some-provider/some-model', why(second.entryId).model);
  ok("a reading a person chose themselves says so", why(third.entryId).proposedBy === 'manual', why(third.entryId).proposedBy);
  ok("all three are still a person's approval", [first, second, third].every((e) => why(e.entryId).decidedIn === 'review'));
  ok('and all three are approved, whatever proposed them',
    [first, second, third].every((e) => db.raw.prepare('SELECT status FROM entry_semantics WHERE entry_id=?').get(e.entryId).status === 'approved'));
  ok('a model is never named on a reading it did not propose', !why(first.entryId).model && !why(third.entryId).model);

  const { db: db2, id: id2 } = library();
  const d2 = reviewed(analyzeSource(db2, id2));
  const one = d2.entries.find((e) => e.approve);
  one.proposedBy = 'the-oracle';
  applyReview(db2, id2, d2);
  const w = JSON.parse(db2.raw.prepare('SELECT evidence FROM entry_semantics WHERE entry_id=?').get(one.entryId).evidence);
  ok('an origin nobody recognises falls back to the deterministic pass', w.proposedBy === 'deterministic-conversion', w.proposedBy);
  db.close(); db2.close();
}

// ---------------------------------------------------------------- J
console.log('\nJ  correcting a reading that was already saved');
{
  const { db, id } = library();
  const draft = analyzeSource(db, id);
  applyReview(db, id, reviewed(draft));
  const before = loreFingerprint(db, id);

  const childhood = draft.entries.find((e) => e.title === 'Childhood');
  const sorrento = draft.entities.find((x) => x.name === 'Don Rafael Sorrento');
  const subjectNow = () => db.raw.prepare("SELECT entity_id FROM entry_relations WHERE entry_id=? AND relation='subject' AND status='approved'").get(childhood.entryId)?.entity_id;
  const nameOf = (entityId) => (entityId ? db.raw.prepare('SELECT canonical_name FROM lore_entities WHERE id=?').get(entityId)?.canonical_name : null);
  ok('it was saved as being about one person', nameOf(subjectNow()) === 'Nora Vale', nameOf(subjectNow()));

  const impact = correctionImpact(db, id, childhood.entryId);
  ok('the impact names the person it is about', impact.person?.name === 'Nora Vale', impact.person?.name);
  ok('and says what else in this source says the same', impact.depends.alsoAboutThem > 0, `${impact.depends.alsoAboutThem} others`);
  ok('so it is not the only thing holding that tie', impact.depends.lastTie === false);
  const peopleBefore = count(db, 'lore_entities');

  const fix = reviewed(draft, {
    approve: (e) => e.ref === childhood.ref,
    edit: (e) => (e.ref === childhood.ref ? { ...e, subject: sorrento.ref, category: 'backstory', proposedBy: 'manual' } : e),
  });
  const out = applyReview(db, id, fix);
  ok('the correction applied', out.entries.includes(childhood.ref));
  ok('it is now about the other person', nameOf(subjectNow()) === 'Don Rafael Sorrento', nameOf(subjectNow()));
  ok('and the old subject was not left behind',
    count(db, 'entry_relations', `WHERE entry_id='${childhood.entryId}' AND relation='subject'`) === 1);
  ok('the entry itself is byte for byte as it was', loreFingerprint(db, id) === before);
  ok('nobody was deleted', count(db, 'lore_entities') === peopleBefore, `${count(db, 'lore_entities')} of ${peopleBefore}`);
  ok('no entry was deleted', count(db, 'lore_entries') === ENTRIES.length);
  ok("and it is recorded as a person's own decision",
    JSON.parse(db.raw.prepare('SELECT evidence FROM entry_semantics WHERE entry_id=?').get(childhood.entryId).evidence).proposedBy === 'manual');

  const gate = draft.entries.find((e) => e.title === 'The Iron Gate');
  const gateImpact = correctionImpact(db, id, gate.entryId);
  ok('an only tie is named as an only tie', gateImpact.depends.lastTie === true, JSON.stringify(gateImpact.depends));
  // An entry review left undecided has no saved reading to correct.
  const undecided = db.listEntries(id).find((e) => !db.raw.prepare('SELECT 1 x FROM entry_semantics WHERE entry_id=?').get(e.id));
  ok('and an entry nobody has organised has nothing leaning on it',
    !!undecided && correctionImpact(db, id, undecided.id).approved === false, undecided?.title || 'everything was organised');
  db.close();
}

// ---------------------------------------------------------------- K
console.log('\nK  activation is not part of meaning, and never changes with it');
{
  const { db, id } = library();
  // Every activation column there is, and the stored legacy kind with them.
  const COLS = ['enabled', 'constant', 'keys', 'secondary_keys', 'selective', 'selective_logic', 'ord', 'position',
    'depth', 'probability', 'use_probability', 'scan_depth', 'exclude_recursion', 'prevent_recursion',
    'delay_until_recursion', 'grp', 'group_override', 'group_weight', 'use_group_scoring', 'sticky', 'cooldown',
    'delay', 'ignore_budget', 'vectorized', 'case_sensitive', 'match_whole_words', 'use_regex', 'role', 'kind'];
  const activation = () => db.raw.prepare(`SELECT id, ${COLS.join(', ')} FROM lore_entries WHERE lorebook_id=? ORDER BY id`).all(id);
  const before = activation();

  const draft = analyzeSource(db, id);
  applyReview(db, id, reviewed(draft));
  ok(`every one of the ${COLS.length} activation fields is untouched by organising`, JSON.stringify(activation()) === JSON.stringify(before));

  const childhood = draft.entries.find((e) => e.title === 'Childhood');
  const sorrento = draft.entities.find((x) => x.name === 'Don Rafael Sorrento');
  applyReview(db, id, reviewed(draft, {
    approve: (e) => e.ref === childhood.ref,
    edit: (e) => (e.ref === childhood.ref ? { ...e, subject: sorrento.ref } : e),
  }));
  ok('and untouched by correcting one afterwards', JSON.stringify(activation()) === JSON.stringify(before));

  const off = db.listEntries(id).find((e) => e.title === 'Ferry Office');
  ok('a switched-off entry is still switched off', !off.enabled, String(off.enabled));
  const sem = db.raw.prepare('SELECT scope, category, status FROM entry_semantics WHERE entry_id=?').get(off.id);
  ok('and it was still given a meaning', !!sem && sem.status === 'approved', JSON.stringify(sem));
  db.close();
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exitCode = fail ? 1 : 0;
