// What Composition is allowed to know, read once and read honestly.
//
// Before this layer, composing a story meant reading legacy kinds and guessing
// from titles. This is the other way in: for material somebody has organised,
// composition thinks in entities, approved meaning and source roles — and for
// everything else it says "fallback" out loud instead of pretending.
//
// The authority rule is P1's, unchanged, and it is per entry:
//
//   approved and current        → authoritative
//   approved but text changed   → still the last approved meaning, marked
//   proposed                    → a suggestion; never authority; fallback
//   nothing                     → fallback
//
// Nothing here writes, nothing here calls the conversion analyser, and nothing
// here reaches outside the sources it was handed: a story sees the entities of
// what it carries, not the library.

import { packageRoleView, semanticView } from './authority.js';

const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const marks = (n) => Array.from({ length: n }, () => '?').join(',');

/**
 * Everything semantic that composition needs about a set of sources.
 *
 * @param {object}   db
 * @param {string[]} sourceIds
 * @param {object}   [o]
 * @param {string}   [o.storyId]  scope exclusions and card bindings to a story
 * @returns {{ sources: Map, views: Map, inventory: object[], excludedEntities: Set }}
 */
export function readCompositionMaterial(db, sourceIds, { storyId = null } = {}) {
  const ids = [...new Set(sourceIds)].filter(Boolean);
  const sources = new Map();
  const views = new Map();
  if (!ids.length) return { sources, views, inventory: [], excludedEntities: new Set() };

  const roleRows = new Map(db.raw.prepare(
    `SELECT * FROM source_semantics WHERE lorebook_id IN (${marks(ids.length)})`).all(...ids)
    .map((r) => [r.lorebook_id, r]));

  const entryRows = db.raw.prepare(
    `SELECT id, lorebook_id, title, content, keys FROM lore_entries WHERE lorebook_id IN (${marks(ids.length)})`).all(...ids);
  const semRows = new Map(entryRows.length ? db.raw.prepare(
    `SELECT * FROM entry_semantics WHERE entry_id IN (${marks(entryRows.length)})`).all(...entryRows.map((e) => e.id))
    .map((r) => [r.entry_id, r]) : []);
  const relRows = entryRows.length ? db.raw.prepare(
    `SELECT * FROM entry_relations WHERE entry_id IN (${marks(entryRows.length)})`).all(...entryRows.map((e) => e.id)) : [];
  const relsByEntry = new Map();
  for (const r of relRows) relsByEntry.set(r.entry_id, [...(relsByEntry.get(r.entry_id) || []), r]);

  const entityIds = new Set([
    ...[...semRows.values()].map((r) => r.defines_entity_id).filter(Boolean),
    ...relRows.map((r) => r.entity_id),
  ]);
  const declaredRows = db.raw.prepare(
    `SELECT * FROM source_entities WHERE lorebook_id IN (${marks(ids.length)})`).all(...ids);
  for (const d of declaredRows) entityIds.add(d.entity_id);
  const entities = new Map(entityIds.size ? db.raw.prepare(
    `SELECT * FROM lore_entities WHERE id IN (${marks(entityIds.size)})`).all(...entityIds)
    .map((r) => [r.id, r]) : []);

  // The per-entry meaning, by the one authority rule everything else uses.
  for (const e of entryRows) {
    const view = semanticView(
      { title: e.title, content: e.content, keys: parse(e.keys, []) },
      semRows.get(e.id) || null,
      relsByEntry.get(e.id) || [],
      semRows.get(e.id)?.defines_entity_id ? entities.get(semRows.get(e.id).defines_entity_id) : null,
    );
    views.set(e.id, view);
  }

  for (const id of ids) {
    const book = db.raw.prepare('SELECT id, name FROM lorebooks WHERE id=?').get(id);
    if (!book) continue;
    const mine = entryRows.filter((e) => e.lorebook_id === id);
    const states = mine.map((e) => views.get(e.id)?.state || 'none');
    sources.set(id, {
      id,
      name: book.name,
      role: packageRoleView(roleRows.get(id) || null),
      declared: declaredRows.filter((d) => d.lorebook_id === id),
      total: mine.length,
      organised: states.filter((s) => s === 'approved' || s === 'recheck').length,
      recheck: states.filter((s) => s === 'recheck').length,
      fallback: states.filter((s) => s === 'none' || s === 'proposed').length,
    });
  }

  const excludedEntities = new Set(storyId ? db.raw.prepare(
    'SELECT entity_id FROM story_entity_exclusions WHERE story_id=?').all(storyId).map((r) => r.entity_id) : []);

  return {
    sources,
    views,
    inventory: entityInventory(db, ids, { storyId, preloaded: { declaredRows, semRows, relsByEntry, entryRows, entities } }),
    excludedEntities,
  };
}

/**
 * The people, places and things these sources bring, one line each.
 *
 * Compact by design: enough to decide identity — who someone is, what they are
 * called, what stands behind them — without carrying every body of text. An
 * entity is `confirmed` by an approved declaration or approved semantics;
 * anything reaching the list only through proposals is `unconfirmed`, and
 * nothing downstream may treat a guess as canon.
 */
export function entityInventory(db, sourceIds, { storyId = null, preloaded = null } = {}) {
  const ids = [...new Set(sourceIds)].filter(Boolean);
  if (!ids.length) return [];
  const declaredRows = preloaded?.declaredRows || db.raw.prepare(
    `SELECT * FROM source_entities WHERE lorebook_id IN (${marks(ids.length)})`).all(...ids);

  const entryRows = preloaded?.entryRows || db.raw.prepare(
    `SELECT id, lorebook_id, title, content, keys FROM lore_entries WHERE lorebook_id IN (${marks(ids.length)})`).all(...ids);
  const semRows = preloaded?.semRows || new Map(entryRows.length ? db.raw.prepare(
    `SELECT * FROM entry_semantics WHERE entry_id IN (${marks(entryRows.length)})`).all(...entryRows.map((e) => e.id))
    .map((r) => [r.entry_id, r]) : []);

  // Who is in play: everyone declared, and everyone approved entries define.
  const byId = new Map();
  const note = (entityId, sourceId, confirmed) => {
    if (!entityId) return;
    const at = byId.get(entityId) || { id: entityId, sources: new Set(), confirmed: false };
    at.sources.add(sourceId);
    at.confirmed = at.confirmed || confirmed;
    byId.set(entityId, at);
  };
  for (const d of declaredRows) note(d.entity_id, d.lorebook_id, d.status === 'approved');
  for (const e of entryRows) {
    const s = semRows.get(e.id);
    if (s?.status === 'approved' && s.defines_entity_id) note(s.defines_entity_id, e.lorebook_id, true);
  }
  if (!byId.size) return [];

  const rows = db.raw.prepare(
    `SELECT * FROM lore_entities WHERE id IN (${marks(byId.size)})`).all(...byId.keys());
  const cards = new Map();
  for (const c of db.raw.prepare(
    `SELECT id, name, entity_id FROM characters WHERE entity_id IN (${marks(byId.size)})`).all(...byId.keys())) {
    cards.set(c.entity_id, [...(cards.get(c.entity_id) || []), { id: c.id, name: c.name }]);
  }
  const personas = new Map(db.raw.prepare(
    `SELECT id, name, entity_id FROM personas WHERE entity_id IN (${marks(byId.size)})`).all(...byId.keys())
    .map((p) => [p.entity_id, { id: p.id, name: p.name }]));
  const storyCards = new Map(storyId ? db.raw.prepare(
    'SELECT entity_id, character_id FROM story_entity_cards WHERE story_id=?').all(storyId)
    .map((r) => [r.entity_id, r.character_id]) : []);
  const excluded = new Set(storyId ? db.raw.prepare(
    'SELECT entity_id FROM story_entity_exclusions WHERE story_id=?').all(storyId).map((r) => r.entity_id) : []);

  // What introduces them: the first defining entry's opening words are the
  // one-line summary an identity decision needs.
  const defining = new Map();
  for (const e of entryRows) {
    const s = semRows.get(e.id);
    if (s?.status !== 'approved' || !s.defines_entity_id) continue;
    const at = defining.get(s.defines_entity_id) || { summaries: [] };
    if (at.summaries.length < 2) at.summaries.push(String(e.content || '').replace(/\s+/g, ' ').trim().slice(0, 140));
    defining.set(s.defines_entity_id, at);
  }

  return rows.map((x) => {
    const seen = byId.get(x.id);
    return {
      id: x.id,
      name: x.canonical_name,
      type: x.type,
      aliases: parse(x.aliases, []),
      sources: [...seen.sources],
      status: seen.confirmed ? 'confirmed' : 'unconfirmed',
      summary: defining.get(x.id)?.summaries[0] || '',
      cards: cards.get(x.id) || [],
      storyCardId: storyCards.get(x.id) || null,
      personaId: personas.get(x.id)?.id || null,
      excluded: excluded.has(x.id),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Entries a story must hold back because their person is excluded from it.
 *
 * Only what an entity exclusion can honestly mean: entries whose APPROVED
 * meaning is that they define this entity or are about it. Merely mentioning
 * an excluded person suppresses nothing, and unorganised material is never
 * guessed away.
 */
export function entriesExcludedByEntity(db, storyId, entryIds) {
  const excluded = db.raw.prepare('SELECT entity_id FROM story_entity_exclusions WHERE story_id=?').all(storyId).map((r) => r.entity_id);
  if (!excluded.length || !entryIds.length) return new Set();
  const out = new Set();
  const exSet = new Set(excluded);
  for (const row of db.raw.prepare(
    `SELECT entry_id, defines_entity_id FROM entry_semantics
      WHERE status='approved' AND defines_entity_id IN (${marks(excluded.length)})
        AND entry_id IN (${marks(entryIds.length)})`).all(...excluded, ...entryIds)) {
    out.add(row.entry_id);
  }
  for (const row of db.raw.prepare(
    `SELECT r.entry_id FROM entry_relations r
      JOIN entry_semantics s ON s.entry_id = r.entry_id AND s.status='approved'
     WHERE r.relation='subject' AND r.status='approved'
       AND r.entity_id IN (${marks(excluded.length)})
       AND r.entry_id IN (${marks(entryIds.length)})`).all(...excluded, ...entryIds)) {
    out.add(row.entry_id);
  }
  return out;
}

/** Exclude a person from one story, or let them back in. Reversible, story-local. */
export function setEntityExclusion(db, { storyId, entityId, excluded }) {
  if (excluded) {
    db.raw.prepare('INSERT OR IGNORE INTO story_entity_exclusions (story_id, entity_id, created_at) VALUES (?,?,?)')
      .run(storyId, entityId, Date.now());
  } else {
    db.raw.prepare('DELETE FROM story_entity_exclusions WHERE story_id=? AND entity_id=?').run(storyId, entityId);
  }
}

/**
 * Give legacy cast rows their identity, where it is beyond doubt.
 *
 * A story_npcs row that points at an entry whose approved, current semantics
 * define exactly one person gets that person's id. Anything ambiguous is left
 * exactly as it was — NULL is honest, a guess is not.
 *
 * @returns {{ filled: number, left: number }}
 */
export function backfillNpcIdentities(db, storyId, { resolve }) {
  const rows = db.raw.prepare('SELECT story_id, entry_id FROM story_npcs WHERE story_id=? AND entity_id IS NULL').all(storyId);
  // One logical person per story, so a name already claimed is not claimed
  // twice. Two old rows can both point at entries defining the same person —
  // two entries about Salvatore, cast separately before there were identities.
  // Collapsing them is a merge, and a merge is not a back-fill: the first keeps
  // the identity, the rest stay NULL, exactly as honest as they were.
  const taken = new Set(db.raw.prepare('SELECT entity_id FROM story_npcs WHERE story_id=? AND entity_id IS NOT NULL')
    .all(storyId).map((r) => r.entity_id));
  let filled = 0;
  for (const r of rows) {
    const entityId = resolve(db, r.entry_id);
    if (entityId && !taken.has(entityId)) {
      db.raw.prepare('UPDATE story_npcs SET entity_id=? WHERE story_id=? AND entry_id=?').run(entityId, storyId, r.entry_id);
      taken.add(entityId);
      filled++;
    }
  }
  return { filled, left: rows.length - filled };
}
