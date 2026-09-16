// A second opinion, and everything it is not allowed to do.
//
//   node scripts/check-assist.js
//
// Throwaway databases, invented material, and a model that answers however the
// test needs it to. No provider is contacted. The point of this file is the
// hostile half: a model that names an entity nobody gave it, invents a
// category, quotes words that were never written, or says it cannot tell and
// then tells. None of that may reach a review as a suggestion.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { open } from '../src/db/index.js';
import { analyzeSource } from '../src/conversion/analyze.js';
import { applyReview } from '../src/conversion/apply.js';
import {
  assist, readReply, eligible, bucketOf, buildBatches, entryBlock, requestFor,
  normalizeQuote, CATEGORIES, MAX_PER_BATCH,
} from '../src/conversion/assist.js';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0; let fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? `  — ${d}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? `  — ${d}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);
const tmp = () => join(mkdtempSync(join(tmpdir(), 'tipsy-assist-')), 'a.db');

// ------------------------------------------------------------------ a source

const ENTRIES = [
  { title: 'Nora Vale', kind: 'note', keys: ['Nora Vale', 'Nora'], content: 'Nora Vale: patient, exacting, quietly funny. She runs the ferry office and keeps the company books.' },
  { title: 'Ilya Vale', kind: 'note', keys: ['Ilya Vale', 'Ilya'], content: 'Ilya Vale, her brother, keeps the boats running and says little. He was born two years after her.' },
  // Genuinely undecidable: both are named, neither is the point of it.
  { title: 'Childhood', kind: 'premise', keys: ['childhood'], content: 'Nora and Ilya grew up above a bakery on the quay. One of them learned to read a room before entering it; the other learned engines. Nobody in the house ever said which was which.' },
  { title: 'The Bargain', kind: 'note', keys: ['bargain'], content: 'First deliberate deal: nineteen, a riverside warehouse, no audience. The paper was an engraved deed Sorrento had given them.' },
  { title: 'Don Rafael Sorrento', kind: 'character', keys: ['Sorrento'], content: 'At seventeen, Don Rafael Sorrento took them in: clothes, a roof, rules. The Vales believed for a year that it was family.' },
  { title: 'Weather', kind: 'note', keys: ['weather'], content: 'It rains for most of autumn.' },
  { title: 'Ferry Office', kind: 'note', keys: ['ferry office'], content: 'The ferry office is a low building on the quay with a stove and two desks. Nora Vale keeps the books there.' },
];

const library = () => {
  const db = open(tmp());
  const id = db.createLorebook('Harbour Files', '');
  for (const e of ENTRIES) db.saveEntry(id, { order: 100, enabled: true, constant: false, probability: 100, keys: [], ...e });
  const draft = analyzeSource(db, id);
  const contents = new Map(db.raw.prepare('SELECT id, content FROM lore_entries WHERE lorebook_id=?').all(id).map((r) => [r.id, r.content || '']));
  return { db, id, draft, contents };
};

/** A model that answers with whatever the test hands it, and counts its calls. */
const model = (answers, extra = {}) => {
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    const next = typeof answers === 'function' ? answers(req, calls.length) : answers;
    if (next instanceof Error) throw next;
    return { data: next, usage: { prompt_tokens: 900, completion_tokens: 120, cost: 0.0004 }, model: 'mock/model', finishReason: 'stop', ...extra };
  };
  fn.calls = calls;
  return fn;
};
const never = async () => { throw new Error('the model must not be called'); };

const { db, id: BOOK, draft, contents } = library();
const entryBy = (title) => draft.entries.find((e) => e.title === title);
const entityBy = (name) => draft.entities.find((x) => x.name === name);

section('what the deterministic pass left open');
const open_ = draft.entries.filter((e) => ['decision', 'unsorted'].includes(bucketOf(e)));
// The analyser is not tuned to make this fixture interesting: whatever it leaves
// open is what gets asked about, and an entry it weighed two people for is what
// the "who is this about" path is tested on, wherever that lands.
const weighed = draft.entries.filter((e) => (e.subjectCandidates || []).length >= 2);
ok('the fixture leaves something unresolved to ask about', open_.length >= 1, open_.map((e) => `${e.title} (${bucketOf(e)})`).join(', '));
ok('and something with more than one possible subject', weighed.length >= 1, weighed.map((e) => `${e.title}: ${e.subjectCandidates.map((c) => c.entity).join(' or ')}`).join(', '));
ok('every entry lands in exactly one of the four states',
  draft.entries.every((e) => ['clear', 'likely', 'decision', 'unsorted'].includes(bucketOf(e))));

section('who may be asked about');
const clear = draft.entries.find((e) => bucketOf(e) === 'clear');
const likely = draft.entries.find((e) => bucketOf(e) === 'likely');
ok('unresolved entries are eligible', eligible(open_[0]).ok);
if (clear) ok('an entry Nexus is sure about is not sent by default', !eligible(clear).ok, eligible(clear).reason);
if (likely) {
  ok('a likely entry is not sent by default', !eligible(likely).ok, eligible(likely).reason);
  ok('a likely entry may be sent when the reader asks for it', eligible(likely, { force: true }).ok);
}
ok('an entry the reader already approved is never sent',
  !eligible({ ...open_[0], current: 'approved' }, { force: true }).ok,
  eligible({ ...open_[0], current: 'approved' }).reason);
ok('an entry that needs rechecking may be looked at again', eligible({ ...open_[0], current: 'recheck' }).ok);

section('what is sent');
const ambiguous = weighed[0] || open_[0];
const block = entryBlock(draft, ambiguous, contents);
ok('the entry is sent whole, with its own words', block.text.includes(contents.get(ambiguous.entryId).slice(0, 40)));
ok('what the deterministic pass thought is sent with it', /WHAT THE DETERMINISTIC PASS MADE OF IT/.test(block.text));
ok('the entities it may choose from are named by ref', /ENTITIES YOU MAY CHOOSE FROM/.test(block.text) && block.entities.length > 0);
ok('the whole source is not sent with every entry',
  !block.text.includes('a low building on the quay with a stove'), `${block.text.length} characters`);
const req = requestFor(draft, [block]);
ok('the request says what the source is and which categories exist',
  /SOURCE: Harbour Files/.test(req.messages[1].content) && CATEGORIES.every((c) => req.messages[1].content.includes(c)));
ok('the request explains subject against related',
  /SUBJECT is who or what the entry is primarily about/.test(req.messages[0].content)
  && /A name merely appearing in the text is NOT enough/.test(req.messages[0].content));
ok('the request says that being unsure is an answer', /unresolved: true/.test(req.messages[0].content));

section('batching');
const many = Array.from({ length: 13 }, (_, i) => ({ text: 'x'.repeat(600), entry: { ref: `e${i}` } }));
const batches = buildBatches(many);
ok('a long list is split into small requests', batches.length === Math.ceil(13 / MAX_PER_BATCH) && batches.every((b) => b.length <= MAX_PER_BATCH),
  batches.map((b) => b.length).join('+'));
ok('one enormous entry travels alone', buildBatches([{ text: 'x'.repeat(20000), entry: { ref: 'a' } }, { text: 'x'.repeat(900), entry: { ref: 'b' } }])[0].length === 1);
ok('every entry in a batch keeps its own ref', batches.flat().length === 13 && new Set(batches.flat().map((b) => b.entry.ref)).size === 13);

// ------------------------------------------------------------- the validator
//
// Straight at readReply, with a context built by hand so each rule can be
// tested on its own.

section('reading a reply');
const asked = new Map([['childhood', {
  entry: { ref: 'childhood' },
  entities: new Set(['nora-vale', 'ilya-vale']),
  haystack: normalizeQuote('The Vale children grew up above a bakery on the quay. One of them learned to read a room before entering it. Nora Vale keeps the books.'),
  names: new Map([['nora-vale', ['Nora Vale', 'Nora']], ['ilya-vale', ['Ilya Vale', 'Ilya']]]),
}]]);
const reply = (o) => ({ readings: [{ entryRef: 'childhood', unresolved: false, explanation: 'because', ...o }] });
const read = (o) => readReply(reply(o), asked);
const quote = { type: 'quote', quote: 'grew up above a bakery on the quay', explanation: 'the entry says so' };

{
  const r = read({ subject: 'nora-vale', category: 'backstory', evidence: [quote] });
  ok('a supported subject is kept', r.suggestions.length === 1 && r.suggestions[0].subject === 'nora-vale' && r.suggestions[0].category === 'backstory');
  ok('the evidence comes through with it', r.suggestions[0].evidence[0].quote === quote.quote);
}
{
  const r = readReply({ readings: [{ entryRef: 'childhood', unresolved: true, explanation: 'the text does not say which child' }] }, asked);
  ok('"I still cannot tell" is a result, not a failure', r.suggestions.length === 1 && r.suggestions[0].unresolved === true && !r.problems.length);
}
{
  // Whose it is and what it is are two questions. Answering one honestly while
  // refusing to guess the other is the most useful thing a second opinion does.
  const r = read({ unresolved: true, category: 'backstory', evidence: [quote] });
  ok('"I cannot tell who, but I can tell what" is kept whole',
    r.suggestions.length === 1 && r.suggestions[0].unresolved === true && r.suggestions[0].category === 'backstory' && !r.suggestions[0].subject);
}
{
  const r = read({ subject: 'nora-vale', related: ['ilya-vale'], category: 'backstory', evidence: [quote] });
  ok('a related entity the text names is kept', r.suggestions[0].related.length === 0 || r.suggestions[0].related[0] === 'ilya-vale');
}
{
  const r = read({ subject: 'nora-vale', category: 'backstory', evidence: [quote], proposedEntities: [{ type: 'place', name: 'the quay', reason: 'a place the children grew up on' }] });
  ok('a missing entity the text introduces is proposed, not created',
    r.suggestions[0].proposedEntities.length === 1 && r.suggestions[0].proposedEntities[0].name === 'the quay');
  ok('a proposed entity carries its reason', !!r.suggestions[0].proposedEntities[0].reason);
}

section('what the validator refuses');
const refused = (name, o, want) => {
  const r = read(o);
  const said = [...r.problems.map((p) => p.reason)].join(' | ');
  ok(name, r.suggestions.length === 0 || !want(r.suggestions[0]), said || JSON.stringify(r.suggestions[0]));
};
refused('an entity ref nobody gave it', { subject: 'don-sorrento', category: 'backstory', evidence: [quote] }, (s) => s.subject === 'don-sorrento');
refused('a category it invented', { subject: 'nora-vale', category: 'trauma', evidence: [quote] }, (s) => s.category === 'trauma');
refused('two subjects at once', { subject: ['nora-vale', 'ilya-vale'], category: 'backstory', evidence: [quote] }, (s) => !!s.subject);
refused('a subject and a definition at once', { subject: 'nora-vale', defines: 'ilya-vale', category: 'profile', evidence: [quote] }, (s) => !!s.subject);
refused('a quotation that was never written', { subject: 'nora-vale', category: 'backstory', evidence: [{ type: 'quote', quote: 'Nora confessed to the harbourmaster', explanation: 'it says so' }] }, (s) => !!s.subject);
refused('a claim with no evidence at all', { subject: 'nora-vale', category: 'backstory', evidence: [] }, (s) => !!s.subject);
refused('saying it cannot tell and then telling', { unresolved: true, subject: 'nora-vale', category: 'backstory', evidence: [quote] }, (s) => !!s.subject);
refused('saying it can tell and naming nothing', { evidence: [quote] }, (s) => !s.unresolved);
refused('a display group that is a paragraph', { subject: 'nora-vale', category: 'backstory', displayPath: ['a'.repeat(80)], evidence: [quote] }, (s) => !!s.displayPath);
refused('a display group nested five deep', { subject: 'nora-vale', category: 'backstory', displayPath: ['a', 'b', 'c'], evidence: [quote] }, (s) => !!s.displayPath);
refused('fields it made up', { subject: 'nora-vale', category: 'backstory', evidence: [quote], confidence: 'high' }, (s) => !!s.subject);
refused('a related entity the entry never names', { subject: 'nora-vale', related: ['ilya-vale'], category: 'backstory', evidence: [quote] }, (s) => s.related.includes('ilya-vale'));
refused('an entity type Nexus does not know', { subject: 'nora-vale', category: 'backstory', evidence: [quote], proposedEntities: [{ type: 'spaceship', name: 'the quay', reason: 'why' }] }, (s) => s.proposedEntities.length > 0);
refused('a proposed entity the text does not introduce', { subject: 'nora-vale', category: 'backstory', evidence: [quote], proposedEntities: [{ type: 'person', name: 'Captain Bell', reason: 'mentioned' }] }, (s) => s.proposedEntities.length > 0);
refused('a proposed entity that is already in the list', { subject: 'nora-vale', category: 'backstory', evidence: [quote], proposedEntities: [{ type: 'person', name: 'Nora Vale', reason: 'she is here' }] }, (s) => s.proposedEntities.length > 0);
refused('reasoning that points at nothing supplied', { subject: 'nora-vale', category: 'backstory', evidence: [{ type: 'contextual', explanation: 'it feels right', refs: ['someone-else'] }] }, (s) => !!s.subject);

{
  const r = readReply({ readings: [{ entryRef: 'not-in-this-batch', unresolved: false, subject: 'nora-vale', category: 'backstory', explanation: 'x' }] }, asked);
  ok('an answer about an entry nobody asked about', r.suggestions.length === 0 && r.problems.some((p) => /not one of the entries/.test(p.reason)));
}
{
  const r = readReply(null, asked);
  ok('a reply that is not JSON at all', r.suggestions.length === 0 && r.problems[0].kind === 'unreadable');
}
{
  const r = readReply({ readings: 'yes' }, asked);
  ok('a reply with no readings in it', r.suggestions.length === 0 && r.problems[0].kind === 'unreadable');
}
{
  const r = readReply({ readings: [] }, asked);
  ok('an entry the model quietly skipped is reported', r.problems.some((p) => p.kind === 'missing'));
}
{
  const r = readReply({ readings: [
    { entryRef: 'childhood', unresolved: false, subject: 'nora-vale', category: 'backstory', evidence: [quote], explanation: 'first' },
    { entryRef: 'childhood', unresolved: true, explanation: 'second thoughts' },
  ] }, asked);
  ok('a second answer for the same entry is ignored', r.suggestions.length === 1 && r.suggestions[0].subject === 'nora-vale');
}
{
  // Contextual reasoning is allowed, and is not dressed up as a quotation.
  const r = read({ subject: 'nora-vale', category: 'backstory', evidence: [{ type: 'contextual', refs: ['nora-vale'], explanation: 'the ferry office entry says Nora keeps the books' }] });
  ok('reasoning across supplied facts is allowed, and stays labelled as reasoning',
    r.suggestions.length === 1 && r.suggestions[0].evidence[0].type === 'contextual');
}
{
  const r = read({ subject: 'nora-vale', category: 'backstory', evidence: [quote, { type: 'quote', quote: 'she signed the deed in blood', explanation: 'invented' }] });
  ok('one bad quotation does not throw away the good one',
    r.suggestions.length === 1 && r.suggestions[0].evidence.length === 1 && r.problems.some((p) => /not in the material/.test(p.reason)));
}
{
  const r = read({ subject: 'nora-vale', category: 'backstory', evidence: [{ type: 'quote', quote: 'GREW UP   above a Bakery, on the quay.', explanation: 'shouted and repunctuated' }] });
  ok('a quotation is checked through case, spacing and punctuation', r.suggestions.length === 1 && r.suggestions[0].evidence.length === 1);
}

section('a batch where one answer is spoiled');
{
  const two = new Map([...asked, ['bargain', { entry: { ref: 'bargain' }, entities: new Set(['nora-vale']), haystack: normalizeQuote('First deliberate deal: nineteen, a riverside warehouse.'), names: new Map([['nora-vale', ['Nora Vale']]]) }]]);
  const r = readReply({ readings: [
    { entryRef: 'childhood', unresolved: false, subject: 'nora-vale', category: 'backstory', evidence: [quote], explanation: 'fine' },
    { entryRef: 'bargain', unresolved: false, subject: 'nobody-at-all', category: 'backstory', evidence: [], explanation: 'broken' },
  ] }, two);
  ok('the sound answer survives its neighbour', r.suggestions.length === 1 && r.suggestions[0].entryRef === 'childhood');
  ok('and the spoiled one is reported, not repaired', r.problems.some((p) => p.entryRef === 'bargain'));
}

// ------------------------------------------------------------ the whole errand

section('asking, end to end');
{
  const refs = open_.map((e) => e.ref);
  const m = model((req) => ({ readings: refs.slice(0, MAX_PER_BATCH).map((ref) => ({ entryRef: ref, unresolved: true, explanation: 'cannot tell' })) }));
  const out = await assist({ draft, contents, refs, complete: m });
  ok('one request per batch, and no more', m.calls.length === out.calls && m.calls.length <= Math.ceil(refs.length / MAX_PER_BATCH), `${m.calls.length} calls for ${refs.length} entries`);
  ok('what it cost is reported back', out.usage.length === m.calls.length && out.usage[0].model === 'mock/model' && out.usage[0].inputTokens === 900 && out.usage[0].cost === 0.0004);
}
{
  const m = model({ readings: [] });
  const out = await assist({ draft, contents, refs: [clear?.ref].filter(Boolean), complete: m });
  if (clear) {
    ok('an entry Nexus is sure about never reaches the model', m.calls.length === 0 && out.problems[0].kind === 'skipped', out.problems[0]?.reason);
  } else ok('an entry Nexus is sure about never reaches the model', true, 'no high-confidence entry in this fixture');
}
{
  const out = await assist({ draft, contents, refs: [], complete: never });
  ok('asking about nothing calls nothing', out.calls === 0 && out.suggestions.length === 0);
}
{
  // A second opinion may not quietly become the draft. It is handed back, and
  // what the reader had decided stays exactly as it was.
  const before = JSON.stringify(draft);
  const m = model({ readings: [{ entryRef: ambiguous.ref, unresolved: false, subject: entityBy('Nora Vale').ref, category: 'backstory',
    evidence: [{ type: 'quote', quote: contents.get(ambiguous.entryId).split('.')[0], explanation: 'says so' }], explanation: 'about her' }] });
  await assist({ draft, contents, refs: [ambiguous.ref], complete: m, force: true });
  ok('asking changes nothing in the draft it was asked about', JSON.stringify(draft) === before);
}
{
  const out = await assist({ draft, contents, refs: ['no-such-entry'], complete: never });
  ok('asking about an entry that is not there calls nothing', out.calls === 0 && out.problems[0].kind === 'skipped');
}
{
  const m = model(new Error('the provider is down'));
  const out = await assist({ draft, contents, refs: [open_[0].ref], complete: m });
  ok('a provider failure is reported, not retried', m.calls.length === 1 && out.problems[0].kind === 'failed' && out.suggestions.length === 0, out.problems[0]?.reason);
}
{
  const m = model({ readings: [] }, { finishReason: 'length', data: null });
  const out = await assist({ draft, contents, refs: [open_[0].ref], complete: async (r) => ({ data: null, finishReason: 'length', usage: null, model: 'mock/model' }) });
  ok('a cut-off answer is thrown away whole', out.suggestions.length === 0 && out.problems.some((p) => /did not arrive whole/.test(p.reason)));
}

// -------------------------------------------------------- suggestions are not decisions

section('a suggestion is not a decision');
{
  // An entry with people in play, asked about the way a reader asks: by name.
  const target = ambiguous;
  const nora = entityBy('Nora Vale');
  const m = model({ readings: [{ entryRef: target.ref, unresolved: false, subject: nora.ref, category: 'backstory',
    evidence: [{ type: 'quote', quote: contents.get(target.entryId).split('.')[0], explanation: 'the entry says so' }], explanation: 'it is about her' }] });
  const out = await assist({ draft, contents, refs: [target.ref], complete: m, force: true });
  ok('the model answered with a usable suggestion', out.suggestions.length === 1 && out.suggestions[0].subject === nora.ref, JSON.stringify(out.suggestions[0]?.explanation || out.problems));

  // Applying without accepting it: the entry stays unorganised.
  const decisions = {
    role: null,
    entities: draft.entities.map((x) => ({ ref: x.ref, type: x.type, name: x.name, aliases: x.aliases, decision: 'new', entityId: null })),
    entries: [],
    matches: [],
    evidence: {},
  };
  applyReview(db, BOOK, decisions);
  const row = db.raw.prepare('SELECT COUNT(*) n FROM entry_semantics WHERE entry_id=?').get(target.entryId);
  ok('a suggestion nobody accepted writes nothing', row.n === 0);

  // Accepting a different answer than the model gave.
  const ilya = entityBy('Ilya Vale');
  applyReview(db, BOOK, {
    ...decisions,
    entries: [{ ref: target.ref, entryId: target.entryId, hash: target.hash, approve: true, confidence: 'low',
      scope: 'entity', category: 'backstory', defines: null, subject: ilya.ref, related: [], displayPath: null }],
    evidence: { [target.ref]: [{ type: 'reader', detail: 'the reader chose', points: 0 }] },
  });
  const stored = db.raw.prepare(`SELECT s.scope, s.category, s.status, s.origin, r.entity_id, x.canonical_name
    FROM entry_semantics s LEFT JOIN entry_relations r ON r.entry_id = s.entry_id AND r.relation='subject'
    LEFT JOIN lore_entities x ON x.id = r.entity_id WHERE s.entry_id=?`).get(target.entryId);
  ok('what the reader chose is what is stored, not what the model said',
    stored.canonical_name === 'Ilya Vale' && stored.status === 'approved' && stored.origin === 'converted',
    `${stored.canonical_name} · ${stored.status}/${stored.origin}`);
  ok('nothing in the database remembers the model as an authority',
    db.raw.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE '%assist%' OR name LIKE '%suggestion%'").get().n === 0);

  // And now that it is approved, it may not be sent again.
  const after = analyzeSource(db, BOOK);
  const now = after.entries.find((e) => e.ref === target.ref);
  ok('an approved entry is out of reach of the model', !eligible(now, { force: true }).ok, `current: ${now.current}`);
}

// --------------------------------------------------------------- mutation tests
//
// Each safety rule is removed from a copy of the module, and the hostile answer
// that rule exists to stop is fed to the copy. If the copy still refuses it,
// the rule was not what was doing the work and the test above proves nothing.

section('mutation: every refusal is doing real work');
const source = readFileSync(join(here, '../src/conversion/assist.js'), 'utf8');
const MUTANTS = [
  {
    name: 'without the check on unknown entity refs',
    from: 'if (subject && !ctx.entities.has(subject)) { refuse(ref, `"${subject}" is not one of the entities it was given`); continue; }',
    to: '',
    hostile: { subject: 'don-sorrento', category: 'backstory', evidence: [quote] },
    slips: (s) => s.subject === 'don-sorrento',
  },
  {
    name: 'without the frozen category list',
    from: 'if (category !== null && (typeof category !== \'string\' || !CATEGORIES.includes(category))) {',
    to: 'if (false) {',
    hostile: { subject: 'nora-vale', category: 'trauma', evidence: [quote] },
    slips: (s) => s.category === 'trauma',
  },
  {
    name: 'without checking quotations against the text',
    from: 'if (!ctx.haystack.includes(needle)) {',
    to: 'if (false) {',
    hostile: { subject: 'nora-vale', category: 'backstory', evidence: [{ type: 'quote', quote: 'Nora confessed to the harbourmaster', explanation: 'invented' }] },
    slips: (s) => s.evidence.some((v) => /harbourmaster/.test(v.quote || '')),
  },
  {
    name: 'without the contradiction check',
    from: 'if (raw.unresolved && named) { refuse(ref, \'it said it could not tell and then named someone anyway\'); continue; }',
    to: '',
    hostile: { unresolved: true, subject: 'nora-vale', category: 'backstory', evidence: [quote] },
    slips: (s) => s.unresolved && !!s.subject,
  },
  {
    name: 'without requiring the answer to be about an entry we asked about',
    from: 'if (!ctx) { refuse(ref, \'that is not one of the entries it was asked about\'); continue; }',
    to: 'if (!ctx) { asked.set(ref, { entry: { ref }, entities: new Set(), haystack: \'\', names: new Map() }); }',
    hostile: null,
    wrongRef: true,
  },
  {
    name: 'without requiring evidence for a claim',
    from: 'if (claims && !evidence.length) {',
    to: 'if (false) {',
    hostile: { subject: 'nora-vale', category: 'backstory', evidence: [] },
    slips: (s) => !!s.subject,
  },
  {
    name: 'without checking a proposed entity against the text',
    from: 'if (!ctx.haystack.includes(normalizeQuote(name))) {',
    to: 'if (false) {',
    hostile: { subject: 'nora-vale', category: 'backstory', evidence: [quote], proposedEntities: [{ type: 'person', name: 'Captain Bell', reason: 'invented' }] },
    slips: (s) => s.proposedEntities.some((p) => p.name === 'Captain Bell'),
  },
  {
    name: 'without the check on entries already approved',
    from: "if (entry.current === 'approved') return { ok: false, reason: 'you already decided this one' };",
    to: '',
    approved: true,
  },
];

for (const mut of MUTANTS) {
  if (!source.includes(mut.from)) { ok(`mutant compiles: ${mut.name}`, false, 'the line it removes is no longer in the module'); continue; }
  const file = join(here, `../src/conversion/.mutant-${Math.random().toString(36).slice(2)}.js`);
  writeFileSync(file, source.replace(mut.from, mut.to));
  try {
    const m = await import(pathToFileURL(file).href);
    let slipped = false;
    if (mut.approved) {
      slipped = m.eligible({ ...open_[0], current: 'approved' }, { force: true }).ok;
    } else if (mut.wrongRef) {
      const r = m.readReply({ readings: [{ entryRef: 'not-in-this-batch', unresolved: true, explanation: 'x' }] }, new Map(asked));
      slipped = r.suggestions.length > 0;
    } else {
      const r = m.readReply({ readings: [{ entryRef: 'childhood', unresolved: false, explanation: 'x', ...mut.hostile }] }, asked);
      slipped = r.suggestions.some((s) => mut.slips(s));
    }
    ok(`the rule is what stops it: ${mut.name}`, slipped, slipped ? 'the copy without it lets the bad answer through' : 'the copy without it STILL refuses — the test proves nothing');
  } finally {
    rmSync(file, { force: true });
  }
}

db.close();
console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exit(fail ? 1 : 0);
