// Deleting things from a library, in two steps, with the truth recomputed
// between them.
//
// The rule that makes this safe is simple: the browser never decides anything.
// It sends a list of things somebody ticked. The server works out what each one
// is holding up, says so in words, and hands back a token that is a fingerprint
// of that answer. Apply recomputes the whole answer and refuses unless it comes
// out identical. So a story that attached a source while the preview was open
// cannot be quietly stepped over.
//
// What is never done here:
//
//   nothing is forced      something a story is using is refused, and stays
//                          refused. Take it out of the story first.
//   nothing is merged      a duplicate is deleted or kept, never consolidated
//                          onto another copy; that would edit a story.
//   no entity is deleted   people, places and factions outlive the sources
//                          that mentioned them. The database enforces this too.
//   nothing is partial     one transaction, or nothing at all.
//
// Provenance is cleaned but never obeyed: the row that says a source arrived
// inside a card is cleared when the card goes, and the row that says an import
// produced a resource is cleared when the resource goes.

import { createHash } from 'node:crypto';
import { analyzeLibraryDependencies, dependencyKey, KINDS } from './dependencies.js';

export class LibraryDeleteError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const TABLE = { character: 'characters', source: 'lorebooks', scenario: 'scenarios', world: 'frameworks' };
const THE = { character: 'person', source: 'source', scenario: 'scenario', world: 'world' };

/** The selection as the server will treat it: known kinds, real ids, no repeats. */
function clean(selection) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(selection) ? selection : []) {
    const kind = String(raw?.kind || '');
    const id = String(raw?.id || '');
    if (!KINDS.includes(kind) || !id) continue;
    const k = dependencyKey(kind, id);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ kind, id });
  }
  return out;
}

/**
 * What deleting these would do.
 *
 * Read-only. Writes nothing, and is safe to call as often as a screen likes.
 *
 * @returns {{ safe, blocked, detaches, remains, token, counts }}
 */
export function previewLibraryDelete(db, selection) {
  const items = clean(selection);
  if (!items.length) throw new LibraryDeleteError('Nothing was selected.');
  const deps = analyzeLibraryDependencies(db, items);
  const chosen = new Set(items.map((i) => dependencyKey(i.kind, i.id)));

  const safe = [];
  const blocked = [];
  for (const { kind, id } of items) {
    const info = deps.get(dependencyKey(kind, id));
    if (!info) continue;                                // already gone; nothing to do
    // A reason that stands on something also being deleted is not a reason:
    // removing a world and the source inside it is one decision.
    const standing = info.reasons.filter((r) => !(r.from && chosen.has(dependencyKey(r.from.kind, r.from.id))));
    if (standing.length) blocked.push({ ...info, reasons: standing });
    else safe.push({ ...info, reasons: [] });
  }

  // What goes with the safe ones, and what pointedly does not.
  const detaches = [];
  const remains = [];
  for (const s of safe) {
    for (const d of s.detaches) detaches.push(d);
    if (s.kind === 'source') {
      const n = db.raw.prepare('SELECT COUNT(*) n FROM lore_entries WHERE lorebook_id=?').get(s.id).n;
      if (n) detaches.push(`${s.name}: its ${n} ${n === 1 ? 'entry goes' : 'entries go'} with it`);
      // Every person the source declared stays in the library. This is the
      // promise P9 makes loudest, because it is the one a cleanup usually breaks.
      const people = db.raw.prepare(`SELECT e.canonical_name FROM source_entities x
        JOIN lore_entities e ON e.id = x.entity_id WHERE x.lorebook_id=? ORDER BY e.canonical_name`).all(s.id);
      for (const p of people) remains.push(`${p.canonical_name} stays in your library`);
    }
    if (s.kind === 'character') {
      const bound = db.raw.prepare('SELECT canonical_name FROM lore_entities WHERE id=(SELECT entity_id FROM characters WHERE id=?)').get(s.id);
      if (bound) remains.push(`${bound.canonical_name} stays in your library`);
    }
  }

  const counts = { selected: items.length, safe: safe.length, blocked: blocked.length };
  return {
    safe: safe.map(present),
    blocked: blocked.map(present),
    detaches: [...new Set(detaches)],
    remains: [...new Set(remains)],
    counts,
    token: tokenFor(db, items, safe),
  };
}

/** One row, as a screen needs it and no more. */
const present = (r) => ({
  kind: r.kind, id: r.id, name: r.name,
  reasons: r.reasons.map((x) => x.text),
  protected: r.protected,
});

/**
 * A fingerprint of the answer, not of the question.
 *
 * It covers what was selected, what came back safe, and the state of everything
 * that decided that — so an attachment made, a card bound or a resource renamed
 * between preview and apply changes the token and the apply is refused.
 */
function tokenFor(db, items, safe) {
  const q = (sql, ...a) => db.raw.prepare(sql).all(...a);
  const state = items.map(({ kind, id }) => {
    const row = db.raw.prepare(`SELECT * FROM ${TABLE[kind]} WHERE id=?`).get(id);
    return [kind, id, row ? JSON.stringify(row) : null];
  });
  return createHash('sha256').update(JSON.stringify([
    items.map((i) => `${i.kind}:${i.id}`).sort(),
    safe.map((s) => `${s.kind}:${s.id}`).sort(),
    state,
    // Everything that could turn a safe row into a blocked one.
    q('SELECT story_id, lorebook_id FROM story_lorebooks ORDER BY story_id, lorebook_id'),
    q('SELECT story_id, character_id FROM story_characters ORDER BY story_id, character_id'),
    q('SELECT story_id, character_id, entity_id FROM story_entity_cards ORDER BY story_id, entity_id'),
    q('SELECT owner_kind, owner_id, lorebook_id FROM resource_lorebooks ORDER BY owner_id, lorebook_id'),
    q('SELECT id, framework_id, scenario_id FROM stories ORDER BY id'),
    q('SELECT id, framework_id FROM scenarios ORDER BY id'),
    q('SELECT lorebook_id, owner_story_id FROM source_semantics ORDER BY lorebook_id'),
    q('SELECT id FROM stories ORDER BY id'),
  ])).digest('hex');
}

/**
 * Delete what the preview said was safe, having checked that it still is.
 *
 * @param {object} db
 * @param {Array<{kind,id}>} selection  exactly what the preview was given
 * @param {string} token                 what the preview handed back
 * @param {object} [o]
 * @param {boolean} [o.safeOnly]  true: delete the safe ones and skip the rest,
 *                                which the screen has already listed by name.
 *                                false: refuse unless every selected thing is
 *                                safe.
 */
export function applyLibraryDelete(db, selection, token, { safeOnly = true } = {}) {
  const items = clean(selection);
  const now = previewLibraryDelete(db, items);
  if (now.token !== token) {
    throw new LibraryDeleteError('Your library changed while this was open. Look at the deletion again.', 409);
  }
  if (!safeOnly && now.blocked.length) {
    throw new LibraryDeleteError(`${now.blocked[0].name} is still in use, so nothing was deleted.`);
  }
  if (!now.safe.length) throw new LibraryDeleteError('Nothing here can be deleted yet.');

  return db.transaction(() => {
    const done = [];
    for (const item of now.safe) {
      // The mapping from an import to this resource is a mapping to a living
      // thing. It goes with the thing; the import itself is history and stays.
      db.raw.prepare('DELETE FROM import_resources WHERE kind=? AND resource_id=?')
        .run(importKind(item.kind), item.id);
      if (item.kind === 'character') {
        // Anything that arrived inside them is material of its own. The schema
        // clears the provenance; this is only belt and braces for a database
        // made before that was true.
        db.raw.prepare('UPDATE lorebooks SET from_character=NULL WHERE from_character=?').run(item.id);
        db.raw.prepare("DELETE FROM starting_points WHERE owner_kind='character' AND owner_id=?").run(item.id);
        db.deleteCharacter(item.id);
      } else if (item.kind === 'source') {
        // A persona built from one of these entries keeps its own words; what
        // it loses is only the pointer back to where they came from.
        db.raw.prepare(`UPDATE personas SET from_entry=NULL WHERE from_entry IN
          (SELECT id FROM lore_entries WHERE lorebook_id=?)`).run(item.id);
        db.deleteLorebook(item.id);
      } else if (item.kind === 'scenario') {
        db.raw.prepare('UPDATE stories SET scenario_id=NULL WHERE scenario_id=?').run(item.id);
        db.deleteScenario(item.id);
      } else if (item.kind === 'world') {
        db.raw.prepare('UPDATE stories SET framework_id=NULL WHERE framework_id=?').run(item.id);
        db.deleteFramework(item.id);
      }
      done.push({ kind: item.kind, id: item.id, name: item.name });
    }
    return { deleted: done, skipped: now.blocked.map((b) => ({ kind: b.kind, id: b.id, name: b.name, reasons: b.reasons })) };
  });
}

/** What `import_resources` calls each of these. */
const importKind = (kind) => ({ character: 'character', source: 'lorebook', scenario: 'scenario', world: 'framework' }[kind]);

export { THE as RESOURCE_WORD };
