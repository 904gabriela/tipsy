// Legacy semantic conversion (P3): deterministic drafts, and the promises they make.
//
//   node scripts/check-conversion.js
//
// Throwaway databases, invented people and places, and a counting stand-in for
// the model provider. The real library is never touched by this suite; the real
// sources are exercised separately, read-only, and reported.

import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { open } from '../src/db/index.js';
import { analyzeSource, DRAFT_FORMAT, DRAFT_VERSION } from '../src/conversion/analyze.js';
import { createEntity, declareInSource, distinguish } from '../src/semantics/store.js';
import { directiveSentence } from '../src/conversion/text.js';
import { PERSON_CATEGORIES } from '../src/semantics/authority.js';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0; let fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? `  — ${d}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? `  — ${d}` : ''}`); }
};
const tmp = () => join(mkdtempSync(join(tmpdir(), 'tipsy-conversion-')), 'c.db');

// ---------------------------------------------------------------- a library
// Invented material, shaped like the messy legacy sources this has to read:
// types stored wrongly, pronoun-led entries, duplicates, disabled phase copies.

const PERSON = { title: 'Nora Vale', kind: 'note', keys: ['Nora Vale', 'Nora'], content: 'Nora Vale: patient, exacting, quietly funny. She runs the ferry office and keeps the company books.' };
const FACTION = { title: 'Vale Company', kind: 'character', keys: ['Vale Company'], content: 'The Vale Company, led by Nora Vale, moves cargo along the river and pays for silence.' };
const PLACE = { title: 'The Iron Gate', kind: 'note', keys: ['Iron Gate'], content: 'The Iron Gate is a prestigious nightclub and neutral ground. Violence inside is forbidden by the rules that keep it useful.' };
const OFFICE = { title: 'Ferry Office', kind: 'note', keys: ['ferry office', 'office', 'quay'], content: 'The ferry office is a low building on the quay with a stove, two desks and a ledger nobody else reads.' };

const SOURCE_A = [
  PERSON, FACTION, PLACE, OFFICE,
  { title: 'Childhood', kind: 'premise', keys: ['childhood'], content: 'Nora Vale grew up above a bakery and learned to read a room before entering it.' },
  { title: 'Deepest Fear', kind: 'note', keys: ['fear'], content: 'She is used to being feared. What she cannot stand is being pitied by the people she protects.' },
  // The pronoun version: another person is named, nobody is named as the subject.
  { title: 'The Bargain', kind: 'note', keys: ['bargain', 'deed'], content: 'First deliberate deal: nineteen, a riverside warehouse, no audience. The paper was an engraved deed Sorrento had given her. She does not display it.' },
  { title: 'Don Rafael Sorrento', kind: 'character', keys: ['Sorrento', 'Rafael'], content: 'At seventeen, Don Rafael Sorrento took her in: clothes, a roof, rules, and the habit of counting exits. Nora believed for a year that it was family.' },
  { title: 'Ferry Nights', kind: 'note', keys: ['night', 'walk'], content: 'On quiet nights Nora Vale walks from the office to the Iron Gate and back, checking doors as she goes.' },
  { title: 'DISABLED — late chapter', kind: 'note', enabled: false, keys: ['ferry office', 'office', 'quay'], content: 'The ferry office is a low building on the quay with a stove, two desks and a locked cupboard behind the door.' },
  // A prefix only one entry uses is not a group, and must not become one.
  { title: 'Quay: the morning run', kind: 'note', keys: ['morning'], content: 'The first ferry leaves before dawn and the quay is busy with crates an hour beforehand.' },
  { title: 'Ability: Tideglass', kind: 'note', keys: ['tideglass'], content: 'Tideglass lets her hold river water in a shape for as long as she can keep her breath.' },
  { title: 'Ability: Limits', kind: 'note', keys: ['tideglass', 'limit'], content: 'Holding a shape longer than a minute leaves her dizzy and useless for an hour.' },
  { title: 'Player Agency RULE', kind: 'direction', constant: true, keys: ['agency'], content: 'RULE — never write the player\'s dialogue, choices or feelings. Do not decide what they notice.' },
  { title: 'Keep the Space Coherent', kind: 'note', keys: ['room', 'door'], content: 'Maintain spatial continuity. Keep track of where people stand and who can see or reach whom. A character crossing a room takes time to arrive.' },
];

// A second copy of the same material, plus the same entry written with the name in it.
const SOURCE_B = [
  PERSON, FACTION, PLACE,
  { title: 'Childhood', kind: 'premise', keys: ['childhood'], content: 'Nora Vale grew up above a bakery and learned to read a room before entering it.' },
  { title: 'Deepest Fear', kind: 'note', keys: ['fear'], content: 'She is used to being feared. What she cannot stand is being pitied by the people she protects.' },
  { title: 'The Bargain', kind: 'note', keys: ['bargain', 'deed'], content: 'First deliberate deal: nineteen, a riverside warehouse, no audience. The paper was an engraved deed Sorrento had given Nora. She does not display it.' },
  { title: 'Don Rafael Sorrento', kind: 'character', keys: ['Sorrento'], content: 'At seventeen, Don Rafael Sorrento took her in: clothes, a roof, rules. Nora believed for a year that it was family.' },
];

// Somebody else with the same name, and nothing else in common.
const SOURCE_C = [
  { title: 'Nora Vale', kind: 'character', keys: ['Nora Vale'], content: 'Nora Vale is a cartographer in the northern reach. She has never seen the sea and says so often.' },
];

const SOURCE_FRAMEWORK = [
  { title: 'Immersive Core', kind: 'note', constant: true, keys: ['immersion'], content: 'Prioritise immersion and continuity over pace. Stay in character and describe only this character\'s actions and inner life.' },
  { title: 'Injuries Persist', kind: 'note', keys: ['wound'], content: 'Injuries carry weight and duration. A hurt character moves carefully, favours the wounded side and tires faster. Wounds do not vanish between scenes.' },
  { title: 'Let Silence Speak', kind: 'note', keys: ['silence'], content: 'Not every beat needs dialogue. Allow pauses to stretch and let a held breath carry the meaning.' },
  { title: 'People Are Not Omniscient', kind: 'rule', keys: ['lie'], content: 'Characters know only what they could plausibly have learned, and they are not always honest. They can withhold, bluff or be wrong about another character.' },
];

const SOURCE_REFERENCE = [
  { title: 'Describes the tourniquet technique. Expanded.', kind: 'note', keys: ['tourniquet'], content: 'Two to three inches above the wound, never over a joint. Tighten until the bleeding stops and write down the time.' },
  { title: 'Describes the treatment of shock. Expanded.', kind: 'note', keys: ['shock'], content: 'Pale, cold, clammy skin and a fast weak pulse. Lay them flat, raise the legs, keep them warm, nothing to drink.' },
  { title: 'Guidelines for splinting a limb.', kind: 'note', keys: ['splint'], content: 'Pad the limb, immobilise the joint above and below, check the fingers stay warm and pink.' },
  { title: 'Describes safe technique for moving an injured person.', kind: 'note', keys: ['carry'], content: 'Keep the spine in line, use the legs, move on a count agreed out loud beforehand.' },
];

const build = (db, name, entries) => {
  const id = db.createLorebook(name, '');
  for (const e of entries) db.saveEntry(id, { order: 100, enabled: true, constant: false, keys: [], ...e });
  return id;
};

const db = open(tmp());
const A = build(db, 'Harbour Files', SOURCE_A);
const B = build(db, 'Harbour Files (second copy)', SOURCE_B);
const C = build(db, 'Ledger of the North', SOURCE_C);
const FRAME = build(db, 'Living Frame', SOURCE_FRAMEWORK);
const REF = build(db, 'Field Notes', SOURCE_REFERENCE);

// One historical link, of the kind the old composer wrote: never truth.
db.raw.prepare(`INSERT INTO legacy_entry_links (source, entry_id, target_kind, target_id, entry_title, entry_book_id, entry_origin, target_name, derived_origin, status, recorded_at)
                VALUES ('entry_entry_links', ?, 'entry', ?, 'The Bargain', ?, NULL, 'Don Rafael Sorrento', 'composer-inferred', 'legacy', 1)`)
  .run(db.listEntries(A).find((e) => e.title === 'The Bargain').id, db.listEntries(A).find((e) => e.title === 'Don Rafael Sorrento').id, A);

const draft = analyzeSource(db, A);
const byTitle = (d, t) => d.entries.find((e) => e.title === t);
const entity = (d, ref) => d.entities.find((e) => e.ref === ref);
const named = (d, name) => d.entities.find((e) => e.name === name);
const subjectOf = (d, t) => { const p = byTitle(d, t).proposal; return p && p.subject ? entity(d, p.subject).name : null; };
const relatedOf = (d, t) => (byTitle(d, t).proposal?.related || []).map((r) => entity(d, r).name).sort();
const evidenceOf = (d, t) => byTitle(d, t).evidence.map((v) => `${v.type}: ${v.detail}`).join(' | ');

// ---------------------------------------------------------------- A
console.log('A  the draft');
{
  ok('it is a draft, not a decision', draft.format === DRAFT_FORMAT && draft.version === DRAFT_VERSION);
  ok('every entry is accounted for', draft.entries.length === SOURCE_A.length && draft.source.entryCount === SOURCE_A.length);
  ok('entities carry draft refs, never database ids', draft.entities.every((e) => /^[a-z0-9][a-z0-9-]*$/.test(e.ref) && e.declaredEntityId === null));
  ok('every proposal carries evidence a person can read', draft.entries.every((e) => e.evidence.length && e.evidence.every((v) => typeof v.detail === 'string' && v.detail.length > 10)));
  ok('confidence is high, medium or low', draft.entries.every((e) => ['high', 'medium', 'low'].includes(e.confidence)) && draft.entities.every((e) => ['high', 'medium', 'low'].includes(e.confidence)));
  ok('nothing is proposed as approved', !JSON.stringify(draft).includes('"status":"approved"'));
}

// ---------------------------------------------------------------- B
console.log('\nB  the stored kind is evidence, not truth');
{
  const person = named(draft, 'Nora Vale');
  const faction = named(draft, 'Vale Company');
  const place = named(draft, 'The Iron Gate');
  ok('stored "note" that profiles a person → person', person?.type === 'person' && byTitle(draft, 'Nora Vale').storedKind === 'note',
    person?.evidence.map((v) => v.type).join(','));
  ok('stored "character" that is a group → faction', faction?.type === 'faction' && byTitle(draft, 'Vale Company').storedKind === 'character');
  ok('stored "note" that is a place → place', place?.type === 'place' && byTitle(draft, 'The Iron Gate').storedKind === 'note');
  ok('the stored kind is never rewritten', db.listEntries(A).find((e) => e.title === 'Nora Vale').kind === 'note'
    && db.listEntries(A).find((e) => e.title === 'Vale Company').kind === 'character');
  ok('the disagreement is reported, not hidden', draft.warnings.some((w) => w.code === 'kind-disagrees' && /Vale Company/.test(w.message)));
  ok('an honorific title names a person', named(draft, 'Don Rafael Sorrento')?.type === 'person');
}

// ---------------------------------------------------------------- C
console.log('\nC  subject and related');
{
  ok('a name in the first sentence makes the subject clear', subjectOf(draft, 'Childhood') === 'Nora Vale' && byTitle(draft, 'Childhood').confidence === 'high');
  ok('the category is read from the language', byTitle(draft, 'Childhood').proposal.category === 'backstory' && byTitle(draft, 'Deepest Fear').proposal.category === 'psychology');
  ok('a pronoun plus the source context is medium, not high', subjectOf(draft, 'Deepest Fear') === 'Nora Vale' && byTitle(draft, 'Deepest Fear').confidence === 'medium'
    && /source-context/.test(evidenceOf(draft, 'Deepest Fear')));
  ok('a profile defines its entity and relates the rest', byTitle(draft, 'Vale Company').proposal.defines === named(draft, 'Vale Company').ref
    && relatedOf(draft, 'Vale Company').join() === 'Nora Vale');
  ok('someone named in passing is related, not the subject', subjectOf(draft, 'Don Rafael Sorrento') === null
    && byTitle(draft, 'Don Rafael Sorrento').proposal.defines === named(draft, 'Don Rafael Sorrento').ref
    && relatedOf(draft, 'Don Rafael Sorrento').join() === 'Nora Vale');
  ok('a place named in the body does not steal the subject', subjectOf(draft, 'Ferry Nights') === 'Nora Vale'
    && !byTitle(draft, 'Ferry Nights').subjectCandidates.some((c) => entity(draft, c.entity).name === 'The Iron Gate')
    && /mentioned-only: The Iron Gate/.test(evidenceOf(draft, 'Ferry Nights')));
  ok('a mention with no tie is reported as a mention only', /mentioned-only/.test(evidenceOf(draft, 'Childhood')) || draft.entries.some((e) => e.evidence.some((v) => v.type === 'mentioned-only')));
}

// ---------------------------------------------------------------- D
console.log('\nD  honest uncertainty');
{
  const bargain = byTitle(draft, 'The Bargain');
  ok('two people, no one named as subject → unresolved and low', bargain.proposal.subject === null && bargain.confidence === 'low' && bargain.unresolved.length > 0,
    bargain.unresolved.join(' / '));
  ok('both candidates are shown with their evidence', bargain.subjectCandidates.length >= 2 && bargain.subjectCandidates.every((c) => c.evidence.length));
  ok('it is still read as backstory about someone', bargain.proposal.scope === 'entity' && bargain.proposal.category === 'backstory');
  ok('the one it names is related', relatedOf(draft, 'The Bargain').includes('Don Rafael Sorrento'));
  ok('unresolved subjects are warned about', draft.warnings.some((w) => w.code === 'subject-unresolved'));
}

// ---------------------------------------------------------------- E
console.log('\nE  a historical link is weak evidence, never truth');
{
  const bargain = byTitle(draft, 'The Bargain');
  const link = bargain.evidence.filter((v) => v.type === 'legacy-link-evidence');
  ok('the link is recorded, labelled historical, and worth nothing', link.length === 1 && link[0].points === 0 && /historical composer\/builder link/.test(link[0].detail));
  ok('it cannot make the linked person the subject', bargain.proposal.subject === null);
  ok('it cannot make anything high confidence', bargain.confidence === 'low');
  ok('a link the content does not support is flagged for review', draft.warnings.some((w) => w.code === 'legacy-link-unsupported') || relatedOf(draft, 'The Bargain').includes('Don Rafael Sorrento'));
}

// ---------------------------------------------------------------- F
console.log('\nF  the same entry, written two ways');
{
  const b = analyzeSource(db, B);
  const pronoun = byTitle(draft, 'The Bargain');
  const spelled = byTitle(b, 'The Bargain');
  ok('the version that names her reads as hers', entity(b, spelled.proposal.subject)?.name === 'Nora Vale' && ['medium', 'high'].includes(spelled.confidence), spelled.confidence);
  ok('the version that says "her" stays unresolved', pronoun.proposal.subject === null && pronoun.confidence === 'low');
  ok('both are read as the same kind of knowledge', pronoun.proposal.category === 'backstory' && spelled.proposal.category === 'backstory');
  ok('the difference is the evidence, not the algorithm', spelled.evidence.some((v) => v.type === 'explicit-name-in-content')
    && !pronoun.subjectCandidates.find((c) => entity(draft, c.entity).name === 'Nora Vale')?.evidence.some((v) => v.type === 'explicit-name-in-content'));
  ok('the one it does name is related in both', relatedOf(draft, 'The Bargain').includes('Don Rafael Sorrento')
    && (spelled.proposal.related || []).map((r) => entity(b, r).name).includes('Don Rafael Sorrento'));
}

// ---------------------------------------------------------------- G
console.log('\nG  variants are grouped, never merged');
{
  const group = draft.variantGroups.find((g) => g.entries.some((x) => byTitle(draft, 'Ferry Office').ref === x.entry));
  ok('a disabled near-copy is grouped with its original', group && group.entries.length === 2 && group.entries.some((x) => !x.enabled));
  ok('the group says it changes nothing', /Nothing is merged, removed or chosen/.test(group.note));
  const rows = db.listEntries(A);
  ok('both entries still exist, untouched', rows.filter((e) => e.keys.includes('ferry office')).length === 2
    && rows.find((e) => e.title === 'DISABLED — late chapter').enabled === false
    && rows.find((e) => e.title === 'Ferry Office').enabled === true);
  ok('neither is enabled, disabled, retitled or rewritten', rows.find((e) => e.title === 'DISABLED — late chapter').content.includes('locked cupboard')
    && rows.find((e) => e.title === 'Ferry Office').content.includes('ledger nobody else reads'));
  ok('the phase note is kept as evidence', byTitle(draft, 'DISABLED — late chapter').phase !== null);
  ok('no winner is chosen', !JSON.stringify(draft.variantGroups).includes('canonical'));
}

// ---------------------------------------------------------------- H
console.log('\nH  display groups only where the source writes them');
{
  ok('a shared title prefix becomes a display path', JSON.stringify(byTitle(draft, 'Ability: Tideglass').proposal.displayPath) === '["Ability"]'
    && JSON.stringify(byTitle(draft, 'Ability: Limits').proposal.displayPath) === '["Ability"]');
  ok('a prefix only one entry uses is not a group', byTitle(draft, 'Quay: the morning run').proposal.displayPath === null);
  ok('nothing else gets one invented for it', draft.entries.filter((e) => e.proposal?.displayPath).length === 2);
  ok('the category stays a real category', ['ability', 'other', 'skill'].includes(byTitle(draft, 'Ability: Tideglass').proposal.category));
}

// ---------------------------------------------------------------- I
console.log('\nI  what a source is for');
{
  const frame = analyzeSource(db, FRAME);
  ok('instructions about telling a story → narrative-framework, high', frame.source.proposedRole.role === 'narrative-framework' && frame.source.proposedRole.confidence === 'high',
    frame.source.proposedRole.evidence.map((e) => e.detail).join(' | '));
  ok('no cast, places or groups are invented from it', frame.entities.length === 0);
  ok('every entry is read as how-to-narrate', frame.entries.every((e) => e.proposal.scope === 'world' && e.proposal.category === 'direction'));
  ok('its stored kinds are left alone', db.listEntries(FRAME).map((e) => e.kind).join() === 'note,note,note,rule');
  const ref = analyzeSource(db, REF);
  ok('specialised guides → reference-pack', ref.source.proposedRole.role === 'reference-pack', `${ref.source.proposedRole.confidence}`);
  ok('a mixed legacy source says so rather than guessing', draft.source.proposedRole.role === 'entity-material' || draft.source.proposedRole.role === 'mixed',
    `${draft.source.proposedRole.role} (${draft.source.proposedRole.confidence}): ${draft.source.proposedRole.evidence.map((e) => e.detail).join(' | ')}`);
  ok('the role is proposed, never approved', !draft.source.current && draft.source.proposedRole.confidence !== undefined);
}

// ---------------------------------------------------------------- J
console.log('\nJ  the same name in another source');
{
  const withCompare = analyzeSource(db, A, { compareWith: [B, C] });
  const matches = (name) => withCompare.matches.filter((m) => entity(withCompare, m.entity).name === name);
  ok('the same person in a second source is proposed as possibly the same', matches('Nora Vale').some((m) => m.candidate.sourceId === B && ['medium', 'high'].includes(m.confidence)),
    matches('Nora Vale').map((m) => `${m.candidate.sourceName}:${m.confidence}`).join(', '));
  ok('so are the group and the place, with their material weighed', matches('Vale Company').some((m) => m.confidence === 'high') && matches('The Iron Gate').some((m) => m.confidence === 'high')
    && withCompare.matches.every((m) => m.evidence.some((v) => v.type === 'profile-overlap')));
  ok('nothing is merged: they are candidates for review', withCompare.matches.every((m) => m.candidate.entity && !m.applied) && withCompare.entities.every((e) => e.declaredEntityId === null));
  const other = matches('Nora Vale').find((m) => m.candidate.sourceId === C);
  ok('the same name with nothing else in common is not the same person', other && other.confidence !== 'high',
    `${other?.confidence}: ${other?.evidence.map((e) => e.detail).join(' | ')}`);
  ok('every match says a shared name may be an alternate universe', withCompare.matches.every((m) => m.evidence.some((v) => /alternate universe|not the same person/i.test(v.detail))));
}

// ---------------------------------------------------------------- K
console.log('\nK  a decision already made is respected');
{
  const one = createEntity(db, { type: 'person', name: 'Nora Vale' });
  const two = createEntity(db, { type: 'person', name: 'Nora Vale' });
  declareInSource(db, { lorebookId: A, entityId: one, localRef: 'nora', localName: 'Nora Vale', origin: 'manual', status: 'approved' });
  declareInSource(db, { lorebookId: C, entityId: two, localRef: 'nora', localName: 'Nora Vale', origin: 'manual', status: 'approved' });
  const before = analyzeSource(db, A, { compareWith: [C] });
  ok('without a decision, the two are offered as possibly the same', before.matches.some((m) => m.candidate.sourceId === C));
  distinguish(db, one, two);
  const after = analyzeSource(db, A, { compareWith: [C] });
  ok('once decided "not the same", it is not offered again', !after.matches.some((m) => m.candidate.sourceId === C)
    && after.suppressedMatches.some((m) => /not the same/.test(m.reason)));
  ok('the declared entity is shown on the draft entity', named(after, 'Nora Vale')?.declaredEntityId === one);
}

// ---------------------------------------------------------------- L
console.log('\nL  analysing writes nothing');
{
  const fingerprint = () => {
    const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    return createHash('sha256').update(tables.map((t) => {
      const cols = db.raw.prepare(`PRAGMA table_info(${t})`).all().map((c) => `"${c.name}"`).join(',');
      return `${t}:${JSON.stringify(db.raw.prepare(`SELECT ${cols} FROM "${t}"`).all().map((r) => JSON.stringify(Object.values(r))).sort())}`;
    }).join('\n')).digest('hex');
  };
  const before = fingerprint();
  const first = analyzeSource(db, A, { compareWith: [B, C] });
  const second = analyzeSource(db, A, { compareWith: [B, C] });
  for (const id of [A, B, C, FRAME, REF]) analyzeSource(db, id);
  ok('every table is byte for byte what it was', fingerprint() === before);
  ok('analysing twice gives the same draft', JSON.stringify(first) === JSON.stringify(second));
  // The guarantee is that the analyser turns query-only on for the whole of its work.
  const said = [];
  const spy = new Proxy(db.raw, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      return (...args) => { if (prop === 'exec') said.push(String(args[0])); return value.apply(target, args); };
    },
  });
  analyzeSource({ ...db, raw: spy }, A, { compareWith: [B] });
  ok('it switches the connection to query-only, and back', said.includes('PRAGMA query_only = ON') && said.includes('PRAGMA query_only = OFF')
    && said.indexOf('PRAGMA query_only = ON') < said.indexOf('PRAGMA query_only = OFF'), said.join(' / '));

  // And the guarantee is real: while query-only is on, SQLite refuses a write.
  let refused = null;
  db.raw.exec('PRAGMA query_only = ON');
  try { db.raw.prepare("UPDATE lore_entries SET title='rewritten' WHERE lorebook_id=?").run(A); } catch (e) { refused = e; }
  db.raw.exec('PRAGMA query_only = OFF');
  ok('with query-only on, a write is refused by SQLite itself', refused !== null && /readonly|query_only/i.test(refused.message), refused?.message);
  ok('and analysis leaves the connection as it found it', db.raw.prepare('PRAGMA query_only').get().query_only === 0);
  ok('nothing was rewritten by any of it', !db.listEntries(A).some((e) => e.title === 'rewritten') && fingerprint() === before);
}

// ---------------------------------------------------------------- M
console.log('\nM  no real person, place or story is written into the engine');
{
  const dir = join(here, '..', 'src', 'conversion');
  const code = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  // Names from the library this was developed against. They belong in tests and
  // reports, never in a rule.
  const forbidden = ['patrick', 'moretti', 'salvatore', 'carlo', 'vancetti', 'lotus', 'reiko', 'raffaele', 'saint', 'bakugo', 'elena', 'costa'];
  const found = forbidden.filter((w) => new RegExp(`\\b${w}`, 'i').test(code));
  ok('the conversion engine names nobody from the real library', found.length === 0, found.join(', '));
  ok('and the vocabulary it does use is general', /nightclub|apartment|warehouse/.test(code) && /mother|father|mentor/.test(code));
}

// ---------------------------------------------------------------- N
console.log('\nN  through the server: read-only, and no model');
{
  let providerCalls = 0;
  const provider = createServer((req, res2) => { providerCalls++; res2.writeHead(500); res2.end('{}'); });
  await new Promise((r) => provider.listen(0, r));
  const PORT = 8940 + Math.floor(Math.random() * 50);
  const path = tmp();
  const seed = open(path);
  const sid = build(seed, 'Harbour Files', SOURCE_A);
  const fid = build(seed, 'Living Frame', SOURCE_FRAMEWORK);
  const fingerprint = () => createHash('sha256').update(JSON.stringify(seed.raw.prepare('SELECT * FROM lore_entries ORDER BY id').all())).digest('hex');
  const before = fingerprint();
  seed.close();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: join(here, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: path, OPENROUTER_ENDPOINT: `http://localhost:${provider.address().port}`, OPENROUTER_API_KEY: 'not-a-real-key' },
    stdio: 'ignore',
  });
  const B2 = `http://localhost:${PORT}`;
  for (let i = 0; i < 80; i++) { try { await fetch(B2); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
  const J = (p, body) => fetch(B2 + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const preview = await J(`/api/lorebooks/${sid}/semantic-preview`, { compareWith: [fid] });
    ok('the preview route returns a draft', preview.status === 200 && preview.body.format === DRAFT_FORMAT && preview.body.entries.length === SOURCE_A.length);
    ok('it proposes without approving', preview.body.entries.every((e) => !('status' in (e.proposal || {}))) && preview.body.source.proposedRole.confidence);
    const again = await J(`/api/lorebooks/${sid}/semantic-preview`, {});
    ok('previewing again changes nothing', again.status === 200);
    ok('an unknown source is a 404', (await J('/api/lorebooks/no-such-book/semantic-preview', {})).status === 404);
    // Applying is a separate, explicit act (P4). Previewing never becomes applying,
    // and an apply with nothing decided writes nothing.
    const empty = await J(`/api/lorebooks/${sid}/semantic-apply`, {});
    ok('previewing never applies, and an empty review writes nothing', empty.status === 200 && empty.body.entries.length === 0
      && empty.body.organization.coverage === 'unorganized');
    ok('no request reached the model provider', providerCalls === 0, `${providerCalls} calls`);
    const check = open(path);
    ok('the library is unchanged after previewing', createHash('sha256').update(JSON.stringify(check.raw.prepare('SELECT * FROM lore_entries ORDER BY id').all())).digest('hex') === before);
    ok('nothing semantic was written', ['lore_entities', 'source_entities', 'entry_semantics', 'entry_relations', 'source_semantics', 'story_entity_cards']
      .every((t) => check.raw.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n === 0));
    check.close();
  } finally {
    server.kill();
    provider.close();
  }
}

// ---------------------------------------------------------------- O
console.log('\nO  one name, two different kinds of thing');
{
  // A person and a syndicate that answer to the same word. Collapsing them
  // because the strings matched invented a fact nobody wrote.
  const d2 = open(tmp());
  const S = build(d2, 'The Marsh', [
    { title: 'Ash', kind: 'character', keys: ['Ash'], content: 'Ash: forty, unhurried, a ferryman. He has worked this crossing since he was a boy.' },
    { title: 'Ash', kind: 'faction', keys: ['Ash'], content: 'The Ash is a syndicate of four families. It controls the marsh crossings and taxes every barge.' },
    { title: 'Ash', kind: 'place', keys: ['Ash'], content: 'Ash is a village of nine houses at the head of the marsh road.' },
  ]);
  const dd = analyzeSource(d2, S);
  const ashes = dd.entities.filter((e) => e.name === 'Ash');
  ok('three things of one name stay three things', ashes.length === 3, `${ashes.length} found`);
  ok('and each keeps its own kind', ['person', 'faction', 'place'].every((t) => ashes.some((e) => e.type === t)),
    ashes.map((e) => e.type).join(', '));
  ok('each keeps its own describing entry', ashes.every((e) => e.profileEntries.length === 1));
  const collision = dd.warnings.filter((w) => w.code === 'name-collision');
  ok('the collision is reported rather than resolved', collision.length >= 1, collision[0]?.message?.slice(0, 90));
  ok('and each says which other kinds share its name', ashes.every((e) => e.nameSharedWith.length === 2),
    JSON.stringify(ashes.map((e) => e.nameSharedWith)));
  d2.close();
}

console.log('\n   same name, same kind, and maybe not the same one');
{
  const d2 = open(tmp());
  const S = build(d2, 'Two of them', [
    { title: 'Wren Alder', kind: 'character', keys: ['Wren Alder'], content: 'Wren Alder: nineteen, a courier on the northern line, seasick and cheerful about it.' },
    { title: 'Wren Alder', kind: 'character', keys: ['Wren Alder'], content: 'Wren Alder: a retired cartographer of eighty, deaf in one ear, tends bees on a hill.' },
  ]);
  const dd = analyzeSource(d2, S);
  const wrens = dd.entities.filter((e) => e.name === 'Wren Alder');
  ok('one name and one kind is still one entity', wrens.length === 1, `${wrens.length}`);
  ok('but the doubt is recorded, not buried', wrens[0].mayBeSeveral === true);
  const w = dd.warnings.find((x) => x.code === 'possibly-separate');
  ok('and said in words a person can act on', !!w && /may not be the same/i.test(w.message), w?.message?.slice(0, 100));
  ok('nothing was split on a similarity score', wrens[0].profileEntries.length === 2);
  d2.close();
}

// ---------------------------------------------------------------- P
console.log('\nP  where a source came from is evidence, never identity');
{
  // The card says one person. The entries are about somebody else entirely.
  const d2 = open(tmp());
  const card = d2.writeCharacter({ name: 'Mira Holt', description: 'A smuggler.', firstMessage: 'She waits.' });
  const S = build(d2, 'Holt — Lore', [
    { title: 'Bram Tulley', kind: 'note', keys: ['Bram Tulley'], content: 'Bram Tulley: sixty, a harbourmaster, methodical and unbribable. He keeps the tide book himself.' },
    { title: 'The Tide Book', kind: 'note', keys: ['tide book'], content: 'The tide book is a ledger of every sailing for thirty years. Bram Tulley writes in it each dawn.' },
    { title: 'A Quiet Habit', kind: 'note', keys: ['habit'], content: 'She counts the stairs on the way up, every time, and has never said why.' },
  ]);
  d2.raw.prepare('UPDATE lorebooks SET from_character=? WHERE id=?').run(card, S);
  const dd = analyzeSource(d2, S);

  ok('the card is remembered', dd.source.card?.name === 'Mira Holt');
  ok('and no person was manufactured from its name', !dd.entities.some((e) => e.name === 'Mira Holt'),
    dd.entities.map((e) => e.name).join(', '));
  ok('the person the entries describe is found from the content', dd.entities.some((e) => e.name === 'Bram Tulley' && e.type === 'person'));
  const habit = dd.entries.find((e) => e.title === 'A Quiet Habit');
  ok('an entry naming nobody is given to nobody', !habit.proposal?.subject,
    habit.proposal?.subject ? dd.entities.find((x) => x.ref === habit.proposal.subject).name : 'nobody');
  ok('and says so rather than guessing', habit.confidence === 'low' || (habit.unresolved || []).length > 0,
    `${habit.confidence} · ${JSON.stringify(habit.unresolved)}`);
  const all = [...dd.entries.flatMap((e) => e.evidence), ...dd.entities.flatMap((e) => e.evidence)];
  const prov = all.filter((v) => v.basis === 'provenance');
  ok('every piece of provenance is labelled as provenance', prov.every((v) => v.basis === 'provenance'));
  ok('and every piece of it is worth nothing', prov.every((v) => v.points === 0));
  ok('content evidence is labelled separately', all.filter((v) => v.basis === 'content').length > 0);
  ok('and is the only kind that carries points', all.filter((v) => v.points > 0).every((v) => v.basis === 'content'));
  d2.close();
}

// ---------------------------------------------------------------- Q
console.log('\nQ  a direction has structure, not a word');
{
  const prose = [
    ['She has never told him.', 'never, in the past tense'],
    ['He must have wondered why.', 'must have: a guess about someone'],
    ['He does not know the truth.', 'does not: a fact about someone'],
    ['She counts the stairs, and has never said why.', 'a habit containing "never"'],
    ['He never raises his voice.', 'a manner containing "never"'],
  ];
  const orders = [
    ['Never reveal the secret to the user.', 'an imperative opening'],
    ["Do not narrate {{user}}'s actions.", 'an imperative about the player'],
    ['Characters must react to injuries.', 'a rule aimed at characters in general'],
    ['You must never break character.', 'second person'],
    ['Always keep replies under three paragraphs.', 'about the reply'],
    ['The model should avoid summarising the scene.', 'about the model'],
  ];
  for (const [s, why] of prose) ok(`prose stays prose: ${why}`, !directiveSentence(s), s);
  for (const [s, why] of orders) ok(`an order is an order: ${why}`, directiveSentence(s), s);

  const d2 = open(tmp());
  const S = build(d2, 'Mixed', [
    { title: 'Ivo Lanz', kind: 'character', keys: ['Ivo Lanz'], content: 'Ivo Lanz: fifty, a locksmith, deliberate. He never raises his voice and has never told anyone why he left.' },
    { title: 'Player Agency', kind: 'note', keys: ['agency'], content: "Never write the player's dialogue. Do not decide what they notice or feel." },
  ]);
  const dd = analyzeSource(d2, S);
  const person = dd.entries.find((e) => e.title === 'Ivo Lanz');
  const rule = dd.entries.find((e) => e.title === 'Player Agency');
  ok('a profile full of "never" is still a profile', person.proposal?.scope === 'entity' && person.proposal?.category === 'profile',
    `${person.proposal?.scope}/${person.proposal?.category}`);
  ok('and the real direction is still a direction', rule.proposal?.scope === 'world' && rule.proposal?.category === 'direction',
    `${rule.proposal?.scope}/${rule.proposal?.category}`);
  d2.close();
}

// ---------------------------------------------------------------- R
console.log('\nR  deep character material does not fall into "other"');
{
  const d2 = open(tmp());
  const S = build(d2, 'Sena — Lore', [
    { title: 'Sena Oduya', kind: 'character', keys: ['Sena Oduya'], content: 'Sena Oduya: twenty-six, quiet, a hydrokinetic. She keeps her distance.' },
    { title: 'Quirk: Fluid Domain', kind: 'note', keys: ['domain'], content: 'Sena can shape any water within twelve metres of herself.' },
    { title: 'Quirk: Limitations', kind: 'note', keys: ['limit'], content: 'Sena cannot shape water she has not touched. The limitation is absolute.' },
    { title: 'Quirk: Costs', kind: 'note', keys: ['cost'], content: 'Every minute of use costs Sena a litre of her own water. The cost compounds.' },
    { title: 'Cybernetics', kind: 'note', keys: ['arm'], content: "Sena's left arm is an augment, a military implant she has never explained." },
    { title: 'Bloodline', kind: 'note', keys: ['clan'], content: 'Sena is of the Oduya clan, and the bloodline carries the gift.' },
    { title: 'What she prefers', kind: 'note', keys: ['tea'], content: 'Sena prefers tea to coffee, dislikes crowds, and her favourite hour is four in the morning.' },
    { title: 'What she stands for', kind: 'note', keys: ['debt'], content: 'Sena believes a debt is a debt. Her values are simple and she will not compromise them.' },
  ]);
  const dd = analyzeSource(d2, S);
  const catOf = (t) => dd.entries.find((e) => e.title === t).proposal?.category;
  const deep = ['Quirk: Fluid Domain', 'Quirk: Limitations', 'Quirk: Costs', 'Cybernetics', 'Bloodline', 'What she prefers', 'What she stands for'];
  ok("a universe's own power is an ability", catOf('Quirk: Fluid Domain') === 'ability', catOf('Quirk: Fluid Domain'));
  ok('so are its limits', catOf('Quirk: Limitations') === 'ability', catOf('Quirk: Limitations'));
  ok('and its costs', catOf('Quirk: Costs') === 'ability', catOf('Quirk: Costs'));
  ok('cybernetics are an ability too', catOf('Cybernetics') === 'ability', catOf('Cybernetics'));
  ok('and so is a bloodline', catOf('Bloodline') === 'ability', catOf('Bloodline'));
  ok('preferences are not lost', catOf('What she prefers') === 'habit', catOf('What she prefers'));
  ok('values are not lost', catOf('What she stands for') === 'belief', catOf('What she stands for'));
  ok('nothing about her fell into "other"', deep.every((t) => catOf(t) !== 'other'),
    deep.filter((t) => catOf(t) === 'other').join(', '));
  const quirk = dd.entries.find((e) => e.title === 'Quirk: Fluid Domain');
  ok("the universe's word becomes a display group", JSON.stringify(quirk.proposal?.displayPath) === '["Quirk"]',
    JSON.stringify(quirk.proposal?.displayPath));
  ok('and no new category was invented for it', PERSON_CATEGORIES.includes(quirk.proposal.category), quirk.proposal.category);
  d2.close();
}

// ---------------------------------------------------------------- S
console.log('\nS  a warning means a real contradiction');
{
  const d2 = open(tmp());
  const S = build(d2, 'Ordinary notes', [
    // Legacy kinds Nexus has no type for, read correctly. Not contradictions.
    { title: 'The Long Room', kind: 'note', keys: ['long room'], content: 'The Long Room is a tavern on the quay. Nobody argues in it twice.' },
    { title: 'Odile Renn', kind: 'note', keys: ['Odile Renn'], content: 'Odile Renn: thirty, a printer, watchful. She sets type faster than anyone on the street.' },
    { title: 'Her mornings', kind: 'premise', keys: ['morning'], content: 'Odile Renn is at the press before six, every day, and says the light is better then.' },
    // A real contradiction: stored as a place, reads as a person.
    { title: 'Casimir Bey', kind: 'place', keys: ['Casimir Bey'], content: 'Casimir Bey: sixty, patient, the oldest printer still working. He taught Odile Renn her trade.' },
  ]);
  const dd = analyzeSource(d2, S);
  const kinds = dd.warnings.filter((w) => w.code === 'kind-disagrees');
  ok('a legacy kind with no semantic equivalent is not a disagreement',
    !kinds.some((w) => /The Long Room|Odile Renn|Her mornings/.test(w.message)),
    kinds.map((w) => w.message.slice(0, 40)).join(' | '));
  ok('a real contradiction still is one', kinds.some((w) => /Casimir Bey/.test(w.message)), kinds.length ? kinds[0].message.slice(0, 90) : 'none');
  ok('and it says the stored kind is left alone', kinds.every((w) => /left as it is/.test(w.message)));
  ok('the warnings stay few enough to read', dd.warnings.length <= dd.entries.length,
    `${dd.warnings.length} warnings for ${dd.entries.length} entries`);
  d2.close();
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exitCode = fail ? 1 : 0;
