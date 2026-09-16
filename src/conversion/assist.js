// A second opinion on the entries the deterministic pass could not settle.
//
// P3 is still the analyser. This asks a model to look again at the few entries
// P3 left open, and hands back SUGGESTIONS for the review draft — never
// semantics. Nothing here writes to the database, and nothing here ticks a
// decision: a suggestion becomes an approved reading only when a person accepts
// it in the review and saves it through P4.
//
// The model is allowed to say it still cannot tell. That is a good answer, and
// the validator treats it as one.
//
// Everything that comes back is checked against what was sent: the entry it
// claims to be about, the entity refs it may choose from, the frozen category
// vocabulary, and — for anything it calls a quotation — the supplied text
// itself. A claim that fails a check is rejected, never repaired by guessing
// what the model meant.

import { ENTITY_TYPES } from '../semantics/authority.js';

/**
 * The parts of a reading, each settled or left open on its own.
 *
 * A second opinion is rarely all or nothing: "it is backstory, but I cannot
 * tell whose" is a real answer, and so is "it is about her, but I cannot tell
 * what kind of thing it is". Each part is validated against what was sent
 * independently of the others.
 */
export const DIMENSIONS = ['category', 'subject', 'defines', 'related', 'displayPath'];

/** The categories an entry may be filed under. Frozen: the model picks from these or nothing. */
export const CATEGORIES = [
  'identity', 'appearance', 'personality', 'speech', 'behavior', 'backstory',
  'psychology', 'relationship', 'secret', 'goal',
  'skill', 'ability', 'equipment', 'belief', 'habit',
  'background', 'rule', 'event', 'item', 'direction', 'reference',
  'profile', 'other',
];

/** What a person is told a category means, so "quirk" arrives as "ability". */
const CATEGORY_HELP = {
  identity: 'who they are, names, age, standing', appearance: 'how they look', personality: 'what they are like',
  speech: 'how they talk', behavior: 'how they act', backstory: 'what happened to them before now',
  psychology: 'inner life, wounds, fears', relationship: 'how they stand with someone else',
  secret: 'something hidden', goal: 'what they want', skill: 'something learned', ability: 'a power or knack',
  equipment: 'what they carry', belief: 'what they hold to be true', habit: 'what they do routinely',
  background: 'world or setting information', rule: 'how the world works', event: 'something that happens',
  item: 'a thing in the world', direction: 'an instruction about how to narrate',
  reference: 'specialised knowledge to draw on when it comes up',
  profile: 'the entry that introduces a person, place or group',
  other: 'none of these',
};

// Batch sizes come from the real sources: an unresolved entry is typically
// 200-800 characters of content, and its P3 context roughly doubles that. Six
// of those sit near 2,500 tokens of input, which is small enough to stay cheap
// and large enough that a person is not waiting through twenty round trips.
export const MAX_PER_BATCH = 6;
export const CHAR_BUDGET = 9000;
/** Rough and deliberately pessimistic; only used to decide where a batch ends. */
export const tokensIn = (s) => Math.ceil(String(s).length / 4);

const settled = (p) => !p || p.scope !== 'entity' || !!p.subject || !!p.defines;

/**
 * Which of the four states an entry is in, read the same way the review reads it.
 * Kept here so eligibility does not depend on the client agreeing.
 */
export function bucketOf(e) {
  if (!e.proposal) return 'unsorted';
  const many = (e.subjectCandidates || []).length >= 2;
  if (!settled(e.proposal)) return many ? 'decision' : 'unsorted';
  if (e.confidence === 'high') return 'clear';
  if (e.confidence === 'medium') return 'likely';
  return many ? 'decision' : 'unsorted';
}

/**
 * Whether an entry may be sent at all.
 *
 * Unresolved material is what this is for. A likely reading may be looked at
 * again, but only because someone asked. Anything already approved is left
 * alone — a second opinion cannot overrule a decision already made — unless it
 * needs rechecking, where the old reading stays visible either way.
 */
export function eligible(entry, { force = false } = {}) {
  if (!entry) return { ok: false, reason: 'that entry is not in this draft' };
  if (entry.current === 'approved') return { ok: false, reason: 'you already decided this one' };
  const bucket = bucketOf(entry);
  if (bucket === 'decision' || bucket === 'unsorted') return { ok: true, bucket };
  if (bucket === 'likely') {
    return force ? { ok: true, bucket } : { ok: false, bucket, reason: 'Nexus already has a suggestion for this one' };
  }
  return { ok: false, bucket, reason: 'Nexus is already sure about this one' };
}

// ------------------------------------------------------------------ context

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * The entities worth putting in front of the model for one entry: the ones P3
 * weighed, the ones it already links, and anyone the text names. Never the
 * whole source.
 */
function inventoryFor(draft, entry, text) {
  const byRef = new Map(draft.entities.map((x) => [x.ref, x]));
  const picked = new Map();
  const add = (ref) => { const x = byRef.get(ref); if (x) picked.set(ref, x); };
  for (const c of entry.subjectCandidates || []) add(c.entity);
  for (const r of entry.proposal?.related || []) add(r);
  if (entry.proposal?.subject) add(entry.proposal.subject);
  if (entry.proposal?.defines) add(entry.proposal.defines);
  if (draft.stats?.dominant) add(draft.stats.dominant);
  // Anyone the entry actually names, whatever P3 made of them.
  const hay = ` ${text.toLowerCase()} `;
  for (const x of draft.entities) {
    if (picked.size >= 10) break;
    const names = [x.name, ...(x.aliases || [])].filter((n) => n && n.length > 2);
    if (names.some((n) => hay.includes(` ${n.toLowerCase()}`))) picked.set(x.ref, x);
  }
  return [...picked.values()].slice(0, 10);
}

/** One entry as the model sees it: itself, what P3 made of it, and who is available. */
export function entryBlock(draft, entry, contents) {
  const content = String(contents.get(entry.entryId) ?? '');
  const p = entry.proposal || {};
  const entities = inventoryFor(draft, entry, `${entry.title} ${content}`);
  const variants = (draft.variantGroups || [])
    .filter((g) => g.entries.some((x) => x.entry === entry.ref))
    .flatMap((g) => g.entries.filter((x) => x.entry !== entry.ref).map((x) => draft.entries.find((e) => e.ref === x.entry)?.title))
    .filter(Boolean);

  // Every piece of text the model is allowed to quote from, and nothing else.
  const supplied = [entry.title, content, (entry.activation?.keys || []).join(' ')];

  const lines = [];
  lines.push(`ENTRY ${entry.ref}`);
  lines.push(`title: ${entry.title}`);
  lines.push(`stored in the original file as: ${entry.storedKind}`);
  if (entry.activation?.keys?.length) lines.push(`keywords: ${entry.activation.keys.slice(0, 10).join(', ')}`);
  lines.push(`switched on: ${entry.activation?.enabled ? 'yes' : 'no'}${entry.phase ? ` · marked ${clip(entry.phase, 40)}` : ''}`);
  lines.push('content:');
  lines.push(content);
  lines.push('');
  lines.push('WHAT THE DETERMINISTIC PASS MADE OF IT');
  lines.push(`reading: scope ${p.scope || 'none'}, category ${p.category || 'none'}, subject ${p.subject || 'none'}, defines ${p.defines || 'none'}, related ${(p.related || []).join(', ') || 'none'}`);
  lines.push(`confidence: ${entry.confidence || 'none'}`);
  if (entry.unresolved?.length) lines.push(`why it is open: ${entry.unresolved.join('; ')}`);
  if (entry.evidence?.length) lines.push(`evidence it used: ${entry.evidence.slice(0, 5).map((v) => clip(v.detail, 120)).join(' | ')}`);
  if ((entry.subjectCandidates || []).length) {
    lines.push(`subjects it weighed: ${entry.subjectCandidates.map((c) => `${c.entity} (${draft.entities.find((x) => x.ref === c.entity)?.name || '?'}, ${c.points} points)`).join(', ')}`);
  }
  if (variants.length) lines.push(`other entries that look like versions of this one: ${variants.slice(0, 4).map((t) => clip(t, 60)).join(' | ')}`);
  lines.push('');
  lines.push('ENTITIES YOU MAY CHOOSE FROM (use the ref, not the name)');
  for (const x of entities) {
    const profile = (x.profileEntries || []).map((ref) => draft.entries.find((e) => e.ref === ref)).find(Boolean);
    const excerpt = profile ? clip(contents.get(profile.entryId) || '', 160) : '';
    if (excerpt) supplied.push(excerpt);
    lines.push(`- ${x.ref} · ${x.name} · ${x.type}${x.aliases?.length ? ` · also called ${x.aliases.slice(0, 4).join(', ')}` : ''}${excerpt ? ` · from its own entry: "${excerpt}"` : ''}`);
  }
  if (!entities.length) lines.push('- (none: this source names nobody this entry could be about)');
  return { text: lines.join('\n'), supplied: supplied.join('\n'), entities: entities.map((x) => x.ref) };
}

/** Entries grouped into requests small enough to be cheap and independent. */
export function buildBatches(blocks, { maxPerBatch = MAX_PER_BATCH, charBudget = CHAR_BUDGET } = {}) {
  const batches = [];
  let current = [];
  let chars = 0;
  for (const b of blocks) {
    const size = b.text.length;
    if (current.length && (current.length >= maxPerBatch || chars + size > charBudget)) {
      batches.push(current); current = []; chars = 0;
    }
    current.push(b); chars += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

const SYSTEM = [
  'You are helping organise an existing roleplay lore file. You are a second opinion: a deterministic pass already read these entries and could not settle them.',
  '',
  'For each entry, say what it is ABOUT and what KIND of information it is — or say you cannot tell.',
  '',
  'SUBJECT is who or what the entry is primarily about: remove them and the entry has no reason to exist.',
  'RELATED are entities meaningfully involved without the entry being about them. A name merely appearing in the text is NOT enough to make someone related, and never enough to make them the subject.',
  'DEFINES is for an entry that introduces an entity — its own profile — rather than saying something about it. Such an entry may give the same ref as both defines and subject, because a profile is about the one it introduces; it must never give different refs for the two. Whatever it belongs to or sits inside goes in related.',
  '',
  'ANSWER EACH PART SEPARATELY. What kind of information an entry holds, who it is about, who else is involved and how it is grouped are different questions. Settle the ones the material settles, and for the rest put their names in unresolvedFields (any of: category, subject, defines, related, displayPath), leave those fields null or empty, and set unresolved to true. "It is backstory, but I cannot tell whose" is a good answer. So is "it is about her, but I cannot tell what kind of thing it is".',
  '',
  'AN ENTRY MAY BE ABOUT NOBODY. World description, rules and instructions for the narrator have no subject: subject null with unresolved false is a complete answer, not a failure. Do not reach for a person to fill the field.',
  '',
  'Rules you must follow:',
  '- Choose entities by the ref you were given (for example "person-1"), never by name alone. Refs you were not given do not exist.',
  '- Choose a category only from the list you are given. Do not invent categories: a universe\'s own word ("quirk", "trauma", "magic") maps onto the closest given category, and may be offered separately as a display group.',
  '- Every claim needs evidence. A "quote" must be text copied exactly from the material you were given; if you cannot copy it exactly, do not call it a quote. Use "contextual" for reasoning across the supplied facts, and name the refs it rests on.',
  '- If the material does not settle a part, name that part in unresolvedFields and explain what is missing. That is a correct and useful answer. Never guess a subject, a category or a relation to fill a field.',
  '- Propose a missing entity only when the supplied text plainly introduces someone or something that is not in the list, and quote the words that do it. Never invent a ref for it: leave subject and defines null and describe it under proposedEntities.',
  '- Quote only the entry\'s own words and the excerpts you were given, never the labels around them.',
  '',
  'Keep each explanation to two sentences.',
  'Answer with JSON only, in the given shape.',
].join('\n');

/** The JSON shape asked for. Validation does not trust it; this only steers. */
export const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    readings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          entryRef: { type: 'string' },
          unresolved: { type: 'boolean' },
          unresolvedFields: { type: 'array', items: { type: 'string', enum: DIMENSIONS } },
          subject: { type: ['string', 'null'] },
          defines: { type: ['string', 'null'] },
          related: { type: 'array', items: { type: 'string' } },
          category: { type: ['string', 'null'], enum: [...CATEGORIES, null] },
          displayPath: { type: ['array', 'null'], items: { type: 'string' } },
          proposedEntities: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ENTITY_TYPES },
                name: { type: 'string' },
                reason: { type: 'string' },
              },
              required: ['type', 'name', 'reason'],
            },
          },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['quote', 'contextual'] },
                quote: { type: 'string' },
                refs: { type: 'array', items: { type: 'string' } },
                explanation: { type: 'string' },
              },
              required: ['type', 'explanation'],
            },
          },
          explanation: { type: 'string' },
        },
        required: ['entryRef', 'unresolved', 'explanation'],
      },
    },
  },
  required: ['readings'],
};

/** The request for one batch: everything the model needs and nothing else. */
export function requestFor(draft, batch) {
  const role = draft.source.current?.role || draft.source.proposedRole?.role || 'unknown';
  const dominant = draft.entities.find((x) => x.ref === draft.stats?.dominant);
  const head = [
    `SOURCE: ${draft.source.name}`,
    `what this source mostly is: ${role}${draft.source.current?.role ? ' (already confirmed by the reader)' : ' (a suggestion, not confirmed)'}`,
    dominant ? `most of it concerns: ${dominant.ref} · ${dominant.name}` : '',
    '',
    `CATEGORIES YOU MAY USE: ${CATEGORIES.map((c) => `${c} (${CATEGORY_HELP[c]})`).join('; ')}`,
    '',
    `Answer for exactly these ${batch.length} ${batch.length === 1 ? 'entry' : 'entries'}, one reading each, in "readings".`,
  ].filter(Boolean).join('\n');
  const body = batch.map((b) => b.text).join('\n\n----------------------------------------\n\n');
  return {
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `${head}\n\n========================================\n\n${body}` },
    ],
    schema: REPLY_SCHEMA,
    // Measured against real answers: a reading with its evidence runs to about
    // 350-450 tokens, so 700 apiece leaves room without inviting an essay. A
    // reply that still runs past this is thrown away rather than half-read.
    maxTokens: Math.min(4000, 700 * batch.length),
  };
}

// ---------------------------------------------------------------- validation

/**
 * Same words, whatever the typography did to them.
 *
 * Curly quotes, long dashes, hard spaces and the punctuation between words all
 * come out flat, so a quotation still counts as copied when a model tidies the
 * comma it landed on. The words themselves and their order are untouched: this
 * forgives formatting, never invention.
 */
export const normalizeQuote = (s) => String(s || '')
  .replace(/[‘’‛′]/g, "'")
  .replace(/[“”‟″]/g, '"')
  .replace(/[‐-―−]/g, '-')
  .replace(/[   ]/g, ' ')
  .replace(/[.,;:!?"'()[\]{}]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

const READING_KEYS = new Set(['entryRef', 'unresolved', 'unresolvedFields', 'subject', 'defines', 'related', 'category',
  'displayPath', 'proposedEntities', 'evidence', 'explanation']);
const EVIDENCE_KEYS = new Set(['type', 'quote', 'refs', 'explanation']);
const PROPOSAL_KEYS = new Set(['type', 'name', 'reason', 'evidence']);
const extraKeys = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.has(k));

/**
 * What survives checking.
 *
 * Hard failures throw the whole reading away: a reading about an entry we did
 * not ask about, an entity that does not exist, a category outside the frozen
 * list, or a reading that both says it cannot tell and then tells. Softer ones
 * drop the part that failed — an unverifiable quotation, a relation the text
 * does not support — and if nothing verifiable is left, the claim goes with it.
 *
 * @param {object} payload  parsed JSON from the model
 * @param {Map}    asked    entryRef → { entry, entities:Set, supplied, names:Map }
 * @returns {{ suggestions: object[], problems: object[] }}
 */
export function readReply(payload, asked) {
  const problems = [];
  const suggestions = [];
  const refuse = (ref, reason) => problems.push({ entryRef: ref || null, kind: 'rejected', reason });

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    problems.push({ entryRef: null, kind: 'unreadable', reason: 'the reply was not a JSON object' });
    return { suggestions, problems };
  }
  if (!Array.isArray(payload.readings)) {
    problems.push({ entryRef: null, kind: 'unreadable', reason: 'the reply had no list of readings' });
    return { suggestions, problems };
  }

  const seen = new Set();
  for (const raw of payload.readings) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { refuse(null, 'a reading was not an object'); continue; }
    const ref = typeof raw.entryRef === 'string' ? raw.entryRef : null;
    const ctx = ref ? asked.get(ref) : null;
    if (!ctx) { refuse(ref, 'that is not one of the entries it was asked about'); continue; }
    if (seen.has(ref)) { refuse(ref, 'answered twice; only the first answer is kept'); continue; }
    seen.add(ref);

    const extra = extraKeys(raw, READING_KEYS);
    if (extra.length) { refuse(ref, `fields that are not part of the answer: ${extra.join(', ')}`); continue; }
    if (typeof raw.unresolved !== 'boolean') { refuse(ref, 'it did not say whether it could tell'); continue; }
    if (typeof raw.explanation !== 'string' || !raw.explanation.trim()) { refuse(ref, 'no explanation'); continue; }

    const subject = raw.subject === undefined ? null : raw.subject;
    const defines = raw.defines === undefined ? null : raw.defines;
    if (Array.isArray(subject)) { refuse(ref, 'more than one subject'); continue; }
    if (subject !== null && typeof subject !== 'string') { refuse(ref, 'the subject was not a ref'); continue; }
    if (defines !== null && typeof defines !== 'string') { refuse(ref, 'defines was not a ref'); continue; }
    // An entry that introduces someone is also about them; saying both of the
    // same entity is consistent, and is how a profile reads. Two different
    // entities is not something an entry can be, so that is refused.
    if (subject && defines && subject !== defines) {
      refuse(ref, 'it said the entry introduces one entity and is about a different one');
      continue;
    }
    if (subject && !ctx.entities.has(subject)) { refuse(ref, `"${subject}" is not one of the entities it was given`); continue; }
    if (defines && !ctx.entities.has(defines)) { refuse(ref, `"${defines}" is not one of the entities it was given`); continue; }

    const category = raw.category === undefined || raw.category === null ? null : raw.category;
    if (category !== null && (typeof category !== 'string' || !CATEGORIES.includes(category))) {
      refuse(ref, `"${category}" is not one of the categories it may use`); continue;
    }

    let related = raw.related === undefined || raw.related === null ? [] : raw.related;
    if (!Array.isArray(related) || related.some((r) => typeof r !== 'string')) { refuse(ref, 'related was not a list of refs'); continue; }
    const unknown = related.find((r) => !ctx.entities.has(r));
    if (unknown) { refuse(ref, `"${unknown}" is not one of the entities it was given`); continue; }

    let displayPath = raw.displayPath === undefined ? null : raw.displayPath;
    if (displayPath !== null) {
      const bad = !Array.isArray(displayPath) || !displayPath.length || displayPath.length > 2
        || displayPath.some((s) => typeof s !== 'string' || !s.trim() || s.length > 40);
      if (bad) { refuse(ref, 'the display group was not one or two short names'); continue; }
      displayPath = displayPath.map((s) => s.trim());
    }

    // ---- which parts it says it could not settle, checked one at a time
    let unresolvedFields = raw.unresolvedFields === undefined || raw.unresolvedFields === null ? [] : raw.unresolvedFields;
    if (!Array.isArray(unresolvedFields) || unresolvedFields.some((f) => typeof f !== 'string')) {
      refuse(ref, 'it did not say plainly which parts were left open'); continue;
    }
    unresolvedFields = [...new Set(unresolvedFields)];
    const strange = unresolvedFields.find((f) => !DIMENSIONS.includes(f));
    if (strange) { refuse(ref, `"${strange}" is not one of the parts of a reading`); continue; }
    // Saying a part is open and then answering it is a contradiction — but only
    // about that part. Everything else it settled still stands.
    const value = { category, subject, defines, related, displayPath };
    const filled = (f) => (f === 'related' ? related.length > 0 : value[f] !== null && value[f] !== undefined);
    const contradiction = unresolvedFields.find(filled);
    if (contradiction) { refuse(ref, `it said the ${contradiction} was open and then answered it`); continue; }

    // A reading has to say something. An entry about nobody in particular is a
    // complete answer — world material has no subject — so a category alone,
    // or a connection alone, counts; only an empty answer does not.
    const conclusion = !!(subject || defines || category || displayPath || related.length || (raw.proposedEntities || []).length);
    if (!raw.unresolved && !unresolvedFields.length && !conclusion) { refuse(ref, 'it said it could tell and named nothing'); continue; }
    // Listing an open part means the reading is partial, whatever the flag said.
    const unresolved = !!raw.unresolved || unresolvedFields.length > 0;

    // ---- evidence, checked against the words that were actually sent
    const evidence = [];
    for (const v of Array.isArray(raw.evidence) ? raw.evidence : []) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) { problems.push({ entryRef: ref, kind: 'dropped', reason: 'a piece of evidence was not an object' }); continue; }
      if (extraKeys(v, EVIDENCE_KEYS).length) { problems.push({ entryRef: ref, kind: 'dropped', reason: 'evidence carried fields that are not part of the answer' }); continue; }
      const explanation = typeof v.explanation === 'string' ? v.explanation.trim() : '';
      if (v.type === 'quote') {
        const quote = typeof v.quote === 'string' ? v.quote.trim() : '';
        const needle = normalizeQuote(quote);
        if (needle.length < 8) { problems.push({ entryRef: ref, kind: 'dropped', reason: 'a quotation too short to check' }); continue; }
        if (!ctx.haystack.includes(needle)) {
          problems.push({ entryRef: ref, kind: 'dropped', reason: `a quotation that is not in the material: “${clip(quote, 60)}”` });
          continue;
        }
        evidence.push({ type: 'quote', quote, explanation });
      } else if (v.type === 'contextual') {
        const refs = Array.isArray(v.refs) ? v.refs.filter((r) => typeof r === 'string' && (ctx.entities.has(r) || asked.has(r))) : [];
        if (!explanation) { problems.push({ entryRef: ref, kind: 'dropped', reason: 'reasoning with nothing said' }); continue; }
        if (!refs.length) { problems.push({ entryRef: ref, kind: 'dropped', reason: 'reasoning that pointed at nothing it was given' }); continue; }
        evidence.push({ type: 'contextual', refs, explanation });
      } else {
        problems.push({ entryRef: ref, kind: 'dropped', reason: 'evidence that was neither a quotation nor reasoning' });
      }
    }
    const verifiedQuotes = evidence.filter((v) => v.type === 'quote');

    // ---- relations the supplied text does not support are dropped, not guessed at
    const keptRelated = [];
    for (const r of related) {
      if (r === subject || r === defines) continue;
      if (keptRelated.includes(r)) continue;
      const names = ctx.names.get(r) || [];
      if (!names.some((n) => ctx.haystack.includes(normalizeQuote(n)))) {
        problems.push({ entryRef: ref, kind: 'dropped', reason: `${names[0] || r} is not named in this entry, so it was not connected to it` });
        continue;
      }
      keptRelated.push(r);
    }

    // ---- a proposed entity has to be introduced by the text, in words we can find
    const proposedEntities = [];
    for (const pe of Array.isArray(raw.proposedEntities) ? raw.proposedEntities : []) {
      if (!pe || typeof pe !== 'object' || Array.isArray(pe)) { problems.push({ entryRef: ref, kind: 'dropped', reason: 'a proposed entity was not an object' }); continue; }
      if (extraKeys(pe, PROPOSAL_KEYS).length) { problems.push({ entryRef: ref, kind: 'dropped', reason: 'a proposed entity carried fields that are not part of the answer' }); continue; }
      const name = typeof pe.name === 'string' ? pe.name.trim() : '';
      const reason = typeof pe.reason === 'string' ? pe.reason.trim() : '';
      if (!name || name.length > 60) { problems.push({ entryRef: ref, kind: 'dropped', reason: 'a proposed entity with no usable name' }); continue; }
      if (!ENTITY_TYPES.includes(pe.type)) { problems.push({ entryRef: ref, kind: 'dropped', reason: `"${pe.type}" is not a kind of thing Nexus knows` }); continue; }
      if (!reason) { problems.push({ entryRef: ref, kind: 'dropped', reason: 'a proposed entity with no reason' }); continue; }
      const already = [...ctx.names.entries()].find(([, names]) => names.some((n) => normalizeQuote(n) === normalizeQuote(name)));
      if (already) { problems.push({ entryRef: ref, kind: 'dropped', reason: `${name} is already in the list as ${already[0]}` }); continue; }
      if (!ctx.haystack.includes(normalizeQuote(name))) {
        problems.push({ entryRef: ref, kind: 'dropped', reason: `${name} does not appear in this entry's own words` });
        continue;
      }
      proposedEntities.push({ type: pe.type, name, reason });
    }

    // ---- nothing may stand on evidence that did not survive
    const claims = !!(subject || defines || category || displayPath || keptRelated.length || proposedEntities.length);
    if (claims && !evidence.length) {
      refuse(ref, 'nothing in the supplied material backed that up');
      continue;
    }
    if (proposedEntities.length && !verifiedQuotes.length) {
      problems.push({ entryRef: ref, kind: 'dropped', reason: 'a proposed entity needs a quotation, and none could be checked' });
      proposedEntities.length = 0;
    }

    suggestions.push({
      entryRef: ref,
      unresolved,
      unresolvedFields,
      subject: subject || null,
      defines: defines || null,
      related: keptRelated,
      category,
      displayPath,
      proposedEntities,
      evidence,
      explanation: raw.explanation.trim(),
    });
  }

  for (const ref of asked.keys()) {
    if (!seen.has(ref)) problems.push({ entryRef: ref, kind: 'missing', reason: 'the model did not answer for this entry' });
  }
  return { suggestions, problems };
}

// --------------------------------------------------------------- the errand

/**
 * Ask for a second opinion on some entries of one draft.
 *
 * Deterministic in everything but the model call, which is injected, so the
 * checks can hold every shape of bad answer against it without a provider.
 * One request per batch, no retries: a failed batch is reported, not repeated,
 * because repeating it spends someone's money without being asked.
 *
 * @param {object}   o
 * @param {object}   o.draft     what analyzeSource produced
 * @param {Map}      o.contents  entryId → content
 * @param {string[]} o.refs      the draft entry refs to look at
 * @param {function} o.complete  ({messages, schema, maxTokens}) → {data, usage, model, ...}
 * @param {boolean}  [o.force]   the reader asked about a likely entry by name
 * @returns {Promise<{suggestions, problems, usage, calls, batches}>}
 */
export async function assist({ draft, contents, refs, complete, force = false, maxPerBatch, charBudget }) {
  const byRef = new Map(draft.entries.map((e) => [e.ref, e]));
  const problems = [];
  const wanted = [];
  for (const ref of [...new Set(refs)]) {
    const entry = byRef.get(ref);
    const say = eligible(entry, { force });
    if (!say.ok) { problems.push({ entryRef: ref, kind: 'skipped', reason: say.reason }); continue; }
    wanted.push(entry);
  }
  if (!wanted.length) return { suggestions: [], problems, usage: [], calls: 0, batches: 0 };

  const blocks = wanted.map((entry) => ({ entry, ...entryBlock(draft, entry, contents) }));
  const batches = buildBatches(blocks, { maxPerBatch, charBudget });
  const suggestions = [];
  const usage = [];

  for (const batch of batches) {
    const asked = new Map(batch.map((b) => [b.entry.ref, {
      entry: b.entry,
      entities: new Set(b.entities),
      haystack: normalizeQuote(b.supplied),
      names: new Map(b.entities.map((ref) => {
        const x = draft.entities.find((e) => e.ref === ref);
        return [ref, [x?.name, ...(x?.aliases || [])].filter(Boolean)];
      })),
    }]));
    const { messages, schema, maxTokens } = requestFor(draft, batch);
    let reply;
    try {
      reply = await complete({ messages, schema, maxTokens });
    } catch (err) {
      // One batch failing must not lose the others.
      for (const b of batch) problems.push({ entryRef: b.entry.ref, kind: 'failed', reason: err?.message || 'the model could not be reached' });
      continue;
    }
    usage.push({
      model: reply?.model || null,
      inputTokens: reply?.usage?.prompt_tokens ?? null,
      outputTokens: reply?.usage?.completion_tokens ?? null,
      cost: reply?.usage?.cost ?? null,
      entries: batch.length,
      finishReason: reply?.finishReason || null,
    });
    if (reply?.finishReason === 'length' || !reply?.data) {
      for (const b of batch) problems.push({ entryRef: b.entry.ref, kind: 'failed', reason: 'the answer did not arrive whole' });
      continue;
    }
    const read = readReply(reply.data, asked);
    suggestions.push(...read.suggestions);
    problems.push(...read.problems);
  }
  return { suggestions, problems, usage, calls: batches.length, batches: batches.length };
}
