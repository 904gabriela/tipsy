// Legacy semantic conversion, P3: a deterministic REVIEW DRAFT for one source.
//
//   analyzeSource(db, lorebookId, { compareWith: [lorebookId, …] }) → draft
//
// legacy source → evidence → entities and variants → proposals with
// confidence and evidence → draft. It stops there. Nothing in a draft is
// approved, and producing one writes nothing: the connection is switched to
// query-only for the duration, so a write would fail rather than happen.
//
// No model is called and nothing is embedded. Every proposal lists the
// evidence it rests on, in words a person can check against the entry.
//
// ── The draft ────────────────────────────────────────────────────────────
//
// {
//   format: 'nexus-conversion-draft', version: 1,
//   source:   { id, name, entryCount, card, current, proposedRole },
//   entities: [{ ref, type, name, aliases, profileEntries, mentionedIn, subjectOf,
//                confidence, evidence, declaredEntityId }],
//   entries:  [{ ref, entryId, title, name, phase, storedKind, activation, current,
//                proposal: { scope, category, defines, subject, related, displayPath } | null,
//                subjectCandidates, confidence, evidence, unresolved }],
//   variantGroups: [{ ref, entries, basis, note }],
//   matches:  [{ entity, candidate, confidence, evidence }],
//   suppressedMatches: [{ entity, candidate, reason }],
//   warnings: [{ code, message, entries?, entities? }],
//   stats:    { … }
// }
//
// Refs are local to the draft. Database ids appear only where they name
// something that already exists (the entry itself, a declared entity, a
// comparison source); a proposed entity never has one.
//
// Confidence is high, medium or low. Each piece of evidence carries the
// points it contributed, so the product can show the reasoning without
// depending on a score.

import { entryHash } from '../semantics/authority.js';
import { areDistinct } from '../semantics/store.js';
import { refAllocator } from '../package/format.js';
import {
  sentences, nameRuns, capitalisedKeys, cleanTitle, normalize, tokens, jaccard, countPhrase,
  TYPE_WORDS, TYPE_LANGUAGE, PERSON_LEXICON, WORLD_LEXICON, IMPERATIVES, NARRATION, RELATIONSHIP_LANGUAGE, readsAsHistory,
} from './text.js';

export const DRAFT_FORMAT = 'nexus-conversion-draft';
export const DRAFT_VERSION = 1;

const parse = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };
const RANK = { low: 0, medium: 1, high: 2 };
const lowest = (...cs) => cs.reduce((a, b) => (RANK[b] < RANK[a] ? b : a), 'high');
const ev = (type, detail, points = 0) => ({ type, detail, points });
const PRONOUN = /\b(he|him|his|she|her|hers)\b/i;
const PRONOUN_LED = /^(he|she|his|her)\b/i;
const LEGACY_KIND_TYPE = { character: 'person', place: 'place', faction: 'faction', item: 'item', event: 'event' };

/**
 * Analyse one source. Read-only.
 *
 * @param {object} db
 * @param {string} lorebookId
 * @param {object} [opts]
 * @param {string[]} [opts.compareWith]  other sources to look for the same entities in
 */
export function analyzeSource(db, lorebookId, { compareWith = [] } = {}) {
  const raw = db.raw;
  const wasReadOnly = raw.prepare('PRAGMA query_only').get().query_only === 1;
  if (!wasReadOnly) raw.exec('PRAGMA query_only = ON');
  try {
    const draft = analyzeOne(db, lorebookId);
    if (!draft) return null;
    const others = compareWith.filter((id) => id !== lorebookId).map((id) => analyzeOne(db, id)).filter(Boolean);
    crossSourceMatches(db, draft, others);
    existingEntityMatches(db, draft);
    return finalize(draft);
  } finally {
    if (!wasReadOnly) raw.exec('PRAGMA query_only = OFF');
  }
}

// ======================================================================
function analyzeOne(db, lorebookId) {
  const book = db.raw.prepare('SELECT id, name, from_character FROM lorebooks WHERE id=?').get(lorebookId);
  if (!book) return null;
  const rows = db.raw.prepare('SELECT * FROM lore_entries WHERE lorebook_id=? ORDER BY display_index, rowid').all(lorebookId);
  const cardRow = book.from_character ? db.raw.prepare('SELECT id, name, nickname FROM characters WHERE id=?').get(book.from_character) : null;
  const roleRow = db.raw.prepare('SELECT * FROM source_semantics WHERE lorebook_id=?').get(lorebookId);
  const declared = db.raw.prepare(`SELECT d.entity_id, d.local_name, d.local_ref, x.type, x.canonical_name FROM source_entities d
                                    JOIN lore_entities x ON x.id=d.entity_id WHERE d.lorebook_id=? AND d.status='approved'`).all(lorebookId);
  const legacy = db.raw.prepare('SELECT * FROM legacy_entry_links WHERE entry_book_id=?').all(lorebookId);

  const allocate = refAllocator();
  const entries = rows.map((r) => {
    const t = cleanTitle(r.title);
    const keys = parse(r.keys, []);
    const semantics = db.raw.prepare('SELECT status, content_hash, category, scope FROM entry_semantics WHERE entry_id=?').get(r.id);
    const hashNow = entryHash({ title: r.title, content: r.content, keys });
    return {
      ref: allocate(null, t.name || r.title || 'entry'),
      id: r.id,
      title: r.title,
      name: t.name,
      phase: t.phase || (r.content.match(/\bPHASE\s*\d\+?(\s*ONLY)?\b/i)?.[0] ?? null),
      markers: t.markers,
      kind: r.kind || 'note',
      enabled: !!r.enabled,
      constant: !!r.constant,
      keys,
      secondaryKeys: parse(r.secondary_keys, []),
      content: r.content,
      sents: sentences(r.content),
      runs: nameRuns(r.content),
      current: !semantics ? 'none' : semantics.status !== 'approved' ? 'proposed' : semantics.content_hash && semantics.content_hash !== hashNow ? 'recheck' : 'approved',
      // A card name like "Jane Vale 'The Gardener'" is the person plus a nickname.
      legacy: legacy.filter((l) => l.entry_id === r.id).map((l) => ({ kind: l.target_kind, name: l.target_name, plainName: String(l.target_name || '').replace(/\s*['"“‘][^'"”’]+['"”’]\s*$/, '').trim(), source: l.source })),
      evidence: [], unresolved: [], proposal: null, subjectCandidates: [],
    };
  });

  const ctx = { db, book, card: cardRow, roleRow, declared, entries, entities: [], byName: new Map(), warnings: [] };
  groupsFromTitles(ctx);
  discoverEntities(ctx);
  proposeEntries(ctx);
  groupVariants(ctx);
  proposeRole(ctx);
  return ctx;
}

// ------------------------------------------------------------------ groups

/**
 * Display groups the source itself writes into its titles: "Ability: Tideglass",
 * "Ability: Limits" → both shown under "Ability".
 *
 * Only a prefix several entries share counts, and it is presentation only. Nothing
 * here invents a structure to make a draft look tidy.
 */
function groupsFromTitles(ctx) {
  const counts = new Map();
  for (const e of ctx.entries) {
    const m = String(e.title).match(/^([\p{Lu}][\p{L}\p{N} '’-]{1,30}?)\s*[:—–]\s*\S.*$/u);
    if (!m || /^(disabled|phase|rule|note|hidden)$/i.test(m[1].trim())) continue;
    e.groupPrefix = m[1].trim();
    const key = normalize(e.groupPrefix);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const e of ctx.entries) {
    if (!e.groupPrefix) continue;
    if ((counts.get(normalize(e.groupPrefix)) || 0) < 2) { e.groupPrefix = null; continue; }
    e.displayPath = [e.groupPrefix];
  }
}

// ------------------------------------------------------------------ entities

function addEntity(ctx, { type, name, confidence, evidence, profileEntry = null, aliases = [] }) {
  const key = normalize(name);
  const existing = ctx.entities.find((e) => normalize(e.name) === key || e.aliases.some((a) => normalize(a) === key));
  if (existing) {
    if (profileEntry && !existing.profileEntries.includes(profileEntry)) existing.profileEntries.push(profileEntry);
    for (const a of aliases) addAlias(ctx, existing, a);
    if (RANK[confidence] > RANK[existing.confidence] && existing.type === type) existing.confidence = confidence;
    existing.evidence.push(...evidence);
    return existing;
  }
  const entity = { type, name, aliases: [], profileEntries: profileEntry ? [profileEntry] : [], confidence, evidence: [...evidence], mentionedIn: 0, subjectOf: 0 };
  ctx.entities.push(entity);
  for (const a of aliases) addAlias(ctx, entity, a);
  return entity;
}

function addAlias(ctx, entity, alias) {
  const a = String(alias || '').trim();
  const key = normalize(a);
  if (!key || key === normalize(entity.name) || entity.aliases.some((x) => normalize(x) === key)) return;
  // Never an alias that is, or belongs to, somebody else.
  if (ctx.entities.some((e) => e !== entity && (normalize(e.name) === key || normalize(e.name).split(' ').includes(key) || e.aliases.some((x) => normalize(x) === key)))) return;
  entity.aliases.push(a);
}

/** "The Iron Gate is a prestigious nightclub" → nightclub, if the sentence is about `name`. */
function isAHead(sentence, name) {
  const m = sentence.match(/^(.{1,80}?)\s+(?:is|was)\s+(?:a|an|the|one of the)\s+([^.;:]{1,80})/i);
  if (!m) return null;
  const subject = normalize(m[1]);
  const want = normalize(name);
  if (!want || !(subject === want || subject.endsWith(` ${want}`) || subject.includes(want))) return null;
  // The first word after the article that names a kind of thing: "a prestigious nightclub" → nightclub.
  const words = m[2].split(/[\s,]+/).slice(0, 6).map((w) => w.toLowerCase().replace(/[^a-z-]/g, ''));
  return words.find((w) => typeOfWord(w)) || null;
}

const typeOfWord = (word) => {
  const w = String(word || '').toLowerCase();
  for (const [type, list] of Object.entries(TYPE_WORDS)) if (list.includes(w)) return type;
  if (/^(man|woman|boy|girl|boss|fixer|capo|enforcer|mentor|guard|owner|leader|killer|doctor|detective|officer|student|teacher|friend)$/.test(w)) return 'person';
  return null;
};

/**
 * A lexicon term at the start of a word: "arc" is never inside a name, "face" never in "Surface".
 * Short terms must be whole words too, so "war" is not in "warning". Longer ones may be
 * stems: "communicat" matches "communicates".
 */
const termIn = (text, term) => new RegExp(`(^|[^\\p{L}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${term.length <= 4 ? 's?(?![\\p{L}])' : ''}`, 'iu').test(String(text || ''));
const lexiconHit = (text, lexicon) => Object.values(lexicon).some((terms) => terms.some((t) => termIn(text, t)));

function discoverEntities(ctx) {
  const { entries } = ctx;
  // How often each capitalised name appears mid-sentence, and in how many entries.
  const stats = new Map();
  const note = (name, entry, { mid = false, key = false } = {}) => {
    const k = normalize(name);
    if (!k) return;
    const s = stats.get(k) || { name, entries: new Set(), mid: 0, keys: 0 };
    s.entries.add(entry.ref);
    if (mid) s.mid++;
    if (key) s.keys++;
    stats.set(k, s);
  };
  for (const e of entries) {
    for (const r of e.runs) note(r.name, e, { mid: r.midSentence });
    for (const k of capitalisedKeys(e.keys)) note(k, e, { key: true });
  }
  ctx.nameStats = stats;
  const proper = (name, entry) => {
    const s = stats.get(normalize(name));
    if (!s) return false;
    const elsewhere = [...s.entries].some((r) => r !== entry.ref);
    return s.mid > 0 || s.keys > 0 || elsewhere;
  };

  // 1. The card this source came with names a person.
  if (ctx.card) {
    const quoted = ctx.card.name.match(/^(.*?)\s*['"“‘](.+?)['"”’]\s*$/);
    const name = (quoted ? quoted[1] : ctx.card.name).trim();
    const aliases = [quoted?.[2], ctx.card.nickname].filter(Boolean);
    addEntity(ctx, { type: 'person', name, aliases, confidence: 'medium', evidence: [ev('source-context', `this source arrived with the card "${ctx.card.name}"`, 1)] });
  }

  // 2. Entries whose title names a thing, and whose content profiles it.
  for (const e of entries) {
    const title = e.name;
    if (!title || / and | vs\.? |:|\//i.test(title)) continue;
    const words = title.split(/\s+/);
    const possessive = title.match(/^(.+?)[’']s\s+(.+)$/);
    const head = (possessive ? possessive[2] : title).split(/\s+/);
    const headWord = /^\d+$/.test(head[head.length - 1]) && head.length > 1 ? head[head.length - 2] : head[head.length - 1];
    const titleType = typeOfWord(headWord) === 'person' ? null : typeOfWord(headWord);
    const first = e.sents[0] || '';
    const aspectWords = (t) => lexiconHit(t, PERSON_LEXICON) || lexiconHit(t, WORLD_LEXICON) || /\b(guidance|reminder|register|stage|overview|surface|tension|probing|warning|style)\b/i.test(t);
    const aspect = aspectWords(title) || e.markers.length;
    // A title that ends in a word for a place or thing is that thing, whatever its adjectives:
    // "Hidden interrogation room" is a room, even though "hidden" is also secret-language.
    const headAspect = aspectWords(headWord) || e.markers.length;
    const evidence = [];
    let type = null;

    if (titleType && !headAspect) {
      type = titleType;
      evidence.push(ev('entity-title-pattern', `the title ends in "${headWord}", a word for a ${titleType}`, 3));
    }
    const isA = isAHead(first, possessive ? possessive[2] : title);
    const isAType = typeOfWord(isA);
    if (isAType && !(titleType ? headAspect : aspect)) {
      if (!type) type = isAType;
      if (isAType === type) evidence.push(ev('entity-title-pattern', `the first sentence says it is a "${isA}"`, 3));
    }
    const allCaps = words.every((w) => /^([A-Z][\p{L}'’-]*|of|the|de|da|di|van|von|\d+)$/u.test(w));
    const profileColon = new RegExp(`^(the\\s+)?${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:,—–-]`, 'i').test(first.trim());
    if (!type && allCaps && !aspect && proper(title, e)) {
      const personLanguage = TYPE_LANGUAGE.person.some((re) => re.test(e.content));
      const honorific = /^(Don|Donna|Mr|Mrs|Ms|Dr|Lord|Lady|Sir|Captain|Madam|Professor)\b/.test(title);
      if (honorific) evidence.push(ev('title-name', `the title begins with the honorific "${title.split(' ')[0]}"`, 2));
      // "ambitious, charismatic, volatile, arrogant": a profile that opens with a list of traits.
      const traitList = /^([a-z][a-z-]+,\s+){2,}(and\s+)?[a-z][a-z-]+[.,]/.test(first.trim());
      if (traitList) evidence.push(ev('profile-pattern', `the entry opens with a list of traits ("${first.trim().split(/[.]/)[0].slice(0, 60)}")`, 3));
      if (profileColon || personLanguage || honorific || traitList) {
        type = 'person';
        if (profileColon) evidence.push(ev('profile-pattern', `the entry opens "${first.slice(0, title.length + 2)}…", the shape of a profile`, 3));
        if (personLanguage) evidence.push(ev('title-name', 'the title is a proper name and the content describes a person', 2));
      }
    }
    if (!type) continue;
    // Language in the content that agrees, or disagrees, with the type.
    if (TYPE_LANGUAGE[type]?.some((re) => re.test(e.content))) evidence.push(ev(`${type}-language`, `the content reads like a ${type}`, 1));
    const s = stats.get(normalize(title));
    if (s && [...s.entries].some((r) => r !== e.ref)) evidence.push(ev('repeated-name', `"${title}" also appears in ${[...s.entries].filter((r) => r !== e.ref).length} other entr${[...s.entries].length > 2 ? 'ies' : 'y'}`, 1));
    const legacyType = LEGACY_KIND_TYPE[e.kind];
    if (legacyType === type) evidence.push(ev('legacy-kind', `stored as "${e.kind}", which agrees`, 0.5));
    else evidence.push(ev('legacy-kind', `stored as "${e.kind}"; the content evidence outweighs it`, 0));
    const points = evidence.reduce((n, x) => n + x.points, 0);
    const confidence = points >= 4 ? 'high' : points >= 2.5 ? 'medium' : 'low';
    const name = possessive && type !== 'person' ? capitalise(possessive[2]) : title.replace(/^the\s+/i, (m) => m);
    const entity = addEntity(ctx, {
      type, name, confidence, evidence, profileEntry: e.ref,
      aliases: possessive && type !== 'person' ? [title] : [],
    });
    e.defines = entity;
    if (possessive) e.possessor = possessive[1];
  }

  // 3. An entry that opens "Name, 29," or "Name: …" profiles a person even when its title does not name them.
  for (const e of entries) {
    if (e.defines) continue;
    const first = e.sents[0] || '';
    // "Name, 29," (name and age) or "Name is 6'4"" (name and height).
    const m = first.match(/^((?:[A-Z][\p{L}'’-]+\s+){1,3}[A-Z][\p{L}'’-]+|[A-Z][\p{L}'’-]+),\s*\d{1,3}\b/u)
      || first.match(/^((?:[A-Z][\p{L}'’-]+\s+){1,3}[A-Z][\p{L}'’-]+)\s+(?:is|was)\s+\d[\d'’"″]*/u);
    if (!m) continue;
    const entity = addEntity(ctx, { type: 'person', name: m[1], confidence: 'high', evidence: [ev('profile-pattern', `"${e.title}" opens "${m[0]}", a person's name with their ${/,/.test(m[0]) ? 'age' : 'height'}`, 4)] });
    e.profileOf = entity;
  }

  // 4. Aliases, from the keywords of each entity's own profile entries.
  for (const entity of ctx.entities) {
    const own = entries.filter((e) => e.defines === entity || e.profileOf === entity);
    for (const e of own) {
      // Longer keys first, so "The Gardener" is accepted before "Gardener" is judged against it.
      for (const k of capitalisedKeys(e.keys).sort((a, b) => b.length - a.length)) {
        if (normalize(k) === normalize(entity.name)) continue;
        // A keyword is another name for this entity only if it shares a word with a name it
        // already has, or, for a person, is an epithet ("The Gardener"). A weapon's name as a
        // keyword of an armoury is something in the armoury, not another name for it.
        const words = new Set([entity.name, ...entity.aliases].flatMap((n) => normalize(n).split(' ')));
        const shares = normalize(k).split(' ').some((w) => w.length > 2 && words.has(w));
        if (!shares && !(entity.type === 'person' && /^The\s+[A-Z]/.test(k))) continue;
        const before = entity.aliases.length;
        addAlias(ctx, entity, k);
        if (entity.aliases.length > before) entity.evidence.push(ev('alias-in-keywords', `"${k}" is a keyword of "${e.title}"`, 0));
      }
    }
  }
  // 5. Names that recur across entries without a profile of their own.
  const known = () => ctx.entities.flatMap((x) => [x.name, ...x.aliases]).map(normalize);
  for (const [key, s] of [...stats.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    // Already known, or a single word of a known name. A longer name that merely contains a
    // known alias ("Jane Vale" when "Vale" is something's alias) is still its own name.
    if (known().includes(key) || (!key.includes(' ') && known().some((k) => k.split(' ').includes(key)))) continue;
    const words = s.name.replace(/^The\s+/, '').split(/\s+/);
    if (s.entries.size < 2 || (words.length < 2) || (s.mid === 0 && s.keys === 0)) continue;
    const headWord = /^\d+$/.test(words[words.length - 1]) ? words[words.length - 2] : words[words.length - 1];
    let type = typeOfWord(headWord);
    const around = entries.filter((e) => s.entries.has(e.ref)).map((e) => e.content).join(' ');
    if (!type && /\d/.test(s.name) && TYPE_LANGUAGE.item.some((re) => re.test(around))) type = 'item';
    if (!type && /\b(mother|father|brother|sister|wife|husband|son|daughter|uncle|aunt|friend|boss|man|woman)\b/i.test(around) && !/\d/.test(s.name)) type = 'person';
    if (!type || type === 'event') continue;
    addEntity(ctx, {
      type, name: s.name, confidence: 'medium',
      evidence: [ev('repeated-name', `"${s.name}" appears in ${s.entries.size} entries${s.mid ? ' mid-sentence' : ''}${s.keys ? ' and as a keyword' : ''}, with no profile entry of its own`, 2)],
    });
  }

  // First names, and surnames nobody else shares: once every person is known.
  for (const entity of ctx.entities.filter((x) => x.type === 'person')) {
    const parts = entity.name.split(/\s+/).filter((w) => !/^(Don|Donna|Mr|Mrs|Ms|Dr|Lord|Lady|Sir|Captain|The)$/.test(w));
    if (parts.length < 2) continue;
    for (const part of [parts[0], parts[parts.length - 1]]) {
      const shared = ctx.entities.some((x) => x !== entity && normalize(x.name).split(' ').includes(normalize(part)));
      if (!shared) addAlias(ctx, entity, part);
    }
  }

  // A one-word alias that is also a word of someone else's name is ambiguous (a surname shared
  // by a person and the company named after them), so it is no one's alias.
  for (const entity of ctx.entities) {
    entity.aliases = entity.aliases.filter((a) => a.includes(' ')
      || !ctx.entities.some((x) => x !== entity && normalize(x.name).split(' ').includes(normalize(a))));
  }

  // 6. A titleless entry about a specific place or thing, named only by its keywords.
  for (const e of entries) {
    if (e.defines || e.name) continue;
    const key = e.keys.find((k) => ['place', 'item'].includes(typeOfWord(String(k).split(/\s+/).pop())));
    if (!key || !TYPE_LANGUAGE[typeOfWord(String(key).split(/\s+/).pop())].some((re) => re.test(e.content))) continue;
    const type = typeOfWord(String(key).split(/\s+/).pop());
    const entity = addEntity(ctx, {
      type, name: capitalise(key), confidence: 'low',
      evidence: [ev('entity-title-pattern', `"${e.title}" does not name what it describes; its first keyword "${key}" is a word for a ${type}`, 1)],
      profileEntry: e.ref,
    });
    e.defines = entity;
    e.unresolved.push('named only from its keywords: the title does not say what this is');
  }

  // Refs, in a stable order.
  const allocate = refAllocator();
  ctx.entities.sort((a, b) => (normalize(a.name) < normalize(b.name) ? -1 : 1));
  for (const x of ctx.entities) {
    x.ref = allocate(null, x.name);
    const declaration = ctx.declared.find((d) => normalize(d.local_name || d.canonical_name) === normalize(x.name) && d.type === x.type);
    x.declaredEntityId = declaration ? declaration.entity_id : null;
  }
}

const capitalise = (s) => String(s).split(/\s+/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');

// ------------------------------------------------------------------ mentions

/** Where each known entity is named in a piece of text. Longest names first, never counted twice. */
function mentions(ctx, text) {
  const phrases = ctx.entities.flatMap((x) => [x.name, ...x.aliases].map((p) => ({ p, x })))
    .sort((a, b) => b.p.length - a.p.length);
  let rest = String(text || '');
  const found = new Map();
  for (const { p, x } of phrases) {
    // "The Iron Gate" is also written "the Iron Gate", and sometimes without the article at all.
    const bare = p.replace(/^The\s+/i, '');
    const esc = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const article = /^The\s+/i.test(p) ? '(?:[Tt]he\\s+)?' : '';
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${article}${esc})([’']s)?(?=$|[^\\p{L}\\p{N}])`, 'gu');
    rest = rest.replace(re, (m, pre, name, poss, offset) => {
      const f = found.get(x) || { count: 0, possessive: 0, offsets: [], via: new Set() };
      f.count++;
      if (poss) f.possessive++;
      f.offsets.push(offset + pre.length);
      f.via.add(p);
      found.set(x, f);
      return pre + '\u0000'.repeat(name.length + (poss ? poss.length : 0));
    });
  }
  return found;
}

// ------------------------------------------------------------------ entries

function proposeEntries(ctx) {
  const persons = ctx.entities.filter((x) => x.type === 'person');
  // The person the source is mostly about, from explicit evidence only.
  const explicit = new Map();
  for (const e of ctx.entries) {
    if (e.defines) continue;
    const titleHits = mentions(ctx, e.name);
    const firstHits = mentions(ctx, e.sents[0] || '');
    for (const p of persons) {
      const first = firstHits.get(p);
      if (titleHits.has(p) || e.profileOf === p || (first && first.offsets.includes(0))) explicit.set(p, (explicit.get(p) || 0) + 1);
    }
  }
  const ranked = [...explicit.entries()].sort((a, b) => b[1] - a[1]);
  const cardPerson = ctx.card ? persons.find((p) => normalize(p.name) === normalize(ctx.card.name.replace(/\s*['"“‘].*$/, ''))) : null;
  ctx.dominant = ranked.length && (ranked.length === 1 || ranked[0][1] >= ranked[1][1] * 2) ? ranked[0][0] : cardPerson || null;

  // "Jane's mother, Ada Vale" or "his mentor, Don Rafael Sorrento": someone introduced
  // as another person's relation. Wherever it is written in the source, it says who they are.
  const RELATIONS = 'mother|father|brother|sister|wife|husband|son|daughter|uncle|aunt|mentor|boss|friend|lover|partner|rival|grandmother|grandfather';
  for (const e of ctx.entries) {
    for (const s of e.sents) {
      for (const m of s.matchAll(new RegExp(`(\\b[\\p{L}’' .-]{0,40}?)(?:[’']s|\\b(?:his|her))\\s+(${RELATIONS})\\s*,\\s*([^,.;]{2,40})`, 'giu'))) {
        const b = [...mentions(ctx, m[3]).keys()].find((x) => x.type === 'person');
        const owner = /\b(his|her)\s*$/i.test(m[0].slice(0, m[0].indexOf(m[2])).trim()) ? ctx.dominant : [...mentions(ctx, m[1]).keys()].find((x) => x.type === 'person');
        if (b && owner && b !== owner && !b.relationTo) {
          b.relationTo = { entity: owner, relation: m[2].toLowerCase(), where: e.ref };
          b.evidence.push(ev('relationship-language', `introduced in "${e.title}" as ${owner.name}'s ${m[2].toLowerCase()}`, 0));
        }
      }
    }
  }

  for (const e of ctx.entries) {
    if (e.defines) proposeProfile(ctx, e);
    else if (!proposeInstruction(ctx, e)) proposeAbout(ctx, e);
    e.confidence ||= 'low';
    // Even "nothing here says what this is" is evidence, and review should see it.
    if (!e.evidence.length) e.evidence.push(ev('no-signal', 'nothing in the title, keywords or content marks what this is', 0));
    const stored = LEGACY_KIND_TYPE[e.kind];
    const proposedType = e.proposal?.defines ? e.defines.type : e.proposal?.scope === 'entity' ? 'aspect' : e.proposal?.category;
    if (e.kind && e.proposal && ((stored && stored !== (e.defines?.type || null)) || (!stored && e.defines))) {
      ctx.warnings.push({ code: 'kind-disagrees', entries: [e.ref], message: `"${e.title}" is stored as "${e.kind}"; the evidence reads it as ${e.defines ? `a ${e.defines.type}` : `${e.proposal.scope} ${e.proposal.category}`}. The stored kind is left as it is.` });
    }
    void proposedType;
  }
  for (const x of ctx.entities) {
    x.mentionedIn = ctx.entries.filter((e) => mentions(ctx, `${e.name}\n${e.content}`).has(x)).length;
    x.subjectOf = ctx.entries.filter((e) => e.proposal?.subject === x.ref).length;
  }
}

/** Related: named with a reason, not merely named. */
function relatedOf(ctx, e, exclude) {
  const related = [];
  const text = `${e.name}\n${e.content}`;
  const hits = mentions(ctx, text);
  for (const [x, f] of hits) {
    if (exclude.includes(x)) continue;
    const inTitle = mentions(ctx, e.name).has(x);
    const sentenceWith = e.sents.filter((s) => mentions(ctx, s).has(x));
    const tied = sentenceWith.some((s) => RELATIONSHIP_LANGUAGE.test(s));
    if (inTitle || f.count >= 2 || tied || f.possessive) {
      related.push(x);
      e.evidence.push(ev('relationship-language', `${x.name} is ${inTitle ? 'named in the title' : tied ? `named in "${trim(sentenceWith.find((s) => RELATIONSHIP_LANGUAGE.test(s)))}"` : f.possessive ? `named possessively ("${x.name}'s")` : `named ${f.count} times`}`, 0));
    } else {
      e.evidence.push(ev('mentioned-only', `${x.name} is named once in passing, so is not proposed as related`, 0));
    }
  }
  for (const l of e.legacy) {
    const x = ctx.entities.find((y) => [l.name, l.plainName].some((n) => normalize(y.name) === normalize(n) || y.aliases.some((a) => normalize(a) === normalize(n))));
    const supported = x && (related.includes(x) || exclude.includes(x));
    e.evidence.push(ev('legacy-link-evidence', `historical composer/builder link to "${l.name}"${supported ? ', which the content also supports' : ' — not supported by the content, so it changes nothing'}`, 0));
    if (!supported) ctx.warnings.push({ code: 'legacy-link-unsupported', entries: [e.ref], message: `"${e.title}" has a historical link to "${l.name}" that the content does not support.` });
  }
  return related.sort((a, b) => (a.ref < b.ref ? -1 : 1));
}

const trim = (s) => (s.length > 90 ? `${s.slice(0, 87)}…` : s);

function proposeProfile(ctx, e) {
  const x = e.defines;
  const exclude = [x];
  const related = relatedOf(ctx, e, exclude);
  e.proposal = { scope: 'entity', category: 'profile', defines: x.ref, subject: null, related: related.map((r) => r.ref), displayPath: e.displayPath || null };
  e.evidence.unshift(...x.evidence.filter((v) => v.type !== 'alias-in-keywords' && (v.detail.includes(e.title) || x.profileEntries[0] === e.ref)).slice(0, 4));
  e.confidence = x.confidence;
  if (x.profileEntries.length > 1) e.unresolved.push(`one of ${x.profileEntries.length} profiles of ${x.name} in this source; see the variant group`);
}

function proposeInstruction(ctx, e) {
  const sents = e.sents.length ? e.sents : [e.content];
  const imperative = sents.filter((s) => IMPERATIVES.test(s.replace(/^[^A-Za-z{]+/, '')) || /\b(do not|never|must)\b/i.test(s)).length;
  const ratio = imperative / sents.length;
  const narration = (e.content.match(new RegExp(NARRATION.source, 'gi')) || []).length;
  const hits = mentions(ctx, `${e.name}\n${e.content}`);
  const personHit = [...hits.keys()].some((x) => x.type === 'person');
  const pronounLed = PRONOUN_LED.test(e.content.trim());
  const reference = /^(describes|guide|guidelines|instructions for|comprehensive guide|a (\w+ )?(position|variation|variant))\b/i.test(e.title) || /\b(position|technique)\b/i.test(e.name) && !personHit;
  const evidence = [];
  let category = null;
  let confidence = 'low';

  if (reference) {
    category = 'reference';
    evidence.push(ev('reference-language', `the title "${trim(e.title)}" describes a technique or guide: specialised knowledge rather than a rule for telling`, 3));
    confidence = 'medium';
  } else if (e.markers.includes('RULE')) {
    category = 'direction';
    evidence.push(ev('instruction-marker', 'marked RULE in its title', 4));
    confidence = 'high';
  } else if (ratio >= 0.5) {
    category = 'direction';
    evidence.push(ev('instruction-language', `${imperative} of ${sents.length} sentences are instructions ("${trim(sents.find((s) => IMPERATIVES.test(s) || /\b(do not|never|must)\b/i.test(s)))}")`, 3));
    confidence = 'high';
  } else if ((ratio >= 0.2 && narration >= 1) || (narration >= 1 && !personHit && !pronounLed && !PRONOUN.test(e.content))) {
    category = 'direction';
    evidence.push(ev('narration-language', `speaks about characters and scenes in general ("${trim((e.content.match(NARRATION) || [''])[0])}")${imperative ? `, with ${imperative} instruction${imperative > 1 ? 's' : ''}` : ''}, and names no one`, 2));
    confidence = 'medium';
  }
  if (!category) return false;
  const related = relatedOf(ctx, e, []);
  e.proposal = { scope: 'world', category, defines: null, subject: null, related: related.map((r) => r.ref), displayPath: e.displayPath || null };
  e.evidence.unshift(...evidence);
  if (e.kind !== category && !(category === 'direction' && e.kind === 'rule')) e.evidence.push(ev('legacy-kind', `stored as "${e.kind}"; kept as stored`, 0));
  e.confidence = confidence;
  return true;
}

function proposeAbout(ctx, e) {
  const candidates = [];
  const titleHits = mentions(ctx, e.name);
  const firstHits = mentions(ctx, e.sents[0] || '');
  const allHits = mentions(ctx, e.content);
  const keyHits = mentions(ctx, e.keys.join(' | '));
  const pronoun = PRONOUN.test(e.content);
  const pronounLed = PRONOUN_LED.test(e.content.trim());

  // People are candidates wherever they are named; a place or group only when the title names it
  // ("Vale Family Tension"). An armoury mentioned in a backstory is not what the backstory is about.
  for (const x of ctx.entities.filter((y) => y.type === 'person' || ((y.type === 'place' || y.type === 'faction') && titleHits.has(y)))) {
    const evidence = [];
    const title = titleHits.get(x);
    if (title) evidence.push(ev(title.possessive ? 'possessive-title' : 'title-name', `the title names ${x.name} ("${e.name}")`, 5));
    const first = firstHits.get(x);
    if (e.profileOf === x) evidence.push(ev('profile-pattern', `opens with ${x.name}'s name and age`, 5));
    else if (first && first.offsets.includes(0)) evidence.push(ev(first.possessive ? 'possessive-title' : 'first-sentence-subject', `the first sentence starts with "${[...first.via][0]}${first.possessive ? "'s" : ''}"`, 5));
    else if (first) evidence.push(ev('explicit-name-in-content', `${x.name} is named in the first sentence`, 3));
    const all = allHits.get(x);
    const later = all ? all.count - (first ? first.count : 0) : 0;
    if (later > 0) evidence.push(ev(later > 1 ? 'repeated-name' : 'explicit-name-in-content', `${x.name} is named ${later} more time${later > 1 ? 's' : ''} in the content`, Math.min(2 + (later - 1), 3)));
    if (keyHits.has(x)) evidence.push(ev('alias-in-keywords', `a keyword names ${x.name}`, 1));
    const isExplicit = evidence.some((v) => v.points >= 2);
    if (x === ctx.dominant && pronoun && !title && !(first && first.offsets.includes(0))) {
      const early = PRONOUN.test(e.sents.slice(0, 2).join(' '));
      evidence.push(ev('source-context', `${pronounLed ? 'the entry opens with a pronoun' : early ? 'the entry refers to someone by pronoun from the start' : 'the entry refers to someone by pronoun'}, and ${x.name} is who this source is mostly about`, early ? 3 : 2));
    }
    if (ctx.card && x === ctx.dominant && evidence.length) evidence.push(ev('source-context', `the source arrived with ${x.name}'s card`, 0.5));
    for (const l of e.legacy) {
      if (normalize(l.name).includes(normalize(x.name)) || x.aliases.some((a) => normalize(l.name).includes(normalize(a)))) {
        evidence.push(ev('legacy-link-evidence', `historical composer/builder link to "${l.name}" — never counted`, 0));
      }
    }
    const points = evidence.reduce((n, v) => n + v.points, 0);
    if (points > 0) candidates.push({ x, points, explicit: isExplicit, evidence });
  }
  // Someone known as a candidate's relation is usually part of that candidate's story here,
  // so their passing mentions count for half unless the title names them.
  for (const c of candidates) {
    const rel = c.x.relationTo;
    if (!rel || !candidates.some((o) => o.x === rel.entity) || c.evidence.some((v) => ['title-name', 'possessive-title', 'profile-pattern'].includes(v.type))) continue;
    c.points /= 2;
    c.evidence.push(ev('relationship-language', `${c.x.name} is ${rel.entity.name}'s ${rel.relation} in this source, so being named here counts for less`, 0));
  }
  candidates.sort((a, b) => b.points - a.points || (a.x.ref < b.x.ref ? -1 : 1));
  const [top, second] = candidates;
  const margin = top ? top.points - (second ? second.points : 0) : 0;

  let subject = null;
  let subjectConfidence = 'low';
  if (top && top.points >= 5 && top.explicit && margin >= 3) { subject = top.x; subjectConfidence = 'high'; }
  else if (top && top.points >= 3 && margin >= 2) { subject = top.x; subjectConfidence = 'medium'; }

  e.subjectCandidates = candidates.slice(0, 3).map((c) => ({ entity: c.x.ref, points: c.points, evidence: c.evidence }));

  // What kind of knowledge, if it is about someone.
  const scores = Object.entries(PERSON_LEXICON).map(([category, terms]) => {
    const inTitle = terms.filter((t) => termIn(e.name, t));
    const inContent = terms.filter((t) => termIn(e.content, t)).slice(0, 3);
    // An age or a long-ago time with something that happened is a life being told.
    const history = category === 'backstory' && readsAsHistory(e.content);
    return { category, points: inTitle.length * 3 + inContent.length + (history ? 2 : 0), inTitle, inContent, history };
  }).sort((a, b) => b.points - a.points);
  // A person reading needs real focus on a person, and world language can outweigh a weak one.
  // The raw title counts here: "DISABLED — enable when the war should start" says what it is in its phase note.
  const worldHits = Object.values(WORLD_LEXICON).map((terms) => terms.filter((t) => termIn(`${e.title} ${e.content}`, t)).length).reduce((a, b) => Math.max(a, b), 0);
  // Only a subject the title or opening establishes holds against it; one merely named does not.
  const established = subject && top.evidence.some((v) => ['title-name', 'possessive-title', 'profile-pattern', 'first-sentence-subject'].includes(v.type));
  const worldOutweighs = !established && worldHits >= 2 && worldHits > scores[0].points;
  // A title in the language of someone's story ("Childhood") keeps the entry about a person even
  // when who it is about stays unresolved.
  // Someone is clearly the point of this entry even when no word says what kind of
  // knowledge it is; that is filed as "other" about them, not turned into world material.
  const focused = subject || (top && top.points >= 3) || (top && top.points >= 2 && scores[0].inTitle.length > 0);

  if (focused && !worldOutweighs) {
    const best = scores[0];
    const next = scores[1];
    const category = best.points ? best.category : 'other';
    const categoryConfidence = best.points >= 3 && best.points - next.points >= 2 ? 'high' : best.points >= 2 && best.points > next.points ? 'medium' : 'low';
    const related = relatedOf(ctx, e, subject ? [subject] : []);
    e.proposal = { scope: 'entity', category, defines: null, subject: subject ? subject.ref : null, related: related.map((r) => r.ref), displayPath: e.displayPath || null };
    if (subject) e.evidence.unshift(...top.evidence);
    if (best.points) {
      const said = [best.inTitle.length ? `the title says "${best.inTitle.join('", "')}"` : '', best.inContent.length ? `the content says "${best.inContent.join('", "')}"` : '', best.history ? 'the content tells an age and what happened then' : ''].filter(Boolean);
      e.evidence.push(ev('category-language', `${said.join('; ')}: ${category}`, 0));
    }
    if (categoryConfidence === 'low') e.unresolved.push(best.points ? `the category is uncertain: ${best.category} or ${next.category}` : 'no category language: filed as other');
    if (!subject) {
      e.unresolved.push(second && top.points - second.points < 2
        ? `could be about ${top.x.name} or ${second.x.name}; the text does not settle it`
        : top ? `${top.x.name} is the likeliest subject, but the evidence is thin (${top.points} points)` : 'no one is named');
      ctx.warnings.push({ code: 'subject-unresolved', entries: [e.ref], message: `"${e.title}": who this is about needs review.` });
    }
    e.confidence = subject ? lowest(subjectConfidence, categoryConfidence === 'low' ? 'medium' : categoryConfidence) : 'low';
    return;
  }

  // Otherwise it is about the setting.
  const worldScores = Object.entries(WORLD_LEXICON).map(([category, terms]) => ({ category, hits: terms.filter((t) => termIn(`${e.title} ${e.content}`, t)) }))
    .sort((a, b) => b.hits.length - a.hits.length);
  const setting = TYPE_LANGUAGE.place.some((re) => re.test(e.content)) || TYPE_LANGUAGE.faction.some((re) => re.test(e.content));
  // One stray word is not enough to call something an event or a rule.
  const category = worldScores[0].hits.length >= 2 ? worldScores[0].category : 'background';
  const related = relatedOf(ctx, e, []);
  e.proposal = { scope: 'world', category, defines: null, subject: null, related: related.map((r) => r.ref), displayPath: e.displayPath || null };
  if (category !== 'background') e.evidence.push(ev('world-language', `the content speaks of "${worldScores[0].hits.join('", "')}"`, 2));
  if (setting) e.evidence.push(ev('place-language', 'describes a setting without naming one specific place or group', 1));
  e.confidence = category !== 'background' || setting ? 'medium' : 'low';
  if (e.confidence === 'low') e.unresolved.push('nothing marks what this is; filed as background');
}

// ------------------------------------------------------------------ variants

function groupVariants(ctx) {
  const n = ctx.entries.length;
  const parent = ctx.entries.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const why = new Map();
  const join = (i, j, reason) => {
    const a = find(i); const b = find(j);
    if (a !== b) parent[a] = b;
    const k = [i, j].sort().join(':');
    if (!why.has(k)) why.set(k, reason);
  };
  const toks = ctx.entries.map((e) => tokens(e.content));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = ctx.entries[i]; const b = ctx.entries[j];
      if (a.defines && a.defines === b.defines) join(i, j, `both profile ${a.defines.name}`);
      else if (a.name && normalize(a.name) === normalize(b.name)) join(i, j, `same title "${a.name}"`);
      else if (jaccard(a.keys.map(normalize), b.keys.map(normalize)) >= 0.5 && jaccard(toks[i], toks[j]) >= 0.3) join(i, j, 'the same keywords and much of the same wording');
    }
  }
  const groups = new Map();
  ctx.entries.forEach((e, i) => { const r = find(i); groups.set(r, [...(groups.get(r) || []), i]); });
  const allocate = refAllocator();
  ctx.variantGroups = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const list = members.map((i) => ctx.entries[i]);
    const reasons = [...new Set([...why.entries()].filter(([k]) => k.split(':').every((i) => members.includes(Number(i)))).map(([, r]) => r))];
    const named = list.find((e) => e.defines)?.defines || null;
    const group = {
      ref: allocate(null, `variants-${named ? named.name : list[0].name || list[0].title}`),
      entries: list.map((e) => ({ entry: e.ref, enabled: e.enabled, phase: e.phase })),
      basis: reasons,
      note: `${list.length} entries that look like versions of the same material${list.some((e) => !e.enabled) ? ', some disabled' : ''}. Nothing is merged, removed or chosen; each keeps its own activation.`,
    };
    ctx.variantGroups.push(group);
    // A titleless disabled version of a profiled thing is a variant of that profile.
    if (named) {
      for (const e of list) {
        if (e.defines === named) continue;
        if (!e.name && e.proposal) {
          e.proposal = { ...e.proposal, scope: 'entity', category: 'profile', defines: named.ref, subject: null };
          e.evidence.unshift(ev('variant-of-profile', `grouped with ${named.name}'s profile: ${reasons.join('; ')}`, 2));
          e.confidence = 'medium';
          if (!named.profileEntries.includes(e.ref)) named.profileEntries.push(e.ref);
        }
      }
    }
    ctx.warnings.push({ code: 'variant-group', entries: list.map((e) => e.ref), message: group.note });
  }
}

// ------------------------------------------------------------------ role

function proposeRole(ctx) {
  const entries = ctx.entries;
  const total = entries.length || 1;
  const share = (pred) => entries.filter(pred).length / total;
  const pct = (v) => `${Math.round(v * 100)}%`;
  const direction = share((e) => e.proposal?.category === 'direction');
  const reference = share((e) => e.proposal?.category === 'reference');
  const evidence = [ev('composition', `${entries.length} entries: ${pct(direction)} instructions, ${pct(reference)} specialised reference`, 0)];
  let role = 'mixed';
  let confidence = 'low';
  let subject = null;

  const people = ctx.entities.filter((x) => x.type === 'person').map((x) => {
    const about = entries.filter((e) => e.proposal?.subject === x.ref || (e.proposal?.defines === x.ref)).length / total;
    const orbit = entries.filter((e) => e.proposal && e.proposal.subject !== x.ref && e.proposal.defines !== x.ref && e.proposal.related.includes(x.ref)).length / total;
    return { x, about, orbit };
  }).sort((a, b) => b.about - a.about);
  const lead = people[0];

  if (direction >= 0.7) {
    role = 'narrative-framework';
    confidence = direction >= 0.85 && !ctx.entities.some((x) => x.profileEntries.length) ? 'high' : 'medium';
    evidence.push(ev('instruction-language', `${pct(direction)} of entries are instructions about how to narrate${ctx.entities.length ? '' : ', and no characters, places or groups were found'}`, 3));
  } else if (reference >= 0.6) {
    role = 'reference-pack';
    confidence = reference >= 0.8 ? 'high' : 'medium';
    evidence.push(ev('reference-language', `${pct(reference)} of entries are specialised reference material`, 3));
  } else if (lead && lead.about >= 0.6) {
    role = 'entity-material'; confidence = 'high'; subject = lead.x;
    evidence.push(ev('subject-share', `${pct(lead.about)} of entries are about ${lead.x.name}`, 3));
  } else if (lead && lead.about >= 0.35 && lead.about + lead.orbit >= 0.6) {
    role = 'entity-material'; confidence = 'medium'; subject = lead.x;
    evidence.push(ev('subject-share', `${pct(lead.about)} of entries are about ${lead.x.name}, and another ${pct(lead.orbit)} involve them`, 2));
    ctx.warnings.push({ code: 'role-mixed-content', message: `Mostly about ${lead.x.name}, but it also holds world material, other people and instructions.` });
  } else {
    const parts = [
      ['instructions', direction], ['reference', reference],
      ...(lead ? [[`about ${lead.x.name}`, lead.about]] : []),
      ['world and other entities', share((e) => e.proposal?.scope === 'world' && !['direction', 'reference'].includes(e.proposal.category) || (e.defines && e.defines.type !== 'person'))],
    ].filter(([, v]) => v >= 0.15);
    role = 'mixed';
    confidence = parts.length >= 2 ? 'medium' : 'low';
    evidence.push(ev('composition', parts.length ? `no single purpose: ${parts.map(([k, v]) => `${pct(v)} ${k}`).join(', ')}` : 'no clear purpose', 1));
  }
  if (ctx.card && subject && normalize(ctx.card.name).startsWith(normalize(subject.name))) evidence.push(ev('source-context', `it arrived with ${subject.name}'s card`, 0));
  ctx.proposedRole = { role, confidence, subject: subject ? subject.ref : null, evidence };
}

// ------------------------------------------------------------------ matches

function crossSourceMatches(db, draft, others) {
  draft.matches = draft.matches || [];
  draft.suppressedMatches = draft.suppressedMatches || [];
  for (const other of others) {
    for (const a of draft.entities) {
      for (const b of other.entities) {
        if (a.type !== b.type) continue;
        const namesA = [a.name, ...a.aliases].map(normalize);
        const namesB = [b.name, ...b.aliases].map(normalize);
        const exact = normalize(a.name) === normalize(b.name);
        const alias = !exact && namesA.some((n) => namesB.includes(n));
        if (!exact && !alias) continue;
        const evidence = [];
        let points = 0;
        if (exact) { points += 3; evidence.push(ev('title-name', `both are called "${a.name}"`, 3)); }
        if (alias) { points += 2; evidence.push(ev('alias-in-keywords', `they share a name: "${namesA.find((n) => namesB.includes(n))}"`, 2)); }
        const profile = (ctx, x) => ctx.entries.filter((e) => x.profileEntries.includes(e.ref) || e.proposal?.subject === x.ref).map((e) => e.content).join(' ');
        const overlap = jaccard(tokens(profile(draft, a)), tokens(profile(other, b)));
        if (overlap >= 0.3) { points += 2; evidence.push(ev('profile-overlap', `their material shares ${Math.round(overlap * 100)}% of its wording`, 2)); }
        else evidence.push(ev('profile-overlap', `their material shares only ${Math.round(overlap * 100)}% of its wording`, 0));
        evidence.push(ev('source-context', 'a same name is not the same person: an alternate universe may reuse it. Decide in review.', 0));
        const candidate = { sourceId: other.book.id, sourceName: other.book.name, entity: b.ref, name: b.name, type: b.type, declaredEntityId: b.declaredEntityId };
        if (a.declaredEntityId && b.declaredEntityId && areDistinct(db, a.declaredEntityId, b.declaredEntityId)) {
          draft.suppressedMatches.push({ entity: a.ref, candidate, reason: 'already decided: these are not the same' });
          continue;
        }
        draft.matches.push({ entity: a.ref, candidate, kind: 'cross-source', confidence: points >= 5 ? 'high' : points >= 3 ? 'medium' : 'low', evidence });
      }
    }
  }
}

function existingEntityMatches(db, draft) {
  const rows = db.raw.prepare(`SELECT x.id, x.type, x.canonical_name, x.aliases, d.lorebook_id, b.name AS source_name FROM lore_entities x
                                 JOIN source_entities d ON d.entity_id = x.id AND d.status = 'approved'
                                 JOIN lorebooks b ON b.id = d.lorebook_id
                                WHERE x.merged_into_id IS NULL AND d.lorebook_id <> ?`).all(draft.book.id);
  const seen = new Set();
  for (const a of draft.entities) {
    for (const r of rows) {
      if (r.type !== a.type || seen.has(`${a.ref}:${r.id}`)) continue;
      const names = [r.canonical_name, ...parse(r.aliases, [])].map(normalize);
      if (!names.includes(normalize(a.name)) && !a.aliases.some((x) => names.includes(normalize(x)))) continue;
      seen.add(`${a.ref}:${r.id}`);
      const candidate = { sourceId: r.lorebook_id, sourceName: r.source_name, entityId: r.id, name: r.canonical_name, type: r.type };
      if (a.declaredEntityId && a.declaredEntityId !== r.id && areDistinct(db, a.declaredEntityId, r.id)) {
        draft.suppressedMatches.push({ entity: a.ref, candidate, reason: 'already decided: these are not the same' });
        continue;
      }
      if (a.declaredEntityId === r.id) continue;
      draft.matches.push({ entity: a.ref, candidate, kind: 'existing-entity', confidence: 'medium', evidence: [ev('title-name', `an organised source already has a ${r.type} called "${r.canonical_name}"`, 3), ev('source-context', 'same name only: confirm in review', 0)] });
    }
  }
}

// ------------------------------------------------------------------ output

function finalize(ctx) {
  const refOf = (x) => (x ? x.ref : null);
  const entries = ctx.entries.map((e) => ({
    ref: e.ref,
    entryId: e.id,
    // The entry as it was when this draft was made. Applying a decision checks it
    // still matches, so a draft reviewed against older text is refused, not applied.
    hash: entryHash({ title: e.title, content: e.content, keys: e.keys }),
    title: e.title,
    name: e.name,
    phase: e.phase,
    storedKind: e.kind,
    activation: { enabled: e.enabled, constant: e.constant, keys: e.keys, secondaryKeys: e.secondaryKeys },
    current: e.current,
    proposal: e.proposal,
    subjectCandidates: e.subjectCandidates,
    confidence: e.confidence,
    evidence: e.evidence,
    unresolved: e.unresolved,
  }));
  const counts = (k) => entries.reduce((m, e) => ({ ...m, [e[k]]: (m[e[k]] || 0) + 1 }), {});
  return {
    format: DRAFT_FORMAT,
    version: DRAFT_VERSION,
    source: {
      id: ctx.book.id,
      name: ctx.book.name,
      entryCount: entries.length,
      card: ctx.card ? { id: ctx.card.id, name: ctx.card.name } : null,
      current: ctx.roleRow ? { role: ctx.roleRow.package_role, status: ctx.roleRow.status } : null,
      proposedRole: ctx.proposedRole,
    },
    entities: ctx.entities.map((x) => ({
      ref: x.ref, type: x.type, name: x.name, aliases: x.aliases, profileEntries: x.profileEntries,
      mentionedIn: x.mentionedIn, subjectOf: x.subjectOf, confidence: x.confidence, evidence: x.evidence, declaredEntityId: x.declaredEntityId,
    })),
    entries,
    variantGroups: ctx.variantGroups,
    matches: ctx.matches || [],
    suppressedMatches: ctx.suppressedMatches || [],
    warnings: ctx.warnings,
    stats: {
      entries: entries.length,
      disabled: entries.filter((e) => !e.activation.enabled).length,
      confidence: counts('confidence'),
      unresolved: entries.filter((e) => e.unresolved.length).length,
      entities: ctx.entities.length,
      dominant: refOf(ctx.dominant),
    },
  };
}
