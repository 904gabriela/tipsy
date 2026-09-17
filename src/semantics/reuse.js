// What somebody knows, and which stories know it.
//
// Three scopes already exist in the database, and P10 is about making them
// usable rather than inventing a fourth:
//
//   Core              a few slots on the card or persona
//   reusable          material about a person that travels with them, in
//                     sources whose approved role is entity-material and whose
//                     approved subject is that person, owned by no story
//   this story only   material in that story's own container
//
// A story knows reusable material when it carries the source holding it. That
// is the ordinary attachment every other source uses, and it stays ordinary:
// nothing here searches the library at prompt time, and attaching does not make
// anything always-on. Each entry still fires by its own rules.
//
// Two actions, and both are explicit:
//
//   use in this story     attach the reusable source(s) about that person
//   use across stories    copy one story-specific entry into that person's
//                         reusable knowledge, leaving this story's own version
//                         exactly as it is
//
// The second is a copy, never a move. Two stories may mean different things by
// the same title, and a later edit to somebody's reusable knowledge must not
// quietly rewrite canon in a story that is already being told. So promotion
// changes what future stories CAN use; it changes nothing about this one. When
// this story already carries the reusable source, the new copy is excluded here
// so the same fact cannot arrive twice.
//
// Identity is the entity, never a name: two people called Patrick who were kept
// apart stay apart. A card or persona with no entity has no reusable knowledge
// to offer, and is told so rather than matched by name.
//
// Nothing here asks a provider anything.

import { entityKnowledgeSource, managedSource, createEntityKnowledge, AuthoringError } from './authoring.js';
import { currentEntity } from './store.js';

/** Only an approved role, an approved subject, and no owning story. */
const REUSABLE_WHERE = `ss.status = 'approved'
  AND ss.package_role = 'entity-material'
  AND ss.subject_entity_id = ?
  AND ss.owner_story_id IS NULL`;

/**
 * Every source of reusable material about one person.
 *
 * Managed and imported alike. They are never merged: an old character book and
 * what somebody has written by hand are both about the same person, and each
 * stays where it is, with its own name and its own entries.
 *
 * @returns {Array<{id, name, entries, managed, attached}>}
 */
export function reusableSourcesFor(db, entityId, { storyId = null } = {}) {
  const who = currentEntity(db, entityId);
  if (!who) return [];
  const rows = db.raw.prepare(`SELECT l.id, l.name,
      (SELECT COUNT(*) FROM lore_entries e WHERE e.lorebook_id = l.id) AS entries,
      ${storyId ? '(SELECT COUNT(*) FROM story_lorebooks sl WHERE sl.lorebook_id = l.id AND sl.story_id = ?)' : '0'} AS attached
    FROM source_semantics ss JOIN lorebooks l ON l.id = ss.lorebook_id
    WHERE ${REUSABLE_WHERE}
    ORDER BY l.name`).all(...(storyId ? [storyId, who.id] : [who.id]));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    entries: r.entries,
    managed: managedSource(db, r.id)?.kind === 'entity-knowledge',
    attached: !!r.attached,
  }));
}

/**
 * What a screen needs to say about somebody's reusable knowledge, here.
 *
 * Read-only. Counts entries rather than carrying them: a profile says how much
 * there is and whether this story is using it, and the entries themselves are
 * already read by the profile.
 */
export function reuseState(db, entityId, { storyId = null } = {}) {
  const sources = reusableSourcesFor(db, entityId, { storyId });
  const used = sources.filter((s) => s.attached);
  const spare = sources.filter((s) => !s.attached);
  return {
    entityId: currentEntity(db, entityId)?.id || entityId,
    sources,
    total: sources.length,
    entries: sources.reduce((n, s) => n + s.entries, 0),
    usedHere: used.length,
    entriesUsedHere: used.reduce((n, s) => n + s.entries, 0),
    available: spare.length,
    entriesAvailable: spare.reduce((n, s) => n + s.entries, 0),
    // Nothing to offer is not the same as nothing to say.
    state: !sources.length ? 'none' : !storyId ? 'library' : used.length === sources.length ? 'all' : used.length ? 'some' : 'none-here',
  };
}

/** The candidates an attach would touch, named, before anything is written. */
export function attachPreview(db, entityId, storyId, { sourceIds = null } = {}) {
  const sources = reusableSourcesFor(db, entityId, { storyId })
    .filter((s) => (sourceIds ? sourceIds.includes(s.id) : true));
  return {
    willAttach: sources.filter((s) => !s.attached).map((s) => ({ id: s.id, name: s.name, entries: s.entries, managed: s.managed })),
    alreadyHere: sources.filter((s) => s.attached).map((s) => ({ id: s.id, name: s.name, entries: s.entries, managed: s.managed })),
  };
}

const requireEntity = (db, entityId) => {
  const who = currentEntity(db, entityId);
  if (!who) throw new AuthoringError('That person is not in your library.');
  return who;
};
const requireStory = (db, storyId) => {
  const story = db.raw.prepare('SELECT id, title FROM stories WHERE id=?').get(storyId);
  if (!story) throw new AuthoringError('That story is not in your library.');
  return story;
};

/**
 * Let a story read what somebody knows.
 *
 * Attaching, and nothing else: the source, its entries and how each of them
 * fires are untouched, no card is made, no entity is made, and a source already
 * here is left alone rather than added twice.
 *
 * Only sources whose approved subject is this person are candidates, so asking
 * for somebody else's material by id does nothing.
 */
export function attachReusable(db, { entityId, storyId, sourceIds = null }) {
  const who = requireEntity(db, entityId);
  requireStory(db, storyId);
  const candidates = reusableSourcesFor(db, who.id, { storyId })
    .filter((s) => (sourceIds ? sourceIds.includes(s.id) : true));
  if (!candidates.length) throw new AuthoringError(`There is no reusable knowledge about ${who.canonical_name} to use here.`);
  return db.transaction(() => {
    const attached = [];
    let keptOut = 0;
    for (const s of candidates.filter((x) => !x.attached)) {
      db.raw.prepare('INSERT OR IGNORE INTO story_lorebooks (story_id, lorebook_id) VALUES (?,?)').run(storyId, s.id);
      attached.push({ id: s.id, name: s.name, entries: s.entries });
      // Some of what is arriving may be a copy of something this story already
      // says in its own words — because somebody used it across stories from
      // here, before the story carried their knowledge. The copy knows which
      // entry it was made from, so this needs no guesswork: those copies stay
      // out of this story, and the version written here goes on being the one.
      for (const dup of copiesMadeHere(db, storyId, s.id)) { db.excludeEntry(storyId, dup); keptOut++; }
    }
    return { attached, keptOut, alreadyHere: candidates.filter((x) => x.attached).length, name: who.canonical_name };
  });
}

/**
 * Entries in a source that were copied out of this story's own material.
 *
 * Only the explicit link counts: nothing here compares titles or text.
 */
function copiesMadeHere(db, storyId, lorebookId) {
  return db.raw.prepare(`SELECT copy.id
      FROM lore_entries copy
      JOIN lore_entries origin
        ON origin.id = json_extract(copy.original, '$.${PROMOTION}')
      JOIN source_semantics ss ON ss.lorebook_id = origin.lorebook_id
     WHERE copy.lorebook_id = ?
       AND json_valid(copy.original)
       AND ss.owner_story_id = ?`).all(lorebookId, storyId).map((r) => r.id);
}

/**
 * Stop a story reading what somebody knows.
 *
 * The attachment goes. The source, its entries, what anybody approved about
 * them, the person, their card or persona, this story's own material about
 * them, and every other story's attachment all stay.
 *
 * A source is detached only when its approved subject is this person, so this
 * can never reach past what it was asked about.
 */
export function detachReusable(db, { entityId, storyId, sourceIds = null }) {
  const who = requireEntity(db, entityId);
  const story = requireStory(db, storyId);
  const here = reusableSourcesFor(db, who.id, { storyId })
    .filter((s) => s.attached && (sourceIds ? sourceIds.includes(s.id) : true));
  if (!here.length) throw new AuthoringError(`${story.title} is not using any reusable knowledge about ${who.canonical_name}.`);
  return db.transaction(() => {
    for (const s of here) {
      db.raw.prepare('DELETE FROM story_lorebooks WHERE story_id=? AND lorebook_id=?').run(storyId, s.id);
    }
    // What the story still reads of theirs, so a message about stopping one set
    // cannot claim the story stopped reading all of it.
    const left = reuseState(db, who.id, { storyId });
    return {
      detached: here.map((s) => ({ id: s.id, name: s.name, entries: s.entries })),
      remaining: left.usedHere,
      entriesRemaining: left.entriesUsedHere,
      name: who.canonical_name,
      story: story.title,
    };
  });
}

// ------------------------------------------------------------- promotion

/**
 * Where a reusable copy came from.
 *
 * `lore_entries.original` is the column that already answers "where did this
 * come from" for imported and generated entries, and it is written once and
 * never rewritten by an edit — so a copy keeps saying which story entry it was
 * made from however often either one is edited afterwards. That is what makes
 * pressing the button twice safe, without ever comparing titles or text.
 */
const PROMOTION = 'promotedFrom';

/** The reusable copy already made from this story entry, if there is one. */
export function promotionOf(db, entryId) {
  const row = db.raw.prepare(`SELECT id, lorebook_id FROM lore_entries
    WHERE json_valid(original) AND json_extract(original, '$.${PROMOTION}') = ?`).get(entryId);
  return row ? { entryId: row.id, lorebookId: row.lorebook_id } : null;
}

/** What one entry says, in the shape authoring writes it. */
function readAuthored(db, entryId) {
  const e = db.raw.prepare('SELECT * FROM lore_entries WHERE id=?').get(entryId);
  if (!e) throw new AuthoringError('That entry is no longer there.');
  const sem = db.raw.prepare('SELECT * FROM entry_semantics WHERE entry_id=?').get(entryId);
  if (!sem || sem.status !== 'approved') throw new AuthoringError('Only something you have written and settled can be used across stories.');
  const subject = db.raw.prepare("SELECT entity_id FROM entry_relations WHERE entry_id=? AND relation='subject' AND status='approved'").get(entryId);
  const about = subject?.entity_id || sem.defines_entity_id;
  if (!about) throw new AuthoringError('That entry is not about anyone yet.');
  const related = db.raw.prepare(`SELECT entity_id FROM entry_relations
    WHERE entry_id=? AND relation='related' AND status='approved'`).all(entryId).map((r) => r.entity_id);
  let displayPath = null;
  try { displayPath = sem.display_path ? JSON.parse(sem.display_path) : null; } catch { displayPath = null; }
  const parse = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
  return {
    entry: e,
    about,
    related,
    category: sem.category,
    displayPath,
    // Everything about how it fires, carried across as it stands.
    activation: {
      mode: e.constant ? 'always' : 'keys',
      keys: parse(e.keys),
      secondaryKeys: parse(e.secondary_keys),
      constant: !!e.constant,
      enabled: e.enabled !== 0,
      order: e.ord, probability: e.probability, position: e.position, depth: e.depth,
      selectiveLogic: e.selective_logic,
    },
  };
}

/**
 * What "use across stories" would do, said before it does it.
 *
 * Read-only.
 */
export function promotePreview(db, entryId) {
  const src = readAuthored(db, entryId);
  const managed = managedSource(db, src.entry.lorebook_id);
  const who = requireEntity(db, src.about);
  const already = promotionOf(db, entryId);
  const container = entityKnowledgeSource(db, who.id, { create: false });
  const attachedHere = !!(managed?.kind === 'story-material' && container && db.raw.prepare(
    'SELECT 1 x FROM story_lorebooks WHERE story_id=? AND lorebook_id=?').get(managed.storyId, container));
  return {
    title: src.entry.title,
    about: who.canonical_name,
    scope: managed?.kind === 'story-material' ? 'story' : managed?.kind === 'entity-knowledge' ? 'reusable' : 'imported',
    storyId: managed?.storyId || null,
    already: !!already,
    // The story is carrying their reusable knowledge already, so the copy would
    // otherwise arrive alongside the version written here.
    willExcludeHere: attachedHere,
    creates: already ? null : `${who.canonical_name} — Knowledge`,
  };
}

/**
 * Make a reusable copy of something written for one story.
 *
 * A copy. This story keeps its own version, untouched, and the two are
 * independent from here: editing one never edits the other, and deleting one
 * never deletes the other.
 *
 * Where this story already carries the person's reusable knowledge, the new
 * copy is left out of THIS story so the same thing cannot be said twice. Other
 * stories are unaffected, and nothing is hidden anywhere else.
 */
export function promoteToReusable(db, entryId) {
  const src = readAuthored(db, entryId);
  const managed = managedSource(db, src.entry.lorebook_id);
  if (managed?.kind !== 'story-material') {
    throw new AuthoringError(managed?.kind === 'entity-knowledge'
      ? 'That is already reusable.'
      : 'That came from a source you imported. Reusable knowledge is written on the person, not copied out of a file.');
  }
  const who = requireEntity(db, src.about);
  const storyId = managed.storyId;

  return db.transaction(() => {
    const existing = promotionOf(db, entryId);
    if (existing) {
      return { entryId: existing.entryId, lorebookId: existing.lorebookId, created: false, excludedHere: false, about: who.canonical_name };
    }
    const lorebookId = entityKnowledgeSource(db, who.id);
    const copy = writeReusableCopy(db, { src, entityId: who.id, from: entryId });

    // If this story reads their reusable knowledge, the copy would arrive here
    // as well as the version written for this story. One fact, once: the copy
    // sits out of this story and nowhere else.
    let excludedHere = false;
    const attachedHere = db.raw.prepare('SELECT 1 x FROM story_lorebooks WHERE story_id=? AND lorebook_id=?').get(storyId, lorebookId);
    if (attachedHere) { db.excludeEntry(storyId, copy); excludedHere = true; }
    return { entryId: copy, lorebookId, created: true, excludedHere, about: who.canonical_name };
  });
}

/**
 * The copy itself: the same words, the same meaning, the same triggers.
 *
 * Written through the same path authoring writes, so a promoted entry is an
 * ordinary piece of reusable knowledge afterwards — editable and deletable on
 * the person's profile like anything else written there — and it carries, in
 * the column that already answers that question, which story entry it was made
 * from.
 */
function writeReusableCopy(db, { src, entityId, from }) {
  const { entryId } = createEntityKnowledge(db, {
    entityId,
    title: src.entry.title,
    content: src.entry.content,
    category: src.category,
    displayPath: src.displayPath,
    relatedEntityIds: src.related,
    activation: {
      mode: src.activation.constant ? 'always' : 'keywords',
      keys: src.activation.keys,
      enabled: src.activation.enabled,
      advanced: {
        secondaryKeys: src.activation.secondaryKeys,
        order: src.activation.order,
        probability: src.activation.probability,
        position: src.activation.position,
        depth: src.activation.depth,
        selectiveLogic: src.activation.selectiveLogic,
      },
    },
    provenance: { [PROMOTION]: from },
  });
  return entryId;
}
