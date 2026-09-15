// The Story Composition Draft: one shape for everything a story is made of
// before it is real.
//
// Material read from a source, material the Story Builder proposed, links the
// composer inferred, and things a person wrote by hand all sit in the same
// draft, side by side, each saying where it came from. Review and Apply read
// one structure whichever way the draft was started.
//
// Nothing here touches the database. A draft is a proposal.
//
// ---------------------------------------------------------------- the shape
//
// Draft (version 1) — composeSource's output, extended:
//
//   version      1
//   mode         'organize' | 'fill' | 'build'
//   context      'new' | 'existing'
//   story        { title, premise, opening: { text, origin } | null }  each field { value, origin } where set
//   lead         { characterId, name } | null
//   casting[]    one row per person
//     key          'card:<id>' | 'entry:<id>' | 'gen:<draftId>'
//     origin       'source' | 'generated' | 'manual'
//     characterId  a card, for card rows
//     entryId      the primary entry, for source people
//     entryIds     every entry describing them
//     draftId      for generated/manual people
//     name, suggested (a ROLE), why[], backing 'card'|'lore'|'generated'
//     content, summary, keys[]       generated/manual people only
//     promote      true when a generated lead should become a card on Apply
//   sections[]   { id, label, kinds, count, items[] }
//     items[]      { origin, entryId | draftId, title, kind, content?, summary?, keys[], always, about[] }
//   links[]      { origin 'inferred' | 'generated' | 'manual', entryId | fromDraftId,
//                  characterId | aboutId | aboutDraftId, targetName, confidence, approved }
//   reused[]     { name, section, existing: { characterId | entryId }, why }  generated duplicates folded into canon
//   generation   { mode, depth, model, usage, scope, warnings[] } | null
//   invented     how many generated items the draft holds (0 in organize)
//
// ORIGINS mean:
//   source     supplied by the person: an imported package, a card, a premise they wrote
//   generated  proposed by the Story Builder; not canonical until applied
//   inferred   the composer's organisation of source material (roles, links)
//   manual     added or edited by the person in review
//
// Only what is accepted is written, and what is written keeps its origin — see
// src/builder/apply.js.

import { nameFromTitle } from '../import/compose.js';

export const DRAFT_VERSION = 1;
export const ORIGINS = ['source', 'generated', 'inferred', 'manual'];
export const MODES = ['organize', 'fill', 'build'];
export const DEPTHS = ['light', 'standard', 'deep'];

/** Draft sections the builder may write into, and the lore kind each becomes. */
export const SECTION_KIND = {
  places: 'place',
  factions: 'faction',
  backstory: 'premise',
  rules: 'rule',
  directions: 'direction',
  events: 'event',
  items: 'item',
  other: 'note',
};
export const BUILDER_SECTIONS = Object.keys(SECTION_KIND);
export const GENERATED_ROLES = ['lead', 'main', 'supporting', 'background', 'known'];

/**
 * How much the builder may propose.
 *
 * Counts, not lengths: depth decides how many useful elements a story gets,
 * never how long each one is. Every entry has the same size ceiling at every
 * depth. HARD is the absolute ceiling whatever a caller asks for.
 */
export const LIMITS = {
  light: { people: 3, places: 2, factions: 1, backstory: 2, rules: 2, directions: 2, events: 2, items: 1, other: 1 },
  standard: { people: 6, places: 4, factions: 2, backstory: 4, rules: 3, directions: 3, events: 4, items: 2, other: 2 },
  deep: { people: 10, places: 7, factions: 3, backstory: 6, rules: 4, directions: 4, events: 6, items: 3, other: 3 },
};
export const HARD = {
  perSection: 12,
  titleChars: 80,
  nameChars: 60,
  summaryChars: 300,
  contentChars: 1500,
  keys: 8,
  keyChars: 40,
  premiseChars: 1200,
  storyTitleChars: 100,
  openingChars: 4000,
  aboutRefs: 4,
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const ID = /^[A-Za-z0-9_-]{1,40}$/;

export class DraftError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'DraftError';
    this.status = 422;
    this.errors = errors;
  }
}

/**
 * Give a composer draft the contract's extra fields.
 *
 * Everything composeSource reports came from a source or from the composer's
 * own reading of it, and says so.
 */
export function fromComposition(draft, { mode = 'organize', story = {} } = {}) {
  const casting = draft.casting.map((r) => ({ ...r, origin: 'source' }));
  const sections = draft.sections.map((s) => ({ ...s, items: s.items.map((i) => ({ ...i, origin: 'source' })) }));
  const other = sections.find((s) => s.id === 'other');
  if (other && draft.unclear?.length) {
    other.items.push(...draft.unclear.map((i) => ({ ...i, origin: 'source' })));
    other.count = other.items.length;
  }
  return {
    ...draft,
    version: DRAFT_VERSION,
    mode,
    story: {
      title: story.title ? { value: story.title, origin: 'source' } : null,
      premise: story.premise ? { value: story.premise, origin: 'source' } : null,
      opening: story.opening ? { text: story.opening, origin: 'source' } : null,
    },
    casting,
    sections,
    unclear: [],
    links: draft.links.map((l) => ({ ...l, origin: 'inferred' })),
    reused: [],
    generation: null,
    invented: 0,
  };
}

/**
 * What a draft already has and what it is missing.
 *
 * Fill the Gaps asks only for what is missing. A section with anything in it —
 * from a source, from a person, from an earlier generation — is not asked for.
 */
export function gapsOf(draft) {
  const count = (id) => draft.sections.find((s) => s.id === id)?.count || 0;
  const have = {
    lead: draft.casting.some((r) => r.suggested === 'lead'),
    people: draft.casting.filter((r) => r.suggested !== 'lead').length,
    premise: !!draft.story?.premise?.value,
    opening: !!draft.story?.opening?.text,
  };
  for (const s of BUILDER_SECTIONS) have[s] = count(s);

  const missing = [];
  if (!have.premise) missing.push('premise');
  // An existing story already began; its opening is canon, not a gap.
  if (!have.opening && draft.context !== 'existing') missing.push('opening');
  if (!have.people) missing.push('people');
  // "Other" is where unplaceable material goes; an empty Other is not missing anything.
  for (const s of BUILDER_SECTIONS.filter((x) => x !== 'other')) if (!have[s]) missing.push(s);
  return { have, missing };
}

/**
 * Canon, as the builder is shown it: short, with a reference for each thing so
 * the model can say "this is about S3" instead of re-describing it.
 */
export function canonOf(draft, { maxItems = 150, snippet = 160 } = {}) {
  const refs = new Map();
  const lines = [];
  let n = 0;
  const cut = (s, k) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, k);
  for (const r of draft.casting) {
    const ref = `C${++n}`;
    refs.set(ref, {
      ...(r.characterId ? { characterId: r.characterId } : r.entryId ? { entryId: r.entryId } : { draftId: r.draftId }),
      name: r.name, section: 'people', kind: 'person',
    });
    lines.push({ ref, section: 'people', name: r.name, role: r.suggested, text: cut(r.content || r.why?.join('; '), snippet) });
  }
  let m = 0;
  for (const s of draft.sections) {
    for (const i of s.items) {
      if (m >= maxItems) break;
      const ref = `S${++m}`;
      refs.set(ref, {
        ...(i.entryId ? { entryId: i.entryId } : { draftId: i.draftId }),
        name: i.title, section: s.id, kind: i.kind || SECTION_KIND[s.id],
      });
      lines.push({ ref, section: s.id, name: i.title, text: cut(i.content || i.summary || (i.keys || []).join(', '), snippet) });
    }
  }
  return { refs, lines, truncated: draft.sections.reduce((a, s) => a + s.items.length, 0) > maxItems };
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * Check what a model returned, before it goes anywhere near a draft.
 *
 * Two kinds of problem. A reply that breaks the contract — not an object, an
 * unknown section or role, the same temporary id twice, two leads, a lead
 * when the story already has one — is refused whole: something that confused
 * about the rules cannot be trusted in its details either. A reply that is
 * well-formed but overreaches — too many places, an entry too long, a person
 * who already exists, a link to nothing — is trimmed, and every trim is said.
 *
 * @param {unknown} raw         parsed model output
 * @param {object}  ctx
 *   draft       the draft it is for
 *   depth       'light' | 'standard' | 'deep'
 *   allowed     which parts may be written: Set of 'premise' | 'opening' | 'people' | section ids
 *   canon       canonOf(draft)
 *   existingNames  { people: Set, perSection: Map<section, Set> } — for duplicate folding
 * @returns {{ story, opening, people, entries, links, reused, warnings }}
 */
export function validateGeneration(raw, ctx) {
  const { draft, depth = 'standard', allowed, canon } = ctx;
  const limits = LIMITS[depth] || LIMITS.standard;
  const errors = [];
  const warnings = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DraftError('The Story Builder returned something that is not a draft.', ['not an object']);
  }
  const people = raw.people === undefined ? [] : raw.people;
  const entries = raw.entries === undefined ? [] : raw.entries;
  if (!Array.isArray(people)) errors.push('people is not a list');
  if (!Array.isArray(entries)) errors.push('entries is not a list');
  if (errors.length) throw new DraftError('The Story Builder returned a malformed draft.', errors);

  // ------------------------------------------------------- contract breaches
  const ids = new Set();
  for (const x of [...people, ...entries]) {
    if (!x || typeof x !== 'object') { errors.push('an item is not an object'); continue; }
    const id = str(x.id);
    if (!ID.test(id)) errors.push(`item id "${String(x.id).slice(0, 40)}" is not a usable id`);
    else if (ids.has(id)) errors.push(`item id "${id}" is used twice`);
    else ids.add(id);
  }
  for (const p of people) {
    if (p && typeof p === 'object' && !GENERATED_ROLES.includes(p.role)) errors.push(`"${str(p.name) || p.id}" has an unknown role "${p.role}"`);
  }
  for (const e of entries) {
    if (e && typeof e === 'object' && !BUILDER_SECTIONS.includes(e.section)) errors.push(`"${str(e.title) || e.id}" is in an unknown section "${e.section}"`);
  }
  const leads = people.filter((p) => p && p.role === 'lead');
  if (leads.length > 1) errors.push('more than one lead');
  if (leads.length && draft.casting.some((r) => r.suggested === 'lead')) errors.push('proposed a lead, but the story already has one');
  if (errors.length) throw new DraftError('The Story Builder broke the draft rules, so nothing it proposed was used.', errors);

  // ------------------------------------------------------------ trimming
  //
  // Reuse is decided conservatively. A proposal is the same thing as
  // something that already exists only when
  //   - it says so by reference ("same": "S4") and the reference is the same
  //     kind of thing, or
  //   - it is the same kind of thing AND has the same normalised name.
  // A person called "Black Lotus" is not the club called "Black Lotus". A
  // false merge loses a proposal silently; a missed one is just a duplicate the
  // person can see and remove.
  const canonByKind = new Map();
  for (const [ref, v] of canon.refs) {
    const k = `${v.kind}|${norm(v.name)}`;
    if (!canonByKind.has(k)) canonByKind.set(k, { ref, ...v });
  }
  const reused = [];
  const existingOf = (v) => ({ ...(v.characterId ? { characterId: v.characterId } : {}), ...(v.entryId ? { entryId: v.entryId } : {}), ...(v.draftId ? { draftId: v.draftId } : {}) });
  const sameAs = (item, kind, name, who) => {
    const said = str(item.same);
    if (said) {
      const v = canon.refs.get(said);
      if (v && v.kind === kind) return { ref: said, ...v, how: 'reference' };
      warnings.push(`${who} said it was ${said.slice(0, 20)}, which is ${v ? `a different kind of thing (${v.kind})` : 'not in the draft'}; it was kept as a new proposal`);
      return null;
    }
    const hit = canonByKind.get(`${kind}|${norm(name)}`);
    return hit ? { ...hit, how: 'name' } : null;
  };
  // The model does not decide who becomes a character card. Anything it says
  // about that is advice for the person, never an instruction.
  const promotionIgnored = [...people].some((p) => p && typeof p === 'object' && 'promote' in p);
  if (promotionIgnored) warnings.push('the Story Builder cannot make anyone a character card; that stays your decision');

  const clip = (value, max, what) => {
    const s = str(value);
    if (s.length > max) { warnings.push(`${what} was longer than ${max} characters and was left out`); return null; }
    return s;
  };
  const keysOf = (k, name) => {
    const list = (Array.isArray(k) ? k : []).map(str).filter(Boolean).filter((x) => x.length <= HARD.keyChars);
    return [...new Set([name, ...list].filter(Boolean))].slice(0, HARD.keys);
  };
  const refsOf = (about, who) => {
    const out = [];
    for (const r of (Array.isArray(about) ? about : []).slice(0, HARD.aboutRefs)) {
      const ref = str(r);
      if (canon.refs.has(ref)) out.push({ ref, ...canon.refs.get(ref) });
      else if (ids.has(ref)) out.push({ ref, draftId: ref });
      else warnings.push(`${who} pointed at "${ref.slice(0, 20)}", which is not in the draft; that link was dropped`);
    }
    return out;
  };

  const outPeople = [];
  if (people.length && !allowed.has('people')) {
    warnings.push(`${people.length} people were proposed but not asked for, and were left out`);
  } else {
    for (const p of people) {
      const name = clip(p.name, HARD.nameChars, 'a name');
      const content = clip(p.content, HARD.contentChars, `${p.name}'s entry`);
      if (!name || !content) { if (name && !content) warnings.push(`${name} had no description and was left out`); continue; }
      // Somebody who already exists is recognised however the model spelled
      // or capitalised them, before anything else is judged.
      const same = sameAs(p, 'person', name, name);
      if (same) {
        reused.push({ name, section: 'people', kind: 'person', existing: existingOf(same), how: same.how, why: 'already in the story; the existing one is used' });
        continue;
      }
      if (!nameFromTitle(name).name) { warnings.push(`"${name}" is not a person's name and was left out`); continue; }
      if (outPeople.some((x) => norm(x.name) === norm(name))) { warnings.push(`${name} was proposed twice; the second was left out`); continue; }
      if (outPeople.length >= Math.min(limits.people, HARD.perSection)) { warnings.push(`more than ${limits.people} people were proposed at ${depth} depth; the rest were left out`); break; }
      outPeople.push({
        draftId: str(p.id), name, role: p.role,
        summary: clip(p.summary, HARD.summaryChars, `${name}'s summary`) || '',
        content, keys: keysOf(p.keys, name), about: refsOf(p.about, name),
        // Advice only: shown to the person, never acted on.
        promotionSuggested: p.promotionSuggested === true,
      });
    }
  }

  const outEntries = [];
  const perSection = {};
  for (const e of entries) {
    if (!allowed.has(e.section)) { warnings.push(`"${str(e.title)}" is in ${e.section}, which was not asked for, and was left out`); continue; }
    const title = clip(e.title, HARD.titleChars, 'a title');
    const content = clip(e.content, HARD.contentChars, `"${e.title}"`);
    if (!title || !content) continue;
    const same = sameAs(e, SECTION_KIND[e.section], title, `"${title}"`);
    if (same) {
      reused.push({ name: title, section: e.section, kind: SECTION_KIND[e.section], existing: existingOf(same), how: same.how, why: 'already in the story; the existing one is used' });
      continue;
    }
    if (outEntries.some((x) => x.section === e.section && norm(x.title) === norm(title))) { warnings.push(`"${title}" was proposed twice; the second was left out`); continue; }
    const max = Math.min(limits[e.section] ?? 2, HARD.perSection);
    perSection[e.section] = (perSection[e.section] || 0) + 1;
    if (perSection[e.section] > max) { warnings.push(`more than ${max} ${e.section} were proposed at ${depth} depth; the rest were left out`); continue; }
    outEntries.push({
      draftId: str(e.id), section: e.section, kind: SECTION_KIND[e.section], title,
      summary: clip(e.summary, HARD.summaryChars, `"${title}" summary`) || '',
      content, keys: keysOf(e.keys, null).length ? keysOf(e.keys, null) : [title],
      alwaysOn: e.alwaysOn === true, about: refsOf(e.about, `"${title}"`),
    });
  }

  // A link to something that was trimmed is a link to nothing.
  const kept = new Set([...outPeople, ...outEntries].map((x) => x.draftId));
  for (const x of [...outPeople, ...outEntries]) {
    x.about = x.about.filter((a) => {
      if (!a.draftId || a.entryId || a.characterId) return true;
      if (kept.has(a.draftId) && a.draftId !== x.draftId) return true;
      warnings.push(`a link from "${x.name || x.title}" pointed at something that was left out, and was dropped`);
      return false;
    });
  }

  let story = null;
  const s = raw.story && typeof raw.story === 'object' ? raw.story : null;
  if (s) {
    const title = allowed.has('title') ? clip(s.title, HARD.storyTitleChars, 'the story title') : null;
    const premise = allowed.has('premise') ? clip(s.premise, HARD.premiseChars, 'the premise') : null;
    if ((s.title && !allowed.has('title')) || (s.premise && !allowed.has('premise'))) {
      warnings.push('a story title or premise was proposed where one already exists, and was left out');
    }
    if (title || premise) story = { title: title || null, premise: premise || null };
  }

  let opening = null;
  const o = raw.opening && typeof raw.opening === 'object' ? raw.opening : null;
  if (o && str(o.text)) {
    if (!allowed.has('opening')) warnings.push('an opening was proposed but not asked for, and was left out');
    else opening = clip(o.text, HARD.openingChars, 'the opening');
  }

  return { story, opening, people: outPeople, entries: outEntries, reused, warnings };
}

/**
 * Put validated generated material into a draft.
 *
 * Source and manual material is never replaced. Within the scope being
 * generated, earlier GENERATED material is replaced; outside it, nothing moves.
 *
 * @param {object} draft
 * @param {object} gen    validateGeneration output
 * @param {object} scope  { parts: Set } — which parts were generated this time
 *                        { item: draftId } — replace exactly one generated item
 */
export function mergeGenerated(draft, gen, scope) {
  const out = structuredClone(draft);
  const parts = scope.parts;
  // Suggestions the person has edited are theirs now: asking for a part again
  // replaces only the suggestions nobody touched.
  const replacing = (x, part) => x.origin === 'generated' && !x.edited && !scope.item && parts.has(part);

  // Earlier generations in the regenerated scope go; everything else stays.
  if (!scope.item) {
    out.casting = out.casting.filter((r) => !replacing(r, 'people'));
    for (const s of out.sections) s.items = s.items.filter((i) => !replacing(i, s.id));
  } else {
    out.casting = out.casting.filter((r) => !(r.origin === 'generated' && r.draftId === scope.item));
    for (const s of out.sections) s.items = s.items.filter((i) => !(i.origin === 'generated' && i.draftId === scope.item));
  }
  const alive = new Set([
    ...out.casting.filter((r) => r.draftId).map((r) => r.draftId),
    ...out.sections.flatMap((s) => s.items.filter((i) => i.draftId).map((i) => i.draftId)),
  ]);
  out.links = out.links.filter((l) => l.origin !== 'generated' || (alive.has(l.fromDraftId) && (!l.aboutDraftId || alive.has(l.aboutDraftId))));

  // Temporary ids are unique within one draft, across generations.
  const taken = new Set(alive);
  const rename = new Map();
  const fresh = (id) => {
    let next = id; let k = 2;
    while (taken.has(next)) next = `${id}-${k++}`;
    taken.add(next);
    rename.set(id, next);
    return next;
  };
  for (const x of [...gen.people, ...gen.entries]) x.draftId = fresh(x.draftId);
  const resolve = (a) => (a.draftId && rename.has(a.draftId) ? { ...a, draftId: rename.get(a.draftId) } : a);

  for (const p of gen.people) {
    out.casting.push({
      key: `gen:${p.draftId}`, origin: 'generated', draftId: p.draftId, characterId: null, entryId: null, entryIds: [],
      // Any generated person may be made lead in review, but only the person
      // can decide they become a card: promote starts false, always.
      name: p.name, backing: 'generated', canLead: true, suggested: p.role, promote: false,
      promotionSuggested: p.promotionSuggested === true,
      why: ['proposed by the Story Builder'], content: p.content, summary: p.summary, keys: p.keys,
    });
  }
  for (const e of gen.entries) {
    const s = out.sections.find((x) => x.id === e.section);
    s.items.push({
      origin: 'generated', draftId: e.draftId, entryId: null, title: e.title, kind: e.kind,
      content: e.content, summary: e.summary, keys: e.keys, always: e.alwaysOn, enabled: true,
      tokens: Math.ceil(e.content.length / 4), about: e.about.map((a) => a.name || a.draftId),
    });
  }
  for (const x of [...gen.people, ...gen.entries]) {
    for (const a of x.about.map(resolve)) {
      out.links.push({
        origin: 'generated', fromDraftId: x.draftId,
        ...(a.characterId ? { characterId: a.characterId } : a.entryId ? { aboutId: a.entryId } : { aboutDraftId: a.draftId }),
        entryTitle: x.name || x.title, targetName: a.name || a.draftId, confidence: 'generated', approved: true,
      });
    }
  }
  for (const s of out.sections) s.count = s.items.length;

  out.story = { ...(out.story || {}) };
  if (gen.story?.title) out.story.title = { value: gen.story.title, origin: 'generated' };
  if (gen.story?.premise) out.story.premise = { value: gen.story.premise, origin: 'generated' };
  if (gen.opening) out.story.opening = { text: gen.opening, origin: 'generated' };

  out.reused = [...(out.reused || []), ...gen.reused];
  out.invented = out.casting.filter((r) => r.origin === 'generated').length
    + out.sections.reduce((n, s) => n + s.items.filter((i) => i.origin === 'generated').length, 0)
    + (out.story.opening?.origin === 'generated' ? 1 : 0)
    + (out.story.premise?.origin === 'generated' ? 1 : 0)
    + (out.story.title?.origin === 'generated' ? 1 : 0);
  out.totals = { ...(out.totals || {}), people: out.casting.length, generated: out.invented };
  return out;
}

/**
 * Check a draft a client sends back before generating on top of it.
 *
 * The server does not keep drafts. A draft that comes back is checked for
 * shape; anything it claims about source material is re-read from the
 * database on Apply, never trusted.
 */
export function checkDraft(draft) {
  const errors = [];
  if (!draft || typeof draft !== 'object') throw new DraftError('That is not a draft.', ['not an object']);
  if (draft.version !== DRAFT_VERSION) errors.push(`draft version ${draft.version} is not ${DRAFT_VERSION}`);
  if (!Array.isArray(draft.casting)) errors.push('casting is not a list');
  if (!Array.isArray(draft.sections)) errors.push('sections is not a list');
  if (!Array.isArray(draft.links)) errors.push('links is not a list');
  if (errors.length) throw new DraftError('That draft could not be read.', errors);
  for (const s of draft.sections) {
    if (!BUILDER_SECTIONS.includes(s.id)) errors.push(`unknown section "${s.id}"`);
    for (const i of s.items || []) if (!ORIGINS.includes(i.origin)) errors.push(`an item in ${s.id} has no known origin`);
  }
  for (const r of draft.casting) if (!ORIGINS.includes(r.origin)) errors.push(`${r.name} has no known origin`);
  const leads = draft.casting.filter((r) => r.suggested === 'lead');
  if (leads.length > 1) errors.push('more than one lead');
  const dids = [...draft.casting.filter((r) => r.draftId).map((r) => r.draftId), ...draft.sections.flatMap((s) => (s.items || []).filter((i) => i.draftId).map((i) => i.draftId))];
  if (new Set(dids).size !== dids.length) errors.push('two draft items share an id');
  if (errors.length) throw new DraftError('That draft could not be read.', errors);
  return draft;
}
