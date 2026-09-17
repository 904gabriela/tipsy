// Who is in a story, finally keyed by who they are.
//
// `story_npcs` began as a list of entries: "this story casts the entry called
// Carlo, as Supporting". That was the only identity there was. Now a person is
// an entity, and an entry is one of the places Nexus learned about them. The
// final table says so:
//
//   story_id          whose cast this is            (deleting the story takes it)
//   entity_id         who this is                   (never NULL, never deleted under it)
//   role              main | supporting | background
//   ord               where they sit in the cast
//   profile_entry_id  the entry that introduced them, if one did — provenance,
//                     cleared if that entry goes, never the identity
//
// Getting there is a migration, and the migration is honest or it does not
// run. A legacy row resolves to a person only by approved semantics — the entry
// defines them, or names exactly one approved subject who is a person. Nothing
// else counts: not a name, not a keyword, not a card, not an old composer link,
// not a proposal. A row that cannot be resolved is reported, kept, and blocks
// the rebuild. Two rows that resolve to the same person merge only when they
// say the same thing about them; if one says Supporting and the other says
// Background, nobody here picks — that is reported too. And a row that
// resolves to the person you play is flagged, not cast.
//
// Readiness writes nothing and is the same answer every time. Apply refuses
// unless readiness is clean, does the rebuild in one transaction, and checks
// every foreign key before it commits. Already done is a no-op.
//
// Deterministic. No provider is asked anything.

import { currentEntity, resolveEntryPerson } from './store.js';

export class NpcMigrationError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}

/** Which shape the table has on this database. */
export function npcTableShape(db) {
  const cols = db.raw.prepare('PRAGMA table_info(story_npcs)').all();
  if (!cols.length) return 'missing';
  const names = new Set(cols.map((c) => c.name));
  if (names.has('profile_entry_id')) return 'canonical';
  if (names.has('entity_id')) return 'transitional';
  return 'legacy';
}

/**
 * Where every row stands, and whether the rebuild may run.
 *
 * Read-only. Call it as often as you like; the answer only changes when the
 * library does.
 */
export function npcMigrationReadiness(db) {
  const shape = npcTableShape(db);
  const out = { shape, rows: [], groups: [], ready: 0, needsDecision: 0, unresolved: [], conflicts: [], collisions: [], notPeople: [], personaUnverified: [], canApply: false };
  if (shape === 'canonical') { out.canApply = false; out.alreadyMigrated = true; return out; }
  if (shape === 'missing') return out;

  const hasEntity = shape === 'transitional';
  const rows = db.raw.prepare(`SELECT n.story_id, s.title AS story_title, s.persona_id, n.entry_id, n.role, n.ord,
      ${hasEntity ? 'n.entity_id' : 'NULL AS entity_id'}, e.title AS entry_title, e.lorebook_id
    FROM story_npcs n
    JOIN stories s ON s.id = n.story_id
    LEFT JOIN lore_entries e ON e.id = n.entry_id
    ORDER BY n.story_id, n.ord, n.entry_id`).all();
  const personaEntity = new Map();
  const personaOf = (storyId, personaId) => {
    if (!personaId) return null;
    if (!personaEntity.has(personaId)) {
      personaEntity.set(personaId, db.raw.prepare('SELECT entity_id, name FROM personas WHERE id=?').get(personaId) || null);
    }
    return personaEntity.get(personaId);
  };

  for (const r of rows) {
    const row = {
      storyId: r.story_id, story: r.story_title, entryId: r.entry_id, entry: r.entry_title || null,
      role: r.role, ord: r.ord, entityId: r.entity_id || null,
      status: 'unresolved', resolved: null, why: '',
    };
    if (r.entity_id) {
      const cur = currentEntity(db, r.entity_id);
      if (!cur) { row.why = 'its person no longer exists'; }
      else if (cur.type !== 'person') { row.status = 'not-a-person'; row.why = `it points at ${cur.canonical_name}, which is a ${cur.type}`; }
      else { row.status = 'backed'; row.resolved = { entityId: cur.id, name: cur.canonical_name, how: 'already', stale: false }; }
    } else if (!r.entry_title) {
      row.why = 'the entry it stood on is gone, and nothing says who it was';
    } else {
      const who = resolveEntryPerson(db, r.entry_id);
      if (who) { row.status = 'resolvable'; row.resolved = who; row.why = who.how === 'defines' ? `the entry defines ${who.name}` : `the entry is about ${who.name}`; if (who.stale) row.why += ' (approved, but the entry changed since — worth a look)'; }
      else {
        const sem = db.raw.prepare('SELECT status FROM entry_semantics WHERE entry_id=?').get(r.entry_id);
        row.why = !sem ? 'nobody has organised this entry, so nothing says who it is'
          : sem.status !== 'approved' ? 'this entry has only a proposed reading, and a proposal is not an identity'
            : 'this entry is organised, but not as one person';
      }
    }
    // The person you play is never cast. A row that resolves to them is a
    // question for a person, not something to normalise.
    //
    // And when the persona has not been joined to an identity at all, the
    // answer is not "no collision" — it is that nobody can tell. Matching by
    // name would be a guess, and the whole point of this table is that
    // identity is never guessed. So the story waits until somebody says who
    // they play: the invariant is unverifiable, not satisfied.
    const persona = personaOf(r.story_id, r.persona_id);
    if (row.resolved && persona?.entity_id && persona.entity_id === row.resolved.entityId) {
      row.status = 'persona';
      row.why = `this is ${persona.name}, who you play in this story`;
      out.collisions.push(row);
    } else if (row.resolved && persona && !persona.entity_id) {
      // Only a row that would otherwise have been fine is reclassified. A row
      // that already had nothing saying who it is keeps that reason, which is
      // the more useful one to read.
      row.status = 'persona-unverified';
      row.why = `the person you play in this story — ${persona.name} — has not been joined to an identity yet, `
        + 'so Nexus cannot prove that none of this cast is you';
      out.personaUnverified.push(row);
    }
    out.rows.push(row);
  }

  // Rows that resolve to one person in one story become one row, if they agree.
  const byKey = new Map();
  for (const row of out.rows) {
    if (!row.resolved || ['persona', 'persona-unverified', 'not-a-person'].includes(row.status)) continue;
    const k = `${row.storyId}:${row.resolved.entityId}`;
    byKey.set(k, [...(byKey.get(k) || []), row]);
  }
  for (const [, members] of byKey) {
    if (members.length < 2) continue;
    const roles = new Set(members.map((m) => m.role));
    const g = {
      storyId: members[0].storyId, story: members[0].story,
      entityId: members[0].resolved.entityId, name: members[0].resolved.name,
      rows: members, roles: [...roles], conflict: roles.size > 1,
    };
    out.groups.push(g);
    if (g.conflict) { out.conflicts.push(g); for (const m of members) m.status = 'conflict'; }
  }

  // Which stories cannot be proved safe, whatever their individual rows say.
  out.personaUnverifiedStories = [...new Map(out.personaUnverified.map((r) => [r.storyId, { storyId: r.storyId, story: r.story }])).values()];
  for (const row of out.rows) {
    if (row.status === 'backed' || row.status === 'resolvable') out.ready++;
    else out.needsDecision++;
    if (row.status === 'unresolved') out.unresolved.push(row);
    if (row.status === 'not-a-person') out.notPeople.push(row);
  }
  out.canApply = out.needsDecision === 0;
  return out;
}

/** The canonical table, exactly as schema.sql declares it for new databases. */
export const CANONICAL_NPC_DDL = `CREATE TABLE story_npcs (
  story_id         TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  entity_id        TEXT NOT NULL REFERENCES lore_entities(id) ON DELETE RESTRICT,
  role             TEXT NOT NULL DEFAULT 'background',
  ord              INTEGER NOT NULL DEFAULT 0,
  profile_entry_id TEXT REFERENCES lore_entries(id) ON DELETE SET NULL,
  PRIMARY KEY (story_id, entity_id)
)`;
export const CANONICAL_NPC_INDEXES = ['CREATE INDEX IF NOT EXISTS idx_npc_story ON story_npcs(story_id, role)'];

/**
 * Rebuild the table in its final shape. One transaction; refuses unless clean.
 *
 * @param {object} db
 * @param {object} [o]
 * @param {function} [o.afterCopy]  test hook: runs inside the transaction after
 *                                  rows are copied, before the swap. Throwing
 *                                  here must leave the database untouched.
 * @returns {{ alreadyMigrated?: true, migrated?: number, merged?: number }}
 */
export function applyNpcMigration(db, { afterCopy = null } = {}) {
  const readiness = npcMigrationReadiness(db);
  if (readiness.alreadyMigrated) return { alreadyMigrated: true, migrated: 0, merged: 0 };
  if (readiness.shape === 'missing') return { alreadyMigrated: true, migrated: 0, merged: 0 };
  if (!readiness.canApply) {
    const n = readiness.needsDecision;
    const parts = [
      readiness.unresolved.length && `${readiness.unresolved.length} with nothing saying who they are`,
      readiness.conflicts.length && `${readiness.conflicts.length} where two rows disagree about the same person`,
      readiness.collisions.length && `${readiness.collisions.length} that ${readiness.collisions.length === 1 ? 'is' : 'are'} the person you play`,
      readiness.personaUnverified.length && `${readiness.personaUnverified.length} in a story whose persona has no identity yet, so nobody can prove they are not you`,
      readiness.notPeople.length && `${readiness.notPeople.length} pointing at something that is not a person`,
    ].filter(Boolean);
    throw new NpcMigrationError(`${n} cast ${n === 1 ? 'row needs' : 'rows need'} a decision before the cast can be rebuilt: ${parts.join('; ')}.`);
  }

  // One row per (story, person). Where several old rows fed one, no single
  // entry owns the introduction, so provenance is left empty rather than picked.
  const canonical = new Map();
  for (const row of readiness.rows) {
    const k = `${row.storyId}:${row.resolved.entityId}`;
    const have = canonical.get(k);
    if (!have) {
      canonical.set(k, { story_id: row.storyId, entity_id: row.resolved.entityId, role: row.role, ord: row.ord, profile_entry_id: row.entryId, sources: 1 });
    } else {
      have.ord = Math.min(have.ord, row.ord);
      have.profile_entry_id = null;
      have.sources++;
    }
  }
  const merged = readiness.rows.length - canonical.size;

  const indexes = db.raw.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='story_npcs' AND sql IS NOT NULL").all().map((i) => i.sql);
  db.raw.exec('PRAGMA foreign_keys=OFF');
  try {
    db.raw.exec('BEGIN');
    db.raw.exec(CANONICAL_NPC_DDL.replace('CREATE TABLE story_npcs', 'CREATE TABLE story_npcs_rebuilt'));
    const ins = db.raw.prepare('INSERT INTO story_npcs_rebuilt (story_id, entity_id, role, ord, profile_entry_id) VALUES (?,?,?,?,?)');
    for (const r of canonical.values()) ins.run(r.story_id, r.entity_id, r.role, r.ord, r.profile_entry_id);
    if (afterCopy) afterCopy(db);
    db.raw.exec('DROP TABLE story_npcs');
    db.raw.exec('ALTER TABLE story_npcs_rebuilt RENAME TO story_npcs');
    for (const sql of CANONICAL_NPC_INDEXES) db.raw.exec(sql);
    // Whatever else was indexed on the old table, minus the transitional one
    // that the primary key now makes redundant.
    for (const sql of indexes) {
      if (/idx_npc_entity|idx_npc_story/.test(sql)) continue;
      try { db.raw.exec(sql); } catch { /* an index on a column that is gone */ }
    }
    const broken = db.raw.prepare('PRAGMA foreign_key_check').all();
    if (broken.length) throw new NpcMigrationError(`rebuilding the cast would have orphaned ${broken.length} rows`, 500);
    db.raw.exec('COMMIT');
    // This handle now has the final table; anything holding it must not go on
    // reading the old one through the compatibility layer.
    db.npcShape = 'canonical';
    db.npcMigration = null;
  } catch (e) {
    try { db.raw.exec('ROLLBACK'); } catch { /* already rolled back */ }
    try { db.raw.exec('DROP TABLE IF EXISTS story_npcs_rebuilt'); } catch { /* nothing to drop */ }
    throw e;
  } finally {
    db.raw.exec('PRAGMA foreign_keys=ON');
  }
  return { migrated: canonical.size, merged };
}
