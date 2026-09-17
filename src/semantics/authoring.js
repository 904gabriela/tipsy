// Writing knowledge about someone, by hand.
//
// A person says "add this to Patrick's psychology". Underneath that sentence
// there is a lore entry, a source to keep it in, a semantic reading, a subject
// relation and a declaration — and none of that is the person's problem. This
// module is where the sentence becomes those rows, in one transaction, or not
// at all.
//
// Two things it will not do:
//
//   It never writes into a source somebody imported. Imported material stays
//   as it arrived, managed where it came from; Nexus keeps its own containers
//   and marks them on the book itself, the way the Story Builder already does,
//   so they are found again by what they are rather than by what they are
//   called.
//
//   It never guesses. A reading written here is approved because a person
//   supplied it — the subject is the profile they were standing on, the
//   category is the group they pressed Add in. No analysis runs, no model is
//   asked, and nothing is marked proposed.

import { entryHash, PERSON_CATEGORIES, WORLD_CATEGORIES } from './authority.js';
import { declareInSource, setEntrySemantics, setRelation, setSourceRole, normalizeDisplayPath } from './store.js';
import { slugRef } from '../package/format.js';

export class AuthoringError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.name = 'AuthoringError';
    this.status = 400;
    this.problems = problems;
  }
}

/** Every category a person may file something under. Frozen elsewhere; read here. */
export const CATEGORIES = [...new Set([...PERSON_CATEGORIES, ...WORLD_CATEGORIES, 'profile'])];

const now = () => Date.now();
const j = (v) => JSON.stringify(v);
const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

// ------------------------------------------------------------ the containers

/**
 * What Nexus keeps its own writing in, marked on the book rather than named.
 *
 * `lorebooks.original` already carries this kind of note for the Story Builder's
 * own package; a manual container says what it is managed for in the same place.
 */
const markerOf = (row) => parse(row?.original, null)?.managedFor || null;

const findManaged = (db, kind, key, value) => {
  const row = db.raw.prepare(`
    SELECT id, name FROM lorebooks
     WHERE json_valid(original)
       AND json_extract(original, '$.managedFor.kind') = ?
       AND json_extract(original, '$.managedFor.${key}') = ?
     ORDER BY created_at LIMIT 1`).get(kind, value);
  return row || null;
};

/** Whether this source is one Nexus writes into, and what it is for. */
export function managedSource(db, lorebookId) {
  const row = db.raw.prepare('SELECT id, name, original FROM lorebooks WHERE id=?').get(lorebookId);
  if (!row) return null;
  const mark = markerOf(row);
  return mark && mark.kind ? { id: row.id, name: row.name, ...mark } : null;
}

/**
 * The one source that holds hand-written material about one person.
 *
 * Reusable: it belongs to them and travels with them, and a story reads it only
 * when the story carries it. Created once and found again by its mark.
 */
export function entityKnowledgeSource(db, entityId, { create = true } = {}) {
  const found = findManaged(db, 'entity-knowledge', 'entityId', entityId);
  if (found) return found.id;
  if (!create) return null;
  const entity = db.raw.prepare('SELECT id, canonical_name, type FROM lore_entities WHERE id=?').get(entityId);
  if (!entity) throw new AuthoringError('That person is not in your library.');
  const id = db.createLorebook(`${entity.canonical_name} — Knowledge`,
    'What you have written about them. Nexus keeps this together so it can travel with them.');
  db.raw.prepare('UPDATE lorebooks SET original=? WHERE id=?')
    .run(j({ managedFor: { kind: 'entity-knowledge', entityId } }), id);
  setSourceRole(db, {
    lorebookId: id, role: 'entity-material', origin: 'manual', status: 'approved',
    confidence: 'high', subjectEntityId: entityId, evidence: { written: 'by hand, on their profile' },
  });
  return id;
}

/**
 * The one source that holds what is true in a single story.
 *
 * Attached to that story and to no other, so continuity written for one telling
 * cannot wander into another.
 */
export function storyMaterialSource(db, storyId, { create = true } = {}) {
  const found = findManaged(db, 'story-material', 'storyId', storyId);
  if (found) {
    db.raw.prepare('INSERT OR IGNORE INTO story_lorebooks (story_id,lorebook_id) VALUES (?,?)').run(storyId, found.id);
    return found.id;
  }
  if (!create) return null;
  const story = db.raw.prepare('SELECT id, title FROM stories WHERE id=?').get(storyId);
  if (!story) throw new AuthoringError('That story is not in your library.');
  const id = db.createLorebook(`${story.title} — Story Material`,
    'What is true in this story only. It stays with this story.');
  db.raw.prepare('UPDATE lorebooks SET original=? WHERE id=?')
    .run(j({ managedFor: { kind: 'story-material', storyId } }), id);
  setSourceRole(db, {
    lorebookId: id, role: 'mixed', origin: 'manual', status: 'approved',
    confidence: 'high', ownerStoryId: storyId, evidence: { written: 'by hand, inside this story' },
  });
  db.raw.prepare('INSERT OR IGNORE INTO story_lorebooks (story_id,lorebook_id) VALUES (?,?)').run(storyId, id);
  return id;
}

// ------------------------------------------------------------------ checking

const cleanText = (s, what, max) => {
  const t = String(s ?? '').trim();
  if (!t) throw new AuthoringError(`${what} cannot be empty.`);
  if (t.length > max) throw new AuthoringError(`${what} is too long.`);
  return t;
};

/**
 * How an entry reaches a scene, in the two shapes a person is offered.
 *
 * "When it comes up" is the ordinary keyword entry; "Always available" is the
 * constant one. Everything else the engine supports is passed through untouched
 * for the advanced form — this module adds nothing of its own, and in
 * particular never adds the person's name as a trigger.
 */
function activationOf(input = {}, { existing = null } = {}) {
  const mode = input.mode === 'always' ? 'always' : 'keywords';
  const keys = (Array.isArray(input.keys) ? input.keys : [])
    .map((k) => String(k).trim()).filter(Boolean).slice(0, 24);
  if (mode === 'keywords' && !keys.length) {
    throw new AuthoringError('Say which words should bring this up, or make it always available.');
  }
  const advanced = input.advanced && typeof input.advanced === 'object' ? input.advanced : {};
  return {
    ...(existing || {}),
    enabled: input.enabled === false ? false : true,
    constant: mode === 'always',
    keys: mode === 'always' ? keys : keys,
    ...advanced,
  };
}

const knownEntity = (db, id) => db.raw.prepare('SELECT id, canonical_name, type FROM lore_entities WHERE id=?').get(id) || null;

/**
 * What a source calls someone inside itself.
 *
 * A name, not an id: this is the ref a package carries, and "patrick" reads
 * where a UUID does not. Kept the same once given, and nudged aside if another
 * person in the same source already answers to it.
 */
function localRefFor(db, lorebookId, entityId, name) {
  const mine = db.raw.prepare('SELECT local_ref FROM source_entities WHERE lorebook_id=? AND entity_id=?').get(lorebookId, entityId);
  if (mine) return mine.local_ref;
  const base = slugRef(name, 'person');
  let ref = base;
  for (let n = 2; db.raw.prepare('SELECT 1 x FROM source_entities WHERE lorebook_id=? AND local_ref=?').get(lorebookId, ref); n++) ref = `${base}-${n}`;
  return ref;
}

/** Everything the rows need, checked before a single one is written. */
function plan(db, { entityId, title, content, category, displayPath, activation, relatedEntityIds = [], existing = null }) {
  const entity = knownEntity(db, entityId);
  if (!entity) throw new AuthoringError('That person is not in your library.');
  if (!CATEGORIES.includes(category)) throw new AuthoringError(`"${category}" is not a kind of information Nexus keeps.`);
  const related = [...new Set((relatedEntityIds || []).map((r) => String(r)))].filter((r) => r !== entityId);
  for (const r of related) if (!knownEntity(db, r)) throw new AuthoringError('One of those connections is not in your library.');
  return {
    entity,
    title: cleanText(title, 'A title', 200),
    content: cleanText(content, 'The text', 20000),
    category,
    displayPath: displayPath ? normalizeDisplayPath(displayPath) : null,
    activation: activationOf(activation, { existing }),
    related,
  };
}

/** The rows themselves, written together or not at all. */
function writeRows(db, { lorebookId, entryId = null, p, entityId }) {
  const id = db.saveEntry(lorebookId, {
    ...(entryId ? { id: entryId } : {}),
    title: p.title,
    content: p.content,
    keys: p.activation.constant ? p.activation.keys : p.activation.keys,
    enabled: p.activation.enabled !== false,
    constant: !!p.activation.constant,
    kind: 'note',
    order: p.activation.order ?? 100,
    probability: p.activation.probability ?? 100,
    ...(p.activation.secondaryKeys ? { secondaryKeys: p.activation.secondaryKeys } : {}),
    ...(p.activation.selectiveLogic !== undefined ? { selectiveLogic: p.activation.selectiveLogic } : {}),
    ...(p.activation.position !== undefined ? { position: p.activation.position } : {}),
    ...(p.activation.depth !== undefined ? { depth: p.activation.depth } : {}),
  });

  // P1 refuses a relation to anyone the source has not declared, and it is right
  // to: a source says who it speaks of. Writing by hand declares them as part of
  // the same act rather than asking the person to do it.
  for (const ref of [entityId, ...p.related]) {
    const x = knownEntity(db, ref);
    declareInSource(db, {
      lorebookId, entityId: ref, localRef: localRefFor(db, lorebookId, ref, x.canonical_name), localName: x.canonical_name,
      origin: 'manual', status: 'approved', evidence: { written: 'by hand' },
    });
  }

  setEntrySemantics(db, {
    entryId: id,
    scope: 'entity',
    category: p.category,
    definesEntityId: null,
    origin: 'manual',
    status: 'approved',
    confidence: 'high',
    displayPath: p.displayPath,
    evidence: { written: 'by hand', at: now() },
  });
  setRelation(db, { entryId: id, entityId, relation: 'subject', origin: 'manual', status: 'approved', confidence: 'high' });

  // Connections that were removed go, so an edit is a statement of what is true
  // now rather than an addition to what was true before.
  const keep = new Set(p.related);
  for (const row of db.raw.prepare("SELECT entity_id FROM entry_relations WHERE entry_id=? AND relation='related'").all(id)) {
    if (!keep.has(row.entity_id)) db.raw.prepare('DELETE FROM entry_relations WHERE entry_id=? AND entity_id=?').run(id, row.entity_id);
  }
  for (const ref of p.related) {
    setRelation(db, { entryId: id, entityId: ref, relation: 'related', origin: 'manual', status: 'approved', confidence: 'high' });
  }
  return id;
}

// -------------------------------------------------------------- the two verbs

/**
 * Write something new about someone.
 *
 * With a story, it belongs to that story and stays there. Without one, it is
 * theirs and can be used again — which is not the same as being everywhere:
 * a story still reads it only if it carries the source.
 *
 * @returns {{ entryId, lorebookId, scope: 'story'|'reusable' }}
 */
export function createEntityKnowledge(db, {
  entityId, storyId = null, title, content, category,
  displayPath = null, activation = {}, relatedEntityIds = [],
}) {
  const p = plan(db, { entityId, title, content, category, displayPath, activation, relatedEntityIds });
  return db.transaction(() => {
    const lorebookId = storyId ? storyMaterialSource(db, storyId) : entityKnowledgeSource(db, entityId);
    const entryId = writeRows(db, { lorebookId, p, entityId });
    return { entryId, lorebookId, scope: storyId ? 'story' : 'reusable' };
  });
}

/**
 * Change something written by hand.
 *
 * The entry and its reading move together, so the hash still matches and the
 * profile does not tell someone their own edit needs reviewing. Material that
 * came from elsewhere is refused here: it is managed where it came from.
 */
export function updateEntityKnowledge(db, entryId, {
  title, content, category, displayPath = null, activation = {}, relatedEntityIds = [],
}) {
  const row = db.raw.prepare('SELECT id, lorebook_id FROM lore_entries WHERE id=?').get(entryId);
  if (!row) throw new AuthoringError('That entry is no longer there.');
  const managed = managedSource(db, row.lorebook_id);
  if (!managed) throw new AuthoringError('That came from a source you imported, and is edited there.');
  const subject = db.raw.prepare("SELECT entity_id FROM entry_relations WHERE entry_id=? AND relation='subject' AND status='approved'").get(entryId);
  const defines = db.raw.prepare('SELECT defines_entity_id FROM entry_semantics WHERE entry_id=?').get(entryId);
  const entityId = subject?.entity_id || defines?.defines_entity_id;
  if (!entityId) throw new AuthoringError('That entry is not about anyone yet.');
  const existing = db.raw.prepare('SELECT ord, probability, position, depth, secondary_keys FROM lore_entries WHERE id=?').get(entryId);
  const p = plan(db, {
    entityId, title, content, category, displayPath, activation, relatedEntityIds,
    existing: { order: existing.ord, probability: existing.probability, position: existing.position, depth: existing.depth },
  });
  return db.transaction(() => {
    writeRows(db, { lorebookId: row.lorebook_id, entryId, p, entityId });
    return { entryId, lorebookId: row.lorebook_id, scope: managed.kind === 'story-material' ? 'story' : 'reusable' };
  });
}

/**
 * Take back something written by hand.
 *
 * Only Nexus's own containers, and only an entry that nothing else stands on:
 * an entry that introduces someone is what other entries point at, so it is not
 * removed from here. The entry and everything said about it go together.
 */
export function deleteEntityKnowledge(db, entryId) {
  const row = db.raw.prepare('SELECT id, lorebook_id, title FROM lore_entries WHERE id=?').get(entryId);
  if (!row) throw new AuthoringError('That entry is no longer there.');
  if (!managedSource(db, row.lorebook_id)) throw new AuthoringError('That came from a source you imported, and is managed there.');
  const semantics = db.raw.prepare('SELECT defines_entity_id FROM entry_semantics WHERE entry_id=?').get(entryId);
  if (semantics?.defines_entity_id) throw new AuthoringError('That entry is what introduces someone, so it cannot be removed here.');
  return db.transaction(() => {
    db.raw.prepare('DELETE FROM entry_relations WHERE entry_id=?').run(entryId);
    db.raw.prepare('DELETE FROM entry_semantics WHERE entry_id=?').run(entryId);
    db.deleteEntry(entryId);
    return { entryId, title: row.title };
  });
}

/** Words worth suggesting as triggers, from the title alone. */
export function suggestedKeys(title, { avoid = [] } = {}) {
  const stop = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'his', 'her', 'their', 'with', 'for', 'to']);
  const away = new Set(avoid.flatMap((n) => String(n).toLowerCase().split(/\s+/)).filter(Boolean));
  const whole = String(title || '').trim().toLowerCase();
  const words = whole.split(/[^a-z0-9']+/i).filter((w) => w.length > 2 && !stop.has(w) && !away.has(w));
  // The whole title first, then its own words — never the person's name, which
  // would bring everything about them at once.
  const out = [];
  if (whole && whole.length > 2 && !away.has(whole)) out.push(whole);
  for (const w of words) if (!out.includes(w)) out.push(w);
  return out.slice(0, 5);
}

/** A hash of the entry exactly as stored, for tests and for checking. */
export function hashOfEntry(db, entryId) {
  const e = db.raw.prepare('SELECT title, content, keys FROM lore_entries WHERE id=?').get(entryId);
  return e ? entryHash({ title: e.title, content: e.content, keys: parse(e.keys, []) }) : null;
}
