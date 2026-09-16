// Writing down what a person decided in Review.
//
//   applyReview(db, lorebookId, decisions) → { entities, entries, … }
//
// This is the only place a legacy source becomes organised, and it only ever
// records decisions that were made: everything it writes is `status: approved`
// with `origin: converted`, because a person looked at the deterministic
// proposal and said yes. The proposal's own evidence is stored alongside, so
// Nexus can still explain why it was suggested.
//
// What it never touches: the entries themselves. Titles, content, the stored
// kind, keywords, activation, enabled state and every timing field are left
// exactly as they are, and so are stories, memory, state and character cards.
// Organising is about meaning, not about rewriting what you wrote.
//
// Partial by design: entries that were left undecided stay unorganised, so one
// hard entry in a source of two hundred cannot hold up the rest.
//
// ── What Review sends ────────────────────────────────────────────────────
//
// {
//   role: { role, subject: entityRef|null } | null,
//   entities: [{ ref, type, name, aliases[], decision: 'new'|'existing'|'skip', entityId? }],
//   entries:  [{ ref, entryId, hash, approve: true|false,
//                scope, category, defines: ref|null, subject: ref|null, related: [ref], displayPath }],
//   matches:  [{ entity: ref, entityId, decision: 'same'|'separate'|'later' }],
//   evidence: { entryRef: […], entityRef: […] }        // from the preview, stored as the reason
// }
//
// Entity refs are the draft's own. A ref that was applied before is recognised
// by the declaration it left behind, so applying twice changes nothing.

import { entryHash, PERSON_CATEGORIES, WORLD_CATEGORIES, ENTITY_TYPES, PACKAGE_ROLES } from '../semantics/authority.js';
import {
  createEntity, currentEntity, declareInSource, setEntrySemantics, setRelation, setSourceRole,
  distinguish, areDistinct, SemanticError,
} from '../semantics/store.js';

const CATEGORIES = new Set([...PERSON_CATEGORIES, ...WORLD_CATEGORIES, 'profile']);

export class ReviewError extends Error {
  constructor(message, { status = 400, problems = [], stale = [] } = {}) {
    super(message);
    this.name = 'ReviewError';
    this.status = status;
    this.problems = problems;
    this.stale = stale;
  }
}

/**
 * Apply one reviewed draft, in a single transaction.
 *
 * @returns {{ entities: Record<string,string>, entries: string[], skipped: string[], distinctions: number, role: string|null }}
 */
export function applyReview(db, lorebookId, decisions = {}) {
  const book = db.raw.prepare('SELECT id FROM lorebooks WHERE id=?').get(lorebookId);
  if (!book) throw new ReviewError('No such source.', { status: 404 });

  const entities = Array.isArray(decisions.entities) ? decisions.entities : [];
  const entries = Array.isArray(decisions.entries) ? decisions.entries : [];
  const matches = Array.isArray(decisions.matches) ? decisions.matches : [];
  const evidence = decisions.evidence && typeof decisions.evidence === 'object' ? decisions.evidence : {};
  const problems = [];
  const fail = (path, message) => problems.push({ path, message });

  const byRef = new Map(entities.map((e) => [e.ref, e]));
  const approved = entries.filter((e) => e.approve);

  // ---- nothing is written against text that has changed since the draft was made
  const stale = [];
  const rows = new Map(db.raw.prepare('SELECT id, lorebook_id, title, content, keys FROM lore_entries WHERE lorebook_id=?').all(lorebookId).map((r) => [r.id, r]));
  for (const e of approved) {
    const row = rows.get(e.entryId);
    if (!row) { stale.push({ ref: e.ref, entryId: e.entryId, reason: 'the entry is no longer in this source' }); continue; }
    let keys = [];
    try { keys = JSON.parse(row.keys || '[]'); } catch { keys = []; }
    if (!e.hash || entryHash({ title: row.title, content: row.content, keys }) !== e.hash) {
      stale.push({ ref: e.ref, entryId: e.entryId, title: row.title, reason: 'the entry changed after this review was opened' });
    }
  }
  if (stale.length) {
    throw new ReviewError('This source changed while you were reviewing it. Open the review again so the proposals match what is there now.', { status: 409, stale });
  }

  // ---- the shape of what was decided
  const used = new Set();
  for (const e of approved) {
    const path = `entries.${e.ref}`;
    if (!['entity', 'world', 'other'].includes(e.scope)) fail(path, `"${e.scope}" is not a scope.`);
    if (!CATEGORIES.has(e.category)) fail(path, `"${e.category}" is not a category.`);
    if (e.defines && e.subject) fail(path, 'An entry either defines someone or is about someone, not both.');
    if (e.scope === 'entity' && !e.defines && !e.subject) fail(path, 'This is about an entity, so it needs to say which one.');
    if (e.scope !== 'entity' && (e.defines || e.subject)) fail(path, 'Only an entity entry has a subject or defines an entity.');
    for (const ref of [e.defines, e.subject, ...(e.related || [])].filter(Boolean)) {
      if (!byRef.has(ref)) fail(path, `"${ref}" is not one of the people or places in this review.`);
      used.add(ref);
    }
    if ((e.related || []).some((r) => r === e.subject || r === e.defines)) fail(path, 'Something cannot be both what an entry is about and merely related to it.');
    if (e.displayPath !== null && e.displayPath !== undefined) {
      if (!Array.isArray(e.displayPath) || !e.displayPath.length || e.displayPath.some((g) => typeof g !== 'string' || !g.trim())) fail(path, 'A display group is a short list of names.');
    }
  }
  const role = decisions.role || null;
  if (role) {
    if (!PACKAGE_ROLES.includes(role.role)) fail('role', `"${role.role}" is not a kind of source.`);
    if (role.subject) {
      if (!byRef.has(role.subject)) fail('role', 'The main subject is not one of the people in this review.');
      used.add(role.subject);
    }
    if (role.role === 'entity-material' && !role.subject) fail('role', 'Material about someone needs to say who.');
  }
  for (const ref of used) {
    const x = byRef.get(ref);
    if (!x) continue;
    if (!ENTITY_TYPES.includes(x.type)) fail(`entities.${ref}`, `"${x.type}" is not a kind of thing.`);
    if (!String(x.name || '').trim()) fail(`entities.${ref}`, 'This needs a name.');
    if (x.decision === 'skip') fail(`entities.${ref}`, `"${x.name}" is used by an entry but was left out of the review.`);
    if (x.decision === 'existing' && !x.entityId) fail(`entities.${ref}`, 'No existing person or place was chosen.');
  }
  for (const m of matches) {
    if (!['same', 'separate', 'later'].includes(m.decision)) fail(`matches.${m.entity}`, 'A match is the same, separate, or decided later.');
    if (m.decision !== 'later' && !m.entityId) fail(`matches.${m.entity}`, 'That decision needs an existing person or place to point at.');
    if (m.decision === 'same') {
      const x = byRef.get(m.entity);
      if (x && x.decision === 'existing' && x.entityId && x.entityId !== m.entityId) fail(`matches.${m.entity}`, 'This says it is two different existing people at once.');
    }
  }
  if (problems.length) throw new ReviewError('Some of these decisions cannot be saved as they are.', { problems });

  // ---- write
  return db.transaction(() => {
    const declared = new Map(db.raw.prepare(`SELECT local_ref, entity_id FROM source_entities WHERE lorebook_id=?`).all(lorebookId).map((r) => [r.local_ref, r.entity_id]));
    const resolved = new Map();
    const sameAs = new Map(matches.filter((m) => m.decision === 'same').map((m) => [m.entity, m.entityId]));

    const entityFor = (ref) => {
      if (resolved.has(ref)) return resolved.get(ref);
      const x = byRef.get(ref);
      const chosen = sameAs.get(ref) || (x.decision === 'existing' ? x.entityId : null);
      let id;
      if (chosen) {
        const existing = currentEntity(db, chosen);
        if (!existing) throw new ReviewError(`The person or place chosen for "${x.name}" no longer exists.`, { problems: [{ path: `entities.${ref}`, message: 'It has been removed.' }] });
        if (existing.type !== x.type) throw new ReviewError(`"${existing.canonical_name}" is a ${existing.type}, not a ${x.type}.`, { problems: [{ path: `entities.${ref}`, message: 'Types differ.' }] });
        id = existing.id;
      } else if (declared.has(ref)) {
        // Applied before under this same ref: the entity it made is the one to keep.
        id = currentEntity(db, declared.get(ref))?.id || declared.get(ref);
        db.raw.prepare('UPDATE lore_entities SET canonical_name=?, aliases=?, updated_at=? WHERE id=?')
          .run(String(x.name).trim(), JSON.stringify(x.aliases || []), Date.now(), id);
      } else {
        id = createEntity(db, { type: x.type, name: x.name, aliases: x.aliases || [] });
      }
      declareInSource(db, {
        lorebookId, entityId: id, localRef: ref, localName: String(x.name).trim(), localAliases: x.aliases || [],
        origin: 'converted', status: 'approved',
        evidence: { proposedBy: 'deterministic-conversion', decidedIn: 'review', why: evidence[ref] || x.evidence || [] },
      });
      resolved.set(ref, id);
      return id;
    };

    for (const ref of used) entityFor(ref);

    const applied = [];
    for (const e of approved) {
      const definesId = e.defines ? resolved.get(e.defines) : null;
      const subjectId = e.subject ? resolved.get(e.subject) : null;
      const relatedIds = (e.related || []).map((r) => resolved.get(r));
      setEntrySemantics(db, {
        entryId: e.entryId, scope: e.scope, category: e.category, definesEntityId: definesId,
        origin: 'converted', status: 'approved', confidence: e.confidence || null,
        displayPath: e.displayPath || null,
        evidence: { proposedBy: 'deterministic-conversion', decidedIn: 'review', why: evidence[e.ref] || e.evidence || [] },
      });
      // Relations this entry no longer claims are removed, so a changed decision
      // does not leave the old one behind.
      const keep = new Set([subjectId, ...relatedIds].filter(Boolean));
      for (const row of db.raw.prepare('SELECT entity_id FROM entry_relations WHERE entry_id=?').all(e.entryId)) {
        if (!keep.has(row.entity_id)) db.raw.prepare('DELETE FROM entry_relations WHERE entry_id=? AND entity_id=?').run(e.entryId, row.entity_id);
      }
      if (subjectId) setRelation(db, { entryId: e.entryId, entityId: subjectId, relation: 'subject', origin: 'converted', status: 'approved' });
      for (const id of relatedIds) setRelation(db, { entryId: e.entryId, entityId: id, relation: 'related', origin: 'converted', status: 'approved' });
      applied.push(e.ref);
    }

    if (role) {
      setSourceRole(db, {
        lorebookId, role: role.role, origin: 'converted', status: 'approved',
        subjectEntityId: role.subject ? resolved.get(role.subject) : null,
        evidence: { proposedBy: 'deterministic-conversion', decidedIn: 'review', why: evidence.role || [] },
      });
    }

    let distinctions = 0;
    for (const m of matches) {
      if (m.decision !== 'separate') continue;
      const mine = resolved.get(m.entity);
      const other = currentEntity(db, m.entityId)?.id;
      if (!mine || !other || mine === other) continue;
      if (!areDistinct(db, mine, other)) { distinguish(db, mine, other); distinctions++; }
    }

    return {
      entities: Object.fromEntries(resolved),
      entries: applied,
      skipped: entries.filter((e) => !e.approve).map((e) => e.ref),
      distinctions,
      role: role ? role.role : null,
    };
  });
}

export { SemanticError };
