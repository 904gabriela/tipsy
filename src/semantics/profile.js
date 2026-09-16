// What one entity is, gathered in one place.
//
// A person in Nexus is three things that must not be collapsed into each other:
// the RESOURCE (a character card, a persona) that a story uses, the ENTITY (the
// semantic identity), and the KNOWLEDGE (entries that say things about it).
// This module answers the third question for one entity, and hands back the
// first two alongside it so a page can be drawn without going near SQL.
//
// Read-only. Nothing here writes, and nothing here decides what reaches a
// prompt: presentation asks what material means, retrieval does not.
//
// Ownership, once, for everyone:
//
//   an entry is X's own material when it DEFINES X, or when an approved
//   subject relation points at X.
//
// A defining entry needs no second relation to belong to the thing it defines —
// that is what defining means. An entry that merely mentions X, or travels in a
// source that is mostly about X, is not X's own material; it may be related,
// which is a different shelf.

import { entryHash } from './authority.js';

const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

/** Follow a merge, so an old id still finds the entity it became. */
export function canonicalEntityId(db, entityId) {
  let id = entityId;
  for (let hop = 0; hop < 8; hop++) {
    const row = db.raw.prepare('SELECT id, merged_into_id FROM lore_entities WHERE id=?').get(id);
    if (!row) return null;
    if (!row.merged_into_id) return row.id;
    id = row.merged_into_id;
  }
  return id;
}

/**
 * Every entry that belongs to one entity, as rows ready to be grouped.
 *
 * The two ways of belonging are one query, so neither can be forgotten, and an
 * entry that does both is one row rather than two.
 */
function ownRows(db, entityId) {
  return db.raw.prepare(`
    SELECT e.id, e.lorebook_id, e.title, e.content, e.keys, e.enabled, e.constant, e.kind, e.ord,
           b.name AS source_name,
           s.scope, s.category, s.display_path, s.defines_entity_id, s.status, s.confidence, s.origin,
           s.content_hash, s.activation_policy, s.reviewed_at,
           r.relation, r.status AS relation_status
      FROM lore_entries e
      JOIN entry_semantics s ON s.entry_id = e.id
      JOIN lorebooks b ON b.id = e.lorebook_id
      LEFT JOIN entry_relations r ON r.entry_id = e.id AND r.entity_id = ? AND r.relation = 'subject'
     WHERE s.status = 'approved'
       AND (s.defines_entity_id = ? OR (r.entity_id = ? AND r.status = 'approved'))
     ORDER BY e.ord, e.rowid`).all(entityId, entityId, entityId);
}

/** The other entities an entry names, with their names, for display and navigation. */
function relationsOf(db, entryIds) {
  if (!entryIds.length) return new Map();
  const marks = entryIds.map(() => '?').join(',');
  const rows = db.raw.prepare(`
    SELECT r.entry_id, r.entity_id, r.relation, r.status, x.canonical_name, x.type
      FROM entry_relations r JOIN lore_entities x ON x.id = r.entity_id
     WHERE r.entry_id IN (${marks}) AND r.status = 'approved'`).all(...entryIds);
  const byEntry = new Map();
  for (const r of rows) byEntry.set(r.entry_id, [...(byEntry.get(r.entry_id) || []), r]);
  return byEntry;
}

/** An entry as a page shows it: what it says, where it sits, and how it behaves. */
function asKnowledge(row, related, entityId) {
  const keys = parse(row.keys, []);
  const text = String(row.content || '').replace(/\s+/g, ' ').trim();
  return {
    entryId: row.id,
    title: row.title || 'Untitled',
    // Enough to recognise it without opening it. The whole text is one tap away.
    excerpt: text.length > 220 ? `${text.slice(0, 220)}…` : text,
    text,
    category: row.category,
    displayPath: parse(row.display_path, null),
    scope: row.scope,
    defines: row.defines_entity_id === entityId,
    subject: row.relation === 'subject',
    // A source's own text can change after a reading was approved. When it has,
    // the reading still stands — it is simply worth looking at again.
    needsRecheck: !!row.content_hash && row.content_hash !== entryHash({ title: row.title, content: row.content, keys }),
    confidence: row.confidence,
    origin: row.origin,
    related: (related || []).filter((r) => r.relation === 'related').map((r) => ({ id: r.entity_id, name: r.canonical_name, type: r.type })),
    // Shown quietly: being on someone's page is not being in the prompt.
    activation: {
      enabled: !!row.enabled,
      constant: !!row.constant,
      keys: keys.slice(0, 12),
      policy: row.activation_policy || null,
    },
    provenance: { sourceId: row.lorebook_id, sourceName: row.source_name, storedKind: row.kind },
  };
}

/**
 * Knowledge in the shape a profile reads: display groups, then categories.
 *
 * A displayPath is the universe's own words — "Quirk", "Fluid Domain" — and is
 * presentation only. Where an entry has none, its category is the group, so
 * every entry lands somewhere without inventing a new vocabulary.
 */
function group(items) {
  const groups = new Map();
  for (const item of items) {
    const path = (item.displayPath && item.displayPath.length) ? item.displayPath : [CATEGORY_GROUP[item.category] || 'Other'];
    const head = path[0];
    if (!groups.has(head)) groups.set(head, { name: head, items: [], sub: new Map() });
    const g = groups.get(head);
    if (path.length > 1) {
      const sub = path.slice(1).join(' · ');
      if (!g.sub.has(sub)) g.sub.set(sub, { name: sub, items: [] });
      g.sub.get(sub).items.push(item);
    } else g.items.push(item);
  }
  return [...groups.values()].map((g) => ({
    name: g.name,
    items: g.items,
    sub: [...g.sub.values()],
    count: g.items.length + [...g.sub.values()].reduce((n, s) => n + s.items.length, 0),
  }));
}

/** The heading a category falls under when an entry names no group of its own. */
export const CATEGORY_GROUP = {
  identity: 'Identity', appearance: 'Appearance', personality: 'Personality', speech: 'Speech',
  behavior: 'Behaviour', backstory: 'Backstory', psychology: 'Psychology', relationship: 'Relationships',
  secret: 'Secrets', goal: 'Goals', skill: 'Skills', ability: 'Abilities', equipment: 'Equipment',
  belief: 'Beliefs', habit: 'Habits', profile: 'Profile', background: 'Background', rule: 'Rules',
  event: 'Events', item: 'Things', direction: 'Directives', reference: 'Reference', other: 'Other',
};

/** The core slots a card or persona fills in, whatever else it carries. */
const CORE = ['identity', 'appearance', 'personality', 'behavior', 'speechStyle'];
const coreOf = (row) => (row ? {
  identity: row.description || '',
  appearance: row.appearance || '',
  personality: row.personality || '',
  behavior: row.behavior || '',
  speechStyle: row.speech_style || '',
} : null);
const hasCore = (core) => !!core && CORE.some((k) => String(core[k] || '').trim());

/**
 * One entity, everything about it, and nothing about anyone else.
 *
 * @param {object} db
 * @param {string} entityId
 * @param {object} [opts]
 * @param {string} [opts.storyId]  read it as this story sees it
 * @returns {object|null}
 */
export function entityProfile(db, entityId, { storyId = null } = {}) {
  const id = canonicalEntityId(db, entityId);
  if (!id) return null;
  const entity = db.raw.prepare('SELECT id, type, canonical_name, aliases FROM lore_entities WHERE id=?').get(id);
  if (!entity) return null;

  const story = storyId ? db.raw.prepare('SELECT id, title FROM stories WHERE id=?').get(storyId) : null;
  // Which sources this story actually carries. Sharing a person with another
  // story does not hand that story everything ever written about them.
  const attached = story
    ? new Set(db.raw.prepare('SELECT lorebook_id FROM story_lorebooks WHERE story_id=?').all(story.id).map((r) => r.lorebook_id))
    : null;
  const owners = new Map(db.raw.prepare('SELECT lorebook_id, owner_story_id, subject_entity_id, package_role, status FROM source_semantics')
    .all().map((r) => [r.lorebook_id, r]));

  const rows = ownRows(db, id);
  const related = relationsOf(db, rows.map((r) => r.id));
  const all = rows.map((r) => asKnowledge(r, related.get(r.id), id));

  // Reusable material belongs to the person and travels with them; story
  // material belongs to one story and stays there.
  const ownerOf = (item) => owners.get(item.provenance.sourceId) || null;
  const storyOwned = (item) => {
    const o = ownerOf(item);
    return o && o.status === 'approved' && o.owner_story_id ? o.owner_story_id : null;
  };
  const visible = (item) => {
    const owned = storyOwned(item);
    if (!story) return !owned;                       // the library view: reusable only
    if (owned) return owned === story.id;            // this story's own material
    return attached.has(item.provenance.sourceId);   // reusable, but only if carried
  };

  const kept = all.filter(visible);
  const reusable = kept.filter((x) => !storyOwned(x));
  const inStory = story ? kept.filter((x) => storyOwned(x) === story.id) : [];

  // Anyone this material connects to, and anyone whose own entry points back at
  // this one. A profile that defines Salvatore and mentions Patrick belongs to
  // Salvatore — but it is worth seeing from Patrick's page as a related person.
  const relatedEntities = new Map();
  const note = (row, why, item) => {
    if (row.id === id) return;
    const at = relatedEntities.get(row.id) || { id: row.id, name: row.name, type: row.type, why, entries: [] };
    at.entries.push({ entryId: item.entryId, title: item.title, category: item.category, why });
    relatedEntities.set(row.id, at);
  };
  for (const item of kept) for (const r of item.related) note(r, 'named here', item);
  const pointingHere = db.raw.prepare(`
    SELECT e.id, e.title, s.category, s.defines_entity_id, x.id AS other_id, x.canonical_name AS name, x.type
      FROM entry_relations r
      JOIN entry_semantics s ON s.entry_id = r.entry_id AND s.status = 'approved'
      JOIN lore_entries e ON e.id = r.entry_id
      JOIN lore_entities x ON x.id = s.defines_entity_id
     WHERE r.entity_id = ? AND r.relation = 'related' AND r.status = 'approved'
       AND s.defines_entity_id IS NOT NULL AND s.defines_entity_id <> ?`).all(id, id);
  for (const p of pointingHere) {
    const item = all.find((x) => x.entryId === p.id);
    const source = db.raw.prepare('SELECT lorebook_id FROM lore_entries WHERE id=?').get(p.id);
    if (story ? !(attached.has(source.lorebook_id) || owners.get(source.lorebook_id)?.owner_story_id === story.id) : !!owners.get(source.lorebook_id)?.owner_story_id) continue;
    note({ id: p.other_id, name: p.name, type: p.type }, 'their own entry mentions this one',
      item || { entryId: p.id, title: p.title, category: p.category });
  }

  const character = db.raw.prepare('SELECT * FROM characters WHERE entity_id=? ORDER BY created_at LIMIT 1').get(id) || null;
  const persona = db.raw.prepare('SELECT * FROM personas WHERE entity_id=? ORDER BY created_at LIMIT 1').get(id) || null;

  // What is still unfinished about this person's material, said quietly.
  const sources = [...new Set(kept.map((x) => x.provenance.sourceId))];
  const unorganised = sources.map((sid) => {
    const total = db.raw.prepare('SELECT COUNT(*) n FROM lore_entries WHERE lorebook_id=?').get(sid).n;
    const done = db.raw.prepare("SELECT COUNT(*) n FROM entry_semantics s JOIN lore_entries e ON e.id=s.entry_id WHERE e.lorebook_id=? AND s.status='approved'").get(sid).n;
    return { sourceId: sid, name: kept.find((x) => x.provenance.sourceId === sid).provenance.sourceName, entries: total, organised: done };
  }).filter((s) => s.organised < s.entries);

  return {
    entity: {
      id: entity.id,
      name: entity.canonical_name,
      type: entity.type,
      aliases: parse(entity.aliases, []),
    },
    story: story ? { id: story.id, title: story.title } : null,
    resources: {
      character: character ? { id: character.id, name: character.name, avatar: character.avatar || null } : null,
      persona: persona ? { id: persona.id, name: persona.name, avatar: persona.avatar || null } : null,
    },
    // A card's fields are the person as they are always played; knowledge is
    // everything else that is true about them.
    core: (() => {
      const c = coreOf(character);
      const p = coreOf(persona);
      if (hasCore(c)) return { from: 'character', ...c };
      if (hasCore(p)) return { from: 'persona', ...p };
      return c || p ? { from: character ? 'character' : 'persona', ...(c || p) } : null;
    })(),
    knowledge: { reusable: group(reusable), story: group(inStory) },
    counts: { reusable: reusable.length, story: inStory.length, total: kept.length, hidden: all.length - kept.length },
    related: [...relatedEntities.values()].sort((a, b) => b.entries.length - a.entries.length),
    attention: {
      recheck: kept.filter((x) => x.needsRecheck).length,
      disabled: kept.filter((x) => !x.activation.enabled).length,
      unorganisedSources: unorganised,
    },
  };
}
