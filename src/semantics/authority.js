// Which reading of an entry wins, and for what.
//
// An entry can be understood three ways: by semantics a person approved, by
// semantics something proposed, or by the type the importer guessed when it
// arrived (`lore_entries.kind`). For organising a story — who is cast, which
// section an entry sits in, what the Directions tool offers — they rank:
//
//   1. approved semantics
//   2. approved semantics whose entry has changed since (NEEDS RECHECK): still
//      used, and marked stale
//   3. proposed semantics: suggestions only, never used to organise
//   4. the legacy guess from `kind`, only where nothing is approved
//   5. old links: evidence, never used here at all
//
// None of this reaches activation. The engine reads each entry's own
// activation fields and never these.
//
// Pure: callers load rows and pass them in.

import { createHash } from 'node:crypto';

export const PERSON_CATEGORIES = ['identity', 'appearance', 'personality', 'speech', 'behavior', 'backstory', 'psychology', 'relationship', 'secret', 'goal', 'skill', 'ability', 'equipment', 'belief', 'habit', 'other'];
// direction: how to narrate. reference: specialised knowledge to draw on when relevant.
export const WORLD_CATEGORIES = ['background', 'rule', 'event', 'item', 'direction', 'reference', 'other'];
export const ENTITY_TYPES = ['person', 'place', 'faction', 'item', 'event', 'concept'];
export const PACKAGE_ROLES = ['entity-material', 'world', 'scenario', 'story-package', 'narrative-framework', 'reference-pack', 'mixed'];

/**
 * A source's role, as far as it can be relied on.
 *
 * Only an approved role counts. A proposed role is a suggestion; no row means
 * nobody has said, and the source is read as it always has been.
 *
 * @returns {{ role: string|null, state: 'approved'|'proposed'|'none', proposed: string|null }}
 */
export function packageRoleView(row) {
  if (!row) return { role: null, state: 'none', proposed: null, domains: [], subjectEntityId: null, ownerStoryId: null };
  let domains = [];
  try { domains = JSON.parse(row.domains || '[]'); } catch { /* tags only */ }
  // Ownership counts only once approved, like the role itself.
  const approved = row.status === 'approved';
  const owners = { subjectEntityId: approved ? row.subject_entity_id || null : null, ownerStoryId: approved ? row.owner_story_id || null : null };
  if (approved) return { role: row.package_role, state: 'approved', proposed: null, domains, ...owners };
  return { role: null, state: 'proposed', proposed: row.package_role, domains, ...owners };
}

/**
 * Whether a source's entries should be read as story-world content — people,
 * places, factions, background.
 *
 * An approved narrative framework is not: it says how to tell any story. Nor
 * is an approved reference pack: it is knowledge to draw on, not a setting.
 * Extracting a cast or locations from either would be reading it as something
 * it is not. Everything else — a mixed package, and sources nobody has
 * classified yet — is read as world content, exactly as today, entry by entry.
 */
export const readsAsWorldContent = (roleView) => !['narrative-framework', 'reference-pack'].includes(roleView?.role);

/** What an entry was when its semantics were approved: title, content and keys. */
export function entryHash(entry) {
  const keys = Array.isArray(entry.keys) ? entry.keys : [];
  return createHash('sha256').update(JSON.stringify([String(entry.title || ''), String(entry.content || ''), keys.map(String)])).digest('hex');
}

/**
 * One entry's semantic reading.
 *
 * @param {object} entry        the entry as stored (title, content, keys, kind)
 * @param {object|null} row     its entry_semantics row, if any
 * @param {object[]} relations  its entry_relations rows, each with `entity` attached
 * @param {object|null} defines the entity it defines, if any
 * @returns {{ state, authoritative, stale, scope, category, defines, subject, related, proposedSubjects }}
 */
export function semanticView(entry, row, relations = [], defines = null) {
  if (!row) {
    return { state: 'none', authoritative: false, stale: false, scope: null, category: null, displayPath: null, defines: null, subject: null, related: [], proposedSubjects: relations.filter((r) => r.relation === 'subject').map((r) => r.entity) };
  }
  const approved = row.status === 'approved';
  const stale = approved && !!row.content_hash && row.content_hash !== entryHash(entry);
  const state = !approved ? 'proposed' : stale ? 'recheck' : 'approved';
  const ok = (r) => r.status === 'approved';
  let displayPath = null;
  try { displayPath = row.display_path ? JSON.parse(row.display_path) : null; } catch { /* presentation only */ }
  return {
    state,
    authoritative: approved,
    stale,
    scope: row.scope,
    category: row.category,
    // For showing the entry under its entity. Nothing that decides anything reads it.
    displayPath,
    defines: approved ? defines : null,
    subject: approved ? (relations.find((r) => r.relation === 'subject' && ok(r))?.entity || null) : null,
    related: approved ? relations.filter((r) => r.relation === 'related' && ok(r)).map((r) => r.entity) : [],
    proposedSubjects: relations.filter((r) => r.relation === 'subject' && !ok(r)).map((r) => r.entity),
  };
}

/**
 * Is this entry a person who could be cast, and who?
 *
 * Approved semantics decide outright, whatever `kind` says: an entry approved
 * as defining the person Carlo Vancetti is Carlo even though it was imported
 * as a note, and an entry approved as the Vancetti Family faction is not a
 * person even though it was imported as a character. Without approved
 * semantics, the legacy reading (passed in, from `kind` and the title) stands.
 *
 * @param {object} entry
 * @param {object|undefined} view   semanticView, if the entry has semantics
 * @param {function} legacy          entry → { person, name?, reason? }
 */
export function personVerdict(entry, view, legacy) {
  if (view?.authoritative) {
    if (view.defines && view.defines.type === 'person') {
      return { person: true, name: view.defines.canonical_name, entityId: view.defines.id, stale: view.stale, authority: 'semantics' };
    }
    const what = view.defines ? `a ${view.defines.type}` : `${view.scope} ${view.category}`;
    return { person: false, reason: `organised as ${what}`, stale: view.stale, authority: 'semantics' };
  }
  return { ...legacy(entry), authority: 'legacy' };
}

/** The story section an entry belongs in, from approved semantics. Null when there are none. */
export function semanticSection(view) {
  if (!view?.authoritative) return null;
  if (view.defines) {
    return { person: 'casting', place: 'places', faction: 'factions', item: 'items', event: 'events', concept: 'backstory' }[view.defines.type] || 'other';
  }
  switch (view.category) {
    case 'direction': return 'directions';
    case 'rule': return 'rules';
    case 'event': return 'events';
    case 'item': return 'items';
    case 'background': return 'backstory';
    // Reference knowledge has no section of its own until Frameworks & Reference
    // exists; it is not background, so it waits in Other.
    case 'reference': return 'other';
    case 'other': return 'other';
    default:
      // Lore about a person — identity, backstory, psychology, … — sits with
      // the background until character pages exist to hold it.
      return PERSON_CATEGORIES.includes(view.category) ? 'backstory' : 'other';
  }
}

/** The legacy section for an entry's stored kind, exactly as composition has always placed it. */
export const LEGACY_SECTION = {
  place: 'places', faction: 'factions', premise: 'backstory', rule: 'rules',
  direction: 'directions', event: 'events', item: 'items', note: 'other',
};

/**
 * Should the Directions tool offer this entry as "really an instruction"?
 *
 * Approved semantics decide for organised entries: category direction, and
 * nothing else. Only entries with no approved semantics fall back to
 * kind='direction'. Proposed semantics do not count. This chooses what is
 * OFFERED; absorbing still needs the person to confirm.
 */
export function isDirection(entry, view) {
  if (view?.authoritative) return view.category === 'direction';
  return entry.kind === 'direction';
}

/**
 * How organised a source is.
 *
 *   unorganized  nothing approved
 *   partial      some entries approved, some not (or a declaration still proposed)
 *   organized    every entry — disabled ones included — approved as something,
 *                and every declaration approved
 *   needs_recheck (display) one or more approved entries changed since review;
 *                shown over the coverage state, which is still reported
 *
 * An approved entry counts only when it is complete: scope 'entity' needs an
 * approved subject or an entity it defines; 'world' and 'other' are complete
 * as they are.
 *
 * @param {object[]} entries  every entry in the source
 * @param {Map} views          entryId → semanticView
 * @param {object[]} declarations  the source's source_entities rows
 */
export function organizationState(entries, views, declarations = []) {
  let approved = 0;
  let recheck = 0;
  let incomplete = 0;
  for (const e of entries) {
    const v = views.get(e.id);
    if (!v?.authoritative) continue;
    if (v.scope === 'entity' && !v.defines && !v.subject) { incomplete++; continue; }
    approved++;
    if (v.stale) recheck++;
  }
  const proposedDeclarations = declarations.filter((d) => d.status !== 'approved').length;
  const total = entries.length;
  const coverage = approved === 0 ? 'unorganized'
    : approved === total && proposedDeclarations === 0 ? 'organized'
      : 'partial';
  return {
    coverage,
    display: recheck > 0 ? 'needs_recheck' : coverage,
    total, approved, recheck, incomplete,
    unresolved: total - approved,
    proposedDeclarations,
  };
}
