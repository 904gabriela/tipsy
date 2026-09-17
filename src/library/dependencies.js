// What would break if this left the library.
//
// Cleaning a library is only safe if "unused" is a promise rather than a guess.
// So the rule here is deliberately timid: a thing is unused only when removing
// it would change no story and no other first-class resource, and anything this
// module is unsure about is called used. Being wrong in that direction costs a
// person one row of clutter. Being wrong in the other costs them a story.
//
// Three kinds of reason keep something:
//
//   in use      a story, world or scenario points at it
//   managed     Nexus writes into it on somebody's behalf: a story's own
//               material, or the reusable knowledge about a person
//   provenance  it merely remembers where something came from — and that is
//               NOT a reason to keep anything. Provenance is detached, never
//               obeyed.
//
// Nothing here writes. Nothing here asks a provider anything.

import { managedSource } from '../semantics/authoring.js';

export const KINDS = ['character', 'source', 'scenario', 'world'];

const TABLE = { character: 'characters', source: 'lorebooks', scenario: 'scenarios', world: 'frameworks' };
const key = (kind, id) => `${kind}:${id}`;

/** "The Saint", "The Saint and 2 others" — never a bare count with no name. */
function named(list, max = 2) {
  const names = list.map((s) => s.title || s.name).filter(Boolean);
  if (!names.length) return '';
  if (names.length <= max) return names.join(' and ');
  return `${names.slice(0, max).join(', ')} and ${names.length - max} other${names.length - max === 1 ? '' : 's'}`;
}

/**
 * Everything the library knows about what depends on what.
 *
 * Read once, in bulk, so a shelf of two hundred things costs one pass rather
 * than two hundred queries.
 */
function survey(db) {
  const q = (sql, ...a) => db.raw.prepare(sql).all(...a);
  const stories = new Map(q('SELECT id, title FROM stories').map((s) => [s.id, s]));
  return {
    stories,
    storyBooks: q('SELECT story_id, lorebook_id FROM story_lorebooks'),
    storyCards: q('SELECT story_id, character_id FROM story_characters'),
    entityCards: q('SELECT story_id, character_id, entity_id FROM story_entity_cards'),
    resourceBooks: q('SELECT owner_kind, owner_id, lorebook_id FROM resource_lorebooks'),
    storyWorlds: q('SELECT id, title, framework_id, scenario_id FROM stories WHERE framework_id IS NOT NULL OR scenario_id IS NOT NULL'),
    scenarioWorlds: q('SELECT id, name, framework_id FROM scenarios WHERE framework_id IS NOT NULL'),
    ownedBooks: q("SELECT lorebook_id, owner_story_id FROM source_semantics WHERE owner_story_id IS NOT NULL"),
    npcBooks: q(`SELECT DISTINCT n.story_id, e.lorebook_id FROM story_npcs n JOIN lore_entries e ON e.id = n.entry_id`),
    entities: new Map(q('SELECT id, canonical_name FROM lore_entities').map((e) => [e.id, e.canonical_name])),
    entryCounts: new Map(q('SELECT lorebook_id, COUNT(*) n FROM lore_entries GROUP BY lorebook_id').map((r) => [r.lorebook_id, r.n])),
    provenanceBooks: q('SELECT id, name, from_character FROM lorebooks WHERE from_character IS NOT NULL'),
  };
}

/**
 * One resource, and every reason it cannot simply go.
 *
 * @returns {{ kind, id, name, used, protected, reasons: string[], stories: object[], detaches: string[] }}
 */
function examine(db, kind, id, s) {
  const row = db.raw.prepare(`SELECT * FROM ${TABLE[kind]} WHERE id=?`).get(id);
  if (!row) return null;
  const out = {
    kind, id, name: row.name || row.title || 'Untitled',
    used: false, protected: false, reasons: [], stories: [], detaches: [],
  };
  const storiesOf = (ids) => [...new Set(ids)].map((x) => s.stories.get(x)).filter(Boolean);
  /**
   * One reason to keep it. `from` names another library resource the reason
   * stands on: deleting a world and the source inside it together is one
   * decision, so a reason that points at something also being deleted stops
   * counting. A reason that points at a story never does — stories are not
   * being deleted here, and P9 never changes one to make room.
   */
  const keep = (text, stories = [], from = null) => {
    out.used = true;
    if (text && !out.reasons.some((r) => r.text === text)) out.reasons.push({ text, from });
    for (const st of stories) if (!out.stories.some((x) => x.id === st.id)) out.stories.push(st);
  };

  if (kind === 'character') {
    const cast = storiesOf(s.storyCards.filter((r) => r.character_id === id).map((r) => r.story_id));
    if (cast.length) keep(`In the cast of ${named(cast)}`, cast);
    // A card chosen to stand for somebody in a story. The database refuses to
    // delete this one outright, so it must be caught before anything is tried.
    for (const b of s.entityCards.filter((r) => r.character_id === id)) {
      const st = s.stories.get(b.story_id);
      const who = s.entities.get(b.entity_id) || 'somebody';
      keep(`Chosen as the card for ${who} in ${st?.title || 'a story'}`, st ? [st] : []);
    }
    // What arrived with them stays behind, and says so.
    for (const b of s.provenanceBooks.filter((b) => b.from_character === id)) {
      out.detaches.push(`${b.name} came in with them and stays in your library`);
    }
  }

  if (kind === 'source') {
    const attached = storiesOf(s.storyBooks.filter((r) => r.lorebook_id === id).map((r) => r.story_id));
    if (attached.length) keep(`Used by ${named(attached)}`, attached);
    const cast = storiesOf(s.npcBooks.filter((r) => r.lorebook_id === id).map((r) => r.story_id));
    if (cast.length) keep(`Somebody in ${named(cast)} is written in it`, cast);
    for (const r of s.resourceBooks.filter((r) => r.lorebook_id === id)) {
      const owner = db.raw.prepare(`SELECT name FROM ${r.owner_kind === 'framework' ? 'frameworks' : 'scenarios'} WHERE id=?`).get(r.owner_id);
      if (owner) {
        keep(`Part of the ${r.owner_kind === 'framework' ? 'world' : 'scenario'} ${owner.name}`, [],
          { kind: r.owner_kind === 'framework' ? 'world' : 'scenario', id: r.owner_id });
      }
    }
    // Managed containers. A story's own material belongs to a story that still
    // exists; reusable knowledge belongs to a person, and belongs to them
    // whether or not any story is carrying it today.
    const managed = managedSource(db, id);
    const owned = s.ownedBooks.find((r) => r.lorebook_id === id && s.stories.has(r.owner_story_id));
    const legacy = (() => {
      try { return JSON.parse(row.original || '{}').generatedFor || null; } catch { return null; }
    })();
    const ownerStory = s.stories.get(managed?.storyId) || s.stories.get(owned?.owner_story_id) || s.stories.get(legacy);
    if (ownerStory) {
      out.protected = true;
      keep(`The story material for ${ownerStory.title}`, [ownerStory]);
    } else if (managed?.kind === 'entity-knowledge' && (s.entryCounts.get(id) || 0) > 0) {
      // Written by hand about a person. No story is carrying it today; that is
      // not a reason to throw away what somebody wrote.
      out.protected = true;
      keep(`Knowledge you wrote about ${s.entities.get(managed.entityId) || 'somebody'}`);
    }
  }

  if (kind === 'scenario') {
    const used = s.storyWorlds.filter((r) => r.scenario_id === id);
    if (used.length) keep(`Started ${named(used)}`, storiesOf(used.map((r) => r.id)));
  }

  if (kind === 'world') {
    const used = s.storyWorlds.filter((r) => r.framework_id === id);
    if (used.length) keep(`Used by ${named(used)}`, storiesOf(used.map((r) => r.id)));
    for (const sc of s.scenarioWorlds.filter((r) => r.framework_id === id)) {
      keep(`The world behind ${sc.name}`, [], { kind: 'scenario', id: sc.id });
    }
  }

  return out;
}

/**
 * Analyse a selection, or the whole library.
 *
 * @param {object} db
 * @param {Array<{kind:string,id:string}>|null} selection  null means everything
 * @returns {Map<string, object>} keyed "kind:id"
 */
export function analyzeLibraryDependencies(db, selection = null) {
  const s = survey(db);
  const wanted = selection || KINDS.flatMap((kind) =>
    db.raw.prepare(`SELECT id FROM ${TABLE[kind]}`).all().map((r) => ({ kind, id: r.id })));
  const out = new Map();
  for (const { kind, id } of wanted) {
    if (!TABLE[kind]) continue;
    const found = examine(db, kind, id, s);
    if (found) out.set(key(kind, id), found);
  }
  return out;
}

/**
 * What could go today, on one shelf.
 *
 * Conservative by construction: it asks the same question Review asks, and
 * takes only the answers that came back clean.
 */
export function unusedResources(db, kind) {
  const all = analyzeLibraryDependencies(db, null);
  return [...all.values()].filter((r) => r.kind === kind && !r.used && !r.protected);
}

export { key as dependencyKey };
