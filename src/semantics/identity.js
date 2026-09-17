// Saying that a card and a person in your lore are the same person.
//
// Everything semantic hangs off the entity: the knowledge about somebody, what
// travels with them, what one story added. A card or a persona is only a way
// of playing a person, so until Nexus is told which person a card represents,
// it can say nothing about them beyond the card's own fields.
//
// That answer is never guessed. A name is not an identity: two stories may each
// have a Patrick Moretti who must never learn the other's history. So Nexus
// gathers what it actually knows — a source written from this card, a part this
// card has already played in a story, entries that once pointed at it, people
// with the same name — presents it as evidence, and waits.
//
//   evidence orders the list
//   a person chooses
//   choosing "someone new" keeps same-named people apart, on purpose
//
// Connecting writes one column. It never rewrites a card, merges two people,
// moves an entry, attaches anything to a story, or asks a provider anything.
// Disconnecting writes the same column back, and says first what will stop
// being shown.

import { createHash } from 'node:crypto';
import {
  SemanticError, currentEntity, getEntity, createEntity,
  bindCharacterEntity, bindPersonaEntity, distinguish, areDistinct,
} from './store.js';
import { reuseState } from './reuse.js';

const KINDS = { character: 'characters', persona: 'personas' };
const WORD = { character: 'character', persona: 'persona' };

/** How much a piece of evidence is worth, and what it is called out loud. */
const EVIDENCE = {
  'own-source': { rank: 4, say: 'A source you organised says this is who they are' },
  'story-card': { rank: 3, say: 'You already played this card as them in a story' },
  'from-entry': { rank: 4, say: 'This follows a lore entry about them' },
  mentioned: { rank: 2, say: 'Entries about them once pointed at this card' },
  'same-name': { rank: 1, say: 'Same name' },
};

const table = (kind) => {
  const t = KINDS[kind];
  if (!t) throw new SemanticError('A card or a persona.');
  return t;
};

function resource(db, kind, resourceId) {
  const row = db.raw.prepare(`SELECT id, name, entity_id${kind === 'persona' ? ', from_entry' : ''}
    FROM ${table(kind)} WHERE id=?`).get(resourceId);
  if (!row) throw new SemanticError(kind === 'character' ? 'That character is no longer in your library.' : 'That persona is no longer saved.');
  return row;
}

/**
 * Who this card or persona represents, as it stands.
 *
 * Read-only.
 */
export function bindingFor(db, { kind, resourceId }) {
  const row = resource(db, kind, resourceId);
  const who = row.entity_id ? currentEntity(db, row.entity_id) : null;
  return {
    kind,
    resourceId: row.id,
    name: row.name,
    bound: !!who,
    entityId: who?.id || null,
    entity: who ? { id: who.id, name: who.canonical_name, aliases: aliasesOf(who) } : null,
  };
}

// Read as a row or as a parsed entity: both shapes reach here.
const aliasesOf = (e) => {
  if (Array.isArray(e?.aliases)) return e.aliases;
  try { const v = JSON.parse(e?.aliases || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
};
const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * Everyone this card could be, and why Nexus thinks so.
 *
 * Read-only, and a suggestion only: the order says which evidence is stronger,
 * never which answer is right. A name match is listed as a name match and
 * nothing more, so two people who happen to share one stay two people.
 */
export function bindingCandidates(db, { kind, resourceId }) {
  const row = resource(db, kind, resourceId);
  const found = new Map();
  const note = (entityId, why) => {
    if (!entityId) return;
    const who = currentEntity(db, entityId);
    if (!who || who.type !== 'person') return;
    const at = found.get(who.id) || { entityId: who.id, name: who.canonical_name, aliases: aliasesOf(who), why: [] };
    if (!at.why.includes(why)) at.why.push(why);
    found.set(who.id, at);
  };

  // What this card's own material says. A source written from this card whose
  // approved subject is a person is the closest thing to provenance there is.
  if (kind === 'character') {
    for (const r of db.raw.prepare(`SELECT ss.subject_entity_id AS id
        FROM lorebooks l JOIN source_semantics ss ON ss.lorebook_id = l.id
       WHERE l.from_character = ? AND ss.status = 'approved' AND ss.subject_entity_id IS NOT NULL`).all(row.id)) note(r.id, 'own-source');
    for (const r of db.raw.prepare(`SELECT se.entity_id AS id
        FROM lorebooks l JOIN source_entities se ON se.lorebook_id = l.id
       WHERE l.from_character = ? AND se.status = 'approved'`).all(row.id)) note(r.id, 'own-source');
    // A part this card has already played, which was an explicit choice.
    for (const r of db.raw.prepare('SELECT entity_id AS id FROM story_entity_cards WHERE character_id=?').all(row.id)) note(r.id, 'story-card');
    // Evidence from before P1, never authority: the entry it pointed at has to
    // have been organised since for it to name anybody.
    for (const r of db.raw.prepare(`SELECT COALESCE(rel.entity_id, s.defines_entity_id) AS id
        FROM legacy_entry_links k
        JOIN entry_semantics s ON s.entry_id = k.entry_id AND s.status = 'approved'
        LEFT JOIN entry_relations rel ON rel.entry_id = k.entry_id AND rel.relation = 'subject' AND rel.status = 'approved'
       WHERE k.target_kind = 'character' AND k.target_id = ?`).all(row.id)) note(r.id, 'mentioned');
  }

  // A persona that follows a lore entry is already about somebody.
  if (kind === 'persona' && row.from_entry) {
    const r = db.raw.prepare(`SELECT COALESCE(rel.entity_id, s.defines_entity_id) AS id
        FROM entry_semantics s
        LEFT JOIN entry_relations rel ON rel.entry_id = s.entry_id AND rel.relation = 'subject' AND rel.status = 'approved'
       WHERE s.entry_id = ? AND s.status = 'approved'`).get(row.from_entry);
    note(r?.id, 'from-entry');
  }

  // People with this name. Listed last, said plainly, and never enough on its
  // own — this is the one piece of evidence that must not decide anything.
  const name = norm(row.name);
  if (name) {
    for (const e of db.raw.prepare("SELECT id, aliases, canonical_name FROM lore_entities WHERE type='person' AND merged_into_id IS NULL").all()) {
      if (norm(e.canonical_name) === name || aliasesOf(e).some((a) => norm(a) === name)) note(e.id, 'same-name');
    }
  }

  const sameName = [...found.values()].filter((c) => c.why.includes('same-name')).map((c) => c.entityId);
  const candidates = [...found.values()].map((c) => {
    const best = c.why.reduce((r, w) => Math.max(r, EVIDENCE[w]?.rank || 0), 0);
    return {
      ...c,
      why: c.why.sort((a, b) => (EVIDENCE[b]?.rank || 0) - (EVIDENCE[a]?.rank || 0)).map((w) => EVIDENCE[w].say),
      reasons: c.why,
      strength: best,
      // Worth putting first, still not worth deciding by itself.
      prominent: best >= 3,
      nameOnly: best === 1,
      ...countsFor(db, c.entityId),
      alreadyRepresented: representedBy(db, c.entityId, { kind, resourceId: row.id }),
    };
  }).sort((a, b) => b.strength - a.strength || b.entries - a.entries || a.name.localeCompare(b.name));

  return {
    kind,
    resourceId: row.id,
    name: row.name,
    bound: !!row.entity_id,
    entityId: row.entity_id || null,
    candidates,
    // Choosing "someone new" while these exist is the AU case, and is recorded
    // as a decision so neither of them drifts into the other later.
    sameName,
    // Two candidates already kept apart stay apart: nothing here offers to
    // merge them, and the list says so rather than looking like a mistake.
    keptApart: candidates.length > 1
      ? candidates.flatMap((a, i) => candidates.slice(i + 1)
        .filter((b) => areDistinct(db, a.entityId, b.entityId))
        .map((b) => [a.entityId, b.entityId]))
      : [],
  };
}

/** How much is actually known about them, so a chooser can tell them apart. */
function countsFor(db, entityId) {
  const n = (sql) => db.raw.prepare(sql).get(entityId).n;
  return {
    entries: n(`SELECT COUNT(DISTINCT e.entry_id) n FROM (
        SELECT entry_id FROM entry_semantics WHERE defines_entity_id = ?1 AND status='approved'
        UNION SELECT entry_id FROM entry_relations WHERE entity_id = ?1 AND relation='subject' AND status='approved') e`),
    sources: n(`SELECT COUNT(*) n FROM source_entities WHERE entity_id=?`),
    stories: n(`SELECT COUNT(DISTINCT story_id) n FROM story_entity_cards WHERE entity_id=?`),
  };
}

/** Whether some other card or persona already represents them. */
function representedBy(db, entityId, self) {
  const out = [];
  for (const kind of ['character', 'persona']) {
    for (const r of db.raw.prepare(`SELECT id, name FROM ${KINDS[kind]} WHERE entity_id=?`).all(entityId)) {
      if (kind === self.kind && r.id === self.resourceId) continue;
      out.push({ kind, id: r.id, name: r.name });
    }
  }
  return out;
}

/**
 * Say that this card is that person.
 *
 * One column. The card keeps every word it had, the person keeps every entry
 * they had, no two people become one, and no story gains or loses anything.
 * What changes is that Nexus can now show them in full — and offer what they
 * know to a story, when a person asks for it.
 */
export function connectResource(db, { kind, resourceId, entityId }) {
  const row = resource(db, kind, resourceId);
  const who = currentEntity(db, entityId);
  if (!who) throw new SemanticError('That person is not in your library.');
  if (row.entity_id === who.id) return { ...bindingFor(db, { kind, resourceId }), changed: false };
  if (row.entity_id) throw new SemanticError(`This ${WORD[kind]} already represents someone else. Disconnect it first — that is a separate decision.`);
  if (kind === 'character') bindCharacterEntity(db, row.id, who.id);
  else bindPersonaEntity(db, row.id, who.id);
  return { ...bindingFor(db, { kind, resourceId }), changed: true, reuse: reuseState(db, who.id) };
}

/**
 * Say that this card is somebody new.
 *
 * For the story where Patrick Moretti is a different Patrick Moretti. A person
 * is made from what the card already says its name is, and is recorded as not
 * being any of the people who share that name, so nothing later quietly treats
 * them as the same man.
 */
export function newPersonFor(db, { kind, resourceId }) {
  const row = resource(db, kind, resourceId);
  if (row.entity_id) throw new SemanticError(`This ${WORD[kind]} already represents someone.`);
  const name = String(row.name || '').trim();
  if (!name) throw new SemanticError('Give them a name first.');
  const { sameName } = bindingCandidates(db, { kind, resourceId });
  return db.transaction(() => {
    const entityId = createEntity(db, { type: 'person', name, aliases: [] });
    for (const other of sameName) distinguish(db, entityId, other);
    if (kind === 'character') bindCharacterEntity(db, row.id, entityId);
    else bindPersonaEntity(db, row.id, entityId);
    return { ...bindingFor(db, { kind, resourceId }), changed: true, created: true, keptApartFrom: sameName.length };
  });
}

/**
 * What would stop being shown if this card stopped representing them.
 *
 * Read-only. Nothing here is deleted by disconnecting — the person, their
 * knowledge, the stories carrying it and the card's own fields all stay. What
 * goes is Nexus's ability to put them together, so this says where that is
 * being relied on before anyone finds out the hard way.
 */
export function disconnectPreview(db, { kind, resourceId }) {
  const row = resource(db, kind, resourceId);
  if (!row.entity_id) throw new SemanticError(`This ${WORD[kind]} does not represent anyone yet.`);
  const who = currentEntity(db, row.entity_id);
  const id = who.id;

  const stories = db.raw.prepare(`SELECT s.id, s.title FROM stories s
     JOIN story_lorebooks sl ON sl.story_id = s.id
     JOIN source_semantics ss ON ss.lorebook_id = sl.lorebook_id
    WHERE ss.status='approved' AND ss.package_role='entity-material'
      AND ss.subject_entity_id = ? AND ss.owner_story_id IS NULL
    GROUP BY s.id ORDER BY s.title`).all(id);
  const own = db.raw.prepare(`SELECT s.id, s.title FROM stories s
     JOIN source_semantics ss ON ss.owner_story_id = s.id
     JOIN lore_entries e ON e.lorebook_id = ss.lorebook_id
     JOIN entry_relations r ON r.entry_id = e.id AND r.relation='subject' AND r.status='approved'
    WHERE r.entity_id = ? GROUP BY s.id ORDER BY s.title`).all(id);
  const cast = kind === 'character'
    ? db.raw.prepare('SELECT COUNT(*) n FROM story_entity_cards WHERE entity_id=? AND character_id=?').get(id, row.id).n
    : 0;
  const reuse = reuseState(db, id);

  const depends = {
    // Stories reading their reusable knowledge, through this person.
    reading: stories.map((s) => ({ id: s.id, title: s.title })),
    // Stories that wrote their own facts about them.
    writing: own.map((s) => ({ id: s.id, title: s.title })),
    // Parts this card has been cast in as them.
    parts: cast,
    knowledge: reuse.entries,
    sets: reuse.total,
  };
  return {
    kind,
    resourceId: row.id,
    name: row.name,
    entityId: id,
    person: who.canonical_name,
    depends,
    // Nothing is lost either way; this only says how much is being leaned on.
    heavy: depends.reading.length + depends.writing.length + depends.parts > 0,
    token: tokenFor(row.id, id, depends),
  };
}

const tokenFor = (resourceId, entityId, depends) => createHash('sha256')
  .update(JSON.stringify([resourceId, entityId, depends])).digest('hex').slice(0, 16);

/**
 * Stop this card representing them.
 *
 * Deletes nothing: one column goes back to empty. The token is the preview a
 * person actually saw, so a dependency that appeared in between refuses the
 * change instead of surprising them.
 */
export function disconnectResource(db, { kind, resourceId, token }) {
  const now = disconnectPreview(db, { kind, resourceId });
  if (token !== now.token) throw new SemanticError('Something about them changed while you were looking. Read it again.');
  db.raw.prepare(`UPDATE ${table(kind)} SET entity_id=NULL WHERE id=?`).run(resourceId);
  return { ...bindingFor(db, { kind, resourceId }), changed: true, was: now.person };
}

/**
 * Everyone unconnected, and whether Nexus has anything to suggest.
 *
 * Read-only. The answer to "what would this be able to offer me" without
 * touching a thing.
 */
export function unboundResources(db, { kind = null } = {}) {
  const out = [];
  for (const k of kind ? [kind] : ['character', 'persona']) {
    for (const r of db.raw.prepare(`SELECT id, name FROM ${KINDS[k]} WHERE entity_id IS NULL ORDER BY name`).all()) {
      const c = bindingCandidates(db, { kind: k, resourceId: r.id });
      out.push({
        kind: k, id: r.id, name: r.name,
        candidates: c.candidates.length,
        best: c.candidates[0] || null,
        nameOnly: !!c.candidates.length && c.candidates.every((x) => x.nameOnly),
        sameName: c.sameName.length,
      });
    }
  }
  return out;
}

/** Someone a story is about to include, and what they would bring with them. */
export function offerFor(db, entityId, { storyId = null } = {}) {
  const who = getEntity(db, entityId) ? currentEntity(db, entityId) : null;
  if (!who) return null;
  const r = reuseState(db, who.id, { storyId });
  return r.total ? r : null;
}
