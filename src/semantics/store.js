// Reading and writing the semantic model.
//
// Primitives only (P1). Nothing here decides what anything is: conversion,
// native import and manual authoring will call these with decisions already
// made, and until they exist nothing writes approved semantics at all.
//
// Every write that could leave the model half-done runs in a transaction.

import { randomUUID } from 'node:crypto';
import { entryHash, semanticView, organizationState } from './authority.js';
import { ENTITY_TYPES, PERSON_CATEGORIES, WORLD_CATEGORIES, PACKAGE_ROLES, packageRoleView } from './authority.js';

const now = () => Date.now();
const j = (v) => JSON.stringify(v ?? null);
const parse = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

export class SemanticError extends Error {
  constructor(message) { super(message); this.name = 'SemanticError'; this.status = 400; }
}

const q = (db) => ({
  all: (sql, ...a) => db.raw.prepare(sql).all(...a),
  get: (sql, ...a) => db.raw.prepare(sql).get(...a),
  run: (sql, ...a) => db.raw.prepare(sql).run(...a),
});

// ------------------------------------------------------------------ entities

/** A new semantic entity. It belongs to no source and holds no card. */
export function createEntity(db, { type, name, aliases = [] }) {
  if (!ENTITY_TYPES.includes(type)) throw new SemanticError(`"${type}" is not an entity type.`);
  if (!String(name || '').trim()) throw new SemanticError('An entity needs a name.');
  const id = randomUUID();
  q(db).run(`INSERT INTO lore_entities (id,type,canonical_name,aliases,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    id, type, String(name).trim(), j(aliases), now(), now());
  return id;
}

export function getEntity(db, id) {
  const r = q(db).get(`SELECT * FROM lore_entities WHERE id=?`, id);
  return r ? { ...r, aliases: parse(r.aliases, []) } : null;
}

/** Follow approved merges to the entity that stands for this one now. */
export function currentEntity(db, id) {
  let e = getEntity(db, id);
  const seen = new Set();
  while (e && e.merged_into_id && !seen.has(e.id)) { seen.add(e.id); e = getEntity(db, e.merged_into_id); }
  return e;
}

/**
 * A source says it describes an entity.
 *
 * Declaring an existing entity from a second source is how one Patrick spans
 * several sources — and is only ever done on an explicit decision.
 */
export function declareInSource(db, { lorebookId, entityId, localRef, localName = '', localAliases = [], origin, status, evidence = {} }) {
  if (!['native', 'converted', 'manual', 'generated'].includes(origin)) throw new SemanticError('A declaration needs an origin.');
  if (!['proposed', 'approved'].includes(status)) throw new SemanticError('A declaration is proposed or approved.');
  q(db).run(`INSERT INTO source_entities (lorebook_id,entity_id,local_ref,local_name,local_aliases,origin,status,evidence,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(lorebook_id, entity_id) DO UPDATE SET
               local_ref=excluded.local_ref, local_name=excluded.local_name, local_aliases=excluded.local_aliases,
               origin=excluded.origin, status=excluded.status, evidence=excluded.evidence, updated_at=excluded.updated_at`,
  lorebookId, entityId, localRef, localName, j(localAliases), origin, status, j(evidence), now(), now());
}

export function declarationsOf(db, lorebookId) {
  return q(db).all(`SELECT * FROM source_entities WHERE lorebook_id=?`, lorebookId);
}

/** Everything that refers to an entity. An entity with none is unused, and still never removed automatically. */
export function entityUsage(db, entityId) {
  const c = (sql) => q(db).get(sql, entityId).n;
  return {
    sources: c(`SELECT COUNT(*) n FROM source_entities WHERE entity_id=?`),
    definedBy: c(`SELECT COUNT(*) n FROM entry_semantics WHERE defines_entity_id=?`),
    relations: c(`SELECT COUNT(*) n FROM entry_relations WHERE entity_id=?`),
    storyCards: c(`SELECT COUNT(*) n FROM story_entity_cards WHERE entity_id=?`),
    storyCast: c(`SELECT COUNT(*) n FROM story_npcs WHERE entity_id=?`),
  };
}

// ------------------------------------------------------------------ sources

/**
 * Record what a source as a whole is for.
 *
 * Separate from what its entries mean: Living Scene's entries are directions,
 * and the package is a narrative framework. A native package's declared role
 * is stored as approved; an inferred one only ever as proposed.
 */
export function setSourceRole(db, { lorebookId, role, origin, status, confidence = null, evidence = {}, domains = [], subjectEntityId: askedSubject = null, ownerStoryId = null }) {
  if (!PACKAGE_ROLES.includes(role)) throw new SemanticError(`"${role}" is not a package role.`);
  // Only material that travels with somebody has somebody to travel with. A
  // subject on any other role is inert — nothing reads it, because everything
  // that reads it asks for entity-material first — and inert data that names a
  // person is worse than none: it says this source is theirs when it is not.
  // So it does not persist, whatever a caller asks for.
  const subjectEntityId = role === 'entity-material' ? askedSubject : null;
  if (subjectEntityId && !getEntity(db, subjectEntityId)) throw new SemanticError('No such entity for this source to be about.');
  if (ownerStoryId && !q(db).get(`SELECT 1 FROM stories WHERE id=?`, ownerStoryId)) throw new SemanticError('No such story to own this source.');
  if (subjectEntityId && ownerStoryId) throw new SemanticError("A source is either reusable material about someone, or one story's own material — not both.");
  // Domains are tags: lower-case words, deduplicated, nothing more.
  const tags = [...new Set((Array.isArray(domains) ? domains : []).map((d) => String(d).trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean))];
  if (!['native', 'converted', 'manual', 'inferred'].includes(origin)) throw new SemanticError('A package role needs an origin.');
  if (!['proposed', 'approved'].includes(status)) throw new SemanticError('A package role is proposed or approved.');
  if (status === 'approved' && origin === 'inferred') throw new SemanticError('An inferred role cannot be approved as it stands; a person approves it through review.');
  q(db).run(`INSERT INTO source_semantics (lorebook_id,package_role,domains,subject_entity_id,owner_story_id,origin,status,confidence,evidence,reviewed_at,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(lorebook_id) DO UPDATE SET package_role=excluded.package_role, domains=excluded.domains,
               subject_entity_id=excluded.subject_entity_id, owner_story_id=excluded.owner_story_id,
               origin=excluded.origin, status=excluded.status, confidence=excluded.confidence, evidence=excluded.evidence,
               reviewed_at=excluded.reviewed_at, updated_at=excluded.updated_at`,
  lorebookId, role, j(tags), subjectEntityId, ownerStoryId, origin, status, confidence, j(evidence), status === 'approved' ? now() : null, now(), now());
}

// ------------------------------------------------------------ resources

/**
 * Say which person a card or persona represents.
 *
 * Only called on an explicit decision: a native package binding its own
 * character to its own entity, or a person choosing in review. The resource
 * must not already represent someone else.
 */
function bindResource(db, table, resourceId, entityId) {
  const row = q(db).get(`SELECT id, entity_id FROM ${table} WHERE id=?`, resourceId);
  if (!row) throw new SemanticError(table === 'characters' ? 'No such character.' : 'No such persona.');
  const entity = getEntity(db, entityId);
  if (!entity) throw new SemanticError('No such entity.');
  if (entity.type !== 'person') throw new SemanticError(`A ${table === 'characters' ? 'character' : 'persona'} represents a person, not a ${entity.type}.`);
  if (row.entity_id && row.entity_id !== entityId) throw new SemanticError('This already represents someone else. Changing that is a separate decision.');
  q(db).run(`UPDATE ${table} SET entity_id=? WHERE id=?`, entityId, resourceId);
}
export const bindCharacterEntity = (db, characterId, entityId) => bindResource(db, 'characters', characterId, entityId);
export const bindPersonaEntity = (db, personaId, entityId) => bindResource(db, 'personas', personaId, entityId);

/** A display path as stored: a short list of non-empty group names, or null. */
export function normalizeDisplayPath(path) {
  if (path === null || path === undefined) return null;
  if (!Array.isArray(path) || !path.length || path.length > 8) throw new SemanticError('A display path is a list of one to eight group names.');
  const clean = path.map((s) => (typeof s === 'string' ? s.trim() : ''));
  if (clean.some((s) => !s || s.length > 80)) throw new SemanticError('Each group name in a display path is 1 to 80 characters.');
  return clean;
}

export function sourceRole(db, lorebookId) {
  return packageRoleView(q(db).get(`SELECT * FROM source_semantics WHERE lorebook_id=?`, lorebookId));
}

// ------------------------------------------------------------------ entries

const CATEGORIES = new Set([...PERSON_CATEGORIES, ...WORLD_CATEGORIES, 'profile']);

/**
 * Record what an entry is.
 *
 * Approving stores the entry's hash, so a later edit shows as NEEDS RECHECK
 * instead of silently keeping or losing the decision. Proposed rows carry no
 * hash: they were never reviewed.
 */
export function setEntrySemantics(db, { entryId, scope, category, definesEntityId = null, origin, status, confidence = null, evidence = {}, activationPolicy = null, displayPath = null }) {
  const path = normalizeDisplayPath(displayPath);
  if (!['entity', 'world', 'other'].includes(scope)) throw new SemanticError(`"${scope}" is not a scope.`);
  if (!CATEGORIES.has(category)) throw new SemanticError(`"${category}" is not a category.`);
  if (!['native', 'converted', 'manual', 'generated', 'inferred'].includes(origin)) throw new SemanticError('Semantics need an origin.');
  if (!['proposed', 'approved'].includes(status)) throw new SemanticError('Semantics are proposed or approved.');
  // An inference is a suggestion. Nothing a machine guessed is approved here.
  if (status === 'approved' && origin === 'inferred') throw new SemanticError('An inference cannot be approved as it stands; a person approves it through review.');
  const entry = q(db).get(`SELECT id, title, content, keys, lorebook_id FROM lore_entries WHERE id=?`, entryId);
  if (!entry) throw new SemanticError('No such entry.');
  if (definesEntityId) {
    const declared = q(db).get(`SELECT 1 FROM source_entities WHERE lorebook_id=? AND entity_id=?`, entry.lorebook_id, definesEntityId);
    if (!declared) throw new SemanticError('An entry can only define an entity its own source declares.');
  }
  const hash = status === 'approved' ? entryHash({ ...entry, keys: parse(entry.keys, []) }) : null;
  if (activationPolicy !== null && !['always', 'keywords', 'advanced'].includes(activationPolicy)) {
    // 'auto' is reserved in the table and not designed yet.
    throw new SemanticError(`"${activationPolicy}" is not an activation policy in use.`);
  }
  q(db).run(`INSERT INTO entry_semantics (entry_id,scope,category,defines_entity_id,origin,status,confidence,evidence,content_hash,activation_policy,display_path,reviewed_at,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(entry_id) DO UPDATE SET
               scope=excluded.scope, category=excluded.category, defines_entity_id=excluded.defines_entity_id,
               origin=excluded.origin, status=excluded.status, confidence=excluded.confidence, evidence=excluded.evidence,
               content_hash=excluded.content_hash, activation_policy=excluded.activation_policy, display_path=excluded.display_path,
               reviewed_at=excluded.reviewed_at, updated_at=excluded.updated_at`,
  entryId, scope, category, definesEntityId, origin, status, confidence, j(evidence), hash, activationPolicy,
  path ? JSON.stringify(path) : null, status === 'approved' ? now() : null, now(), now());
}

/**
 * Say what an entry is about.
 *
 * The database refuses a second approved subject for one entry; this says so
 * in words first. The entity must be one the entry's source declares.
 */
export function setRelation(db, { entryId, entityId, relation, origin, status, confidence = null, evidence = {} }) {
  if (!['subject', 'related'].includes(relation)) throw new SemanticError(`"${relation}" is not a relation.`);
  if (!['proposed', 'approved'].includes(status)) throw new SemanticError('A relation is proposed or approved.');
  if (status === 'approved' && origin === 'inferred') throw new SemanticError('An inference cannot be approved as it stands; a person approves it through review.');
  const entry = q(db).get(`SELECT lorebook_id FROM lore_entries WHERE id=?`, entryId);
  if (!entry) throw new SemanticError('No such entry.');
  if (!q(db).get(`SELECT 1 FROM source_entities WHERE lorebook_id=? AND entity_id=?`, entry.lorebook_id, entityId)) {
    throw new SemanticError('An entry can only be about an entity its own source declares.');
  }
  if (relation === 'subject' && status === 'approved') {
    const other = q(db).get(`SELECT entity_id FROM entry_relations WHERE entry_id=? AND relation='subject' AND status='approved' AND entity_id<>?`, entryId, entityId);
    if (other) throw new SemanticError('This entry already has an approved subject. An entry is about one entity at most; others can be related.');
  }
  q(db).run(`INSERT INTO entry_relations (entry_id,entity_id,relation,origin,status,confidence,evidence,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?)
             ON CONFLICT(entry_id, entity_id) DO UPDATE SET relation=excluded.relation, origin=excluded.origin,
               status=excluded.status, confidence=excluded.confidence, evidence=excluded.evidence, updated_at=excluded.updated_at`,
  entryId, entityId, relation, origin, status, confidence, j(evidence), now(), now());
}

/** Record once that two entities are not the same. A≠B and B≠A are one decision. */
export function distinguish(db, a, b) {
  if (!a || !b || a === b) throw new SemanticError('Two different entities are needed.');
  const [x, y] = a < b ? [a, b] : [b, a];
  q(db).run(`INSERT OR IGNORE INTO entity_distinctions (entity_a, entity_b, decided_at) VALUES (?,?,?)`, x, y, now());
}
export function areDistinct(db, a, b) {
  const [x, y] = a < b ? [a, b] : [b, a];
  return !!q(db).get(`SELECT 1 FROM entity_distinctions WHERE entity_a=? AND entity_b=?`, x, y);
}

/** Which card stands for an entity in one story. */
export function bindCard(db, { storyId, entityId, characterId }) {
  q(db).run(`INSERT INTO story_entity_cards (story_id,entity_id,character_id,created_at) VALUES (?,?,?,?)
             ON CONFLICT(story_id, entity_id) DO UPDATE SET character_id=excluded.character_id`, storyId, entityId, characterId, now());
}

// ------------------------------------------------------------------ reading

/**
 * Semantic views for a set of entries, keyed by entry id.
 *
 * Entries without semantics simply have no view: callers fall back to the
 * legacy reading for those, and only those.
 */
export function semanticViews(db, entries) {
  const views = new Map();
  if (!entries.length) return views;
  const ids = entries.map((e) => e.id);
  const marks = ids.map(() => '?').join(',');
  const rows = new Map(q(db).all(`SELECT * FROM entry_semantics WHERE entry_id IN (${marks})`, ...ids).map((r) => [r.entry_id, r]));
  if (!rows.size) return views;
  const rels = q(db).all(`SELECT * FROM entry_relations WHERE entry_id IN (${marks})`, ...ids);
  const entityIds = new Set([...rels.map((r) => r.entity_id), ...[...rows.values()].map((r) => r.defines_entity_id).filter(Boolean)]);
  const entities = new Map([...entityIds].map((id) => [id, currentEntity(db, id)]));
  for (const e of entries) {
    const row = rows.get(e.id);
    if (!row) continue;
    const mine = rels.filter((r) => r.entry_id === e.id).map((r) => ({ ...r, entity: entities.get(r.entity_id) }));
    views.set(e.id, semanticView(e, row, mine, row.defines_entity_id ? entities.get(row.defines_entity_id) : null));
  }
  return views;
}

/** How organised one source is, and what it is for. The role is reported, never required for "organized". */
export function sourceOrganization(db, lorebookId) {
  const entries = db.listEntries(lorebookId);
  return { ...organizationState(entries, semanticViews(db, entries), declarationsOf(db, lorebookId)), packageRole: sourceRole(db, lorebookId) };
}

/**
 * The person a cast entry IS, when that is certain; otherwise null.
 *
 * Certain means all of: the entry has approved semantics defining an entity,
 * that entity is a person, and the entry's own source has an approved
 * declaration of it. Anything less is left unresolved rather than guessed.
 */
/**
 * The one person an entry stands for, by approved semantics alone.
 *
 * Two readings count, and only two: the entry defines a person, or it names
 * exactly one approved subject who is a person. A stale reading — approved,
 * then the words moved — still counts, and says so. A proposal does not. Nor
 * does a name, a keyword, a card, or an old composer link: none of those is an
 * identity, and this is the one place identity is decided.
 *
 * @returns {{ entityId, name, how: 'defines'|'subject', stale: boolean }|null}
 */
export function resolveEntryPerson(db, entryId) {
  const sem = q(db).get(`SELECT s.defines_entity_id, s.content_hash, e.title, e.content, e.keys
    FROM entry_semantics s JOIN lore_entries e ON e.id = s.entry_id
    WHERE s.entry_id = ? AND s.status = 'approved'`, entryId);
  if (!sem) return null;
  let stale = false;
  if (sem.content_hash) {
    let keys = [];
    try { keys = JSON.parse(sem.keys || '[]'); } catch { keys = []; }
    stale = sem.content_hash !== entryHash({ title: sem.title, content: sem.content, keys });
  }
  const person = (id) => { const cur = currentEntity(db, id); return cur && cur.type === 'person' ? cur : null; };
  if (sem.defines_entity_id) {
    const who = person(sem.defines_entity_id);
    return who ? { entityId: who.id, name: who.canonical_name, how: 'defines', stale } : null;
  }
  const subjects = q(db).all(`SELECT entity_id FROM entry_relations
    WHERE entry_id = ? AND relation = 'subject' AND status = 'approved'`, entryId);
  if (subjects.length !== 1) return null;
  const who = person(subjects[0].entity_id);
  return who ? { entityId: who.id, name: who.canonical_name, how: 'subject', stale } : null;
}

/** The person a cast row IS, or null. Same rule as resolveEntryPerson; only the id. */
export function resolveNpcEntity(db, entryId) {
  return resolveEntryPerson(db, entryId)?.entityId || null;
}

// ------------------------------------------------------------------ evidence

/**
 * Keep a link someone accepted in review as evidence for later conversion.
 *
 * Composition and Builder review used to write these as "about" links. They
 * were pre-ticked suggestions, not confirmations, so from P1 they are kept
 * here — no foreign keys, names snapshotted — and never become semantics.
 */
export function recordLinkEvidence(db, { source, entryId, characterId = null, aboutId = null }) {
  const entry = q(db).get(`SELECT title, lorebook_id, original FROM lore_entries WHERE id=?`, entryId);
  if (!entry) return;
  const origin = (() => { try { return JSON.parse(entry.original)?.origin || null; } catch { return null; } })();
  const target = characterId
    ? { kind: 'character', id: characterId, name: q(db).get(`SELECT name FROM characters WHERE id=?`, characterId)?.name || '' }
    : { kind: 'entry', id: aboutId, name: q(db).get(`SELECT title FROM lore_entries WHERE id=?`, aboutId)?.title || '' };
  if (!target.id) return;
  q(db).run(`INSERT OR IGNORE INTO legacy_entry_links
               (source, entry_id, target_kind, target_id, entry_title, entry_book_id, entry_origin, target_name, derived_origin, recorded_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
  source, entryId, target.kind, target.id, entry.title, entry.lorebook_id, origin, target.name,
  source === 'builder-review' ? 'builder-accepted' : 'composer-inferred', now());
}

export function linkEvidenceFor(db, entryId) {
  return q(db).all(`SELECT * FROM legacy_entry_links WHERE entry_id=? ORDER BY recorded_at`, entryId);
}
