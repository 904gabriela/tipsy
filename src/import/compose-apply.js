// Making a reviewed composition real, and taking a source back out.
//
// A draft is suggestions. What arrives here is what somebody looked at and
// agreed to, and it is written all at once or not at all: a story that got
// its source but not its cast, or its cast but not its links, is a story in a
// state nobody chose.
//
// Everything written is a reference. No lore entry is copied or edited, no
// card is created, and nothing here touches messages, memory or story state.

import { personFromEntry, nameFromTitle, normalizeRole, NPC_ROLES, SECTIONS } from './compose.js';
import { personVerdict } from '../semantics/authority.js';
import { semanticViews, resolveNpcEntity, recordLinkEvidence } from '../semantics/store.js';
import { setEntityExclusion, backfillNpcIdentities, entityInventory } from '../semantics/composition.js';

export class CompositionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const unique = (xs) => [...new Set(xs.filter(Boolean))];

/**
 * Check a reviewed composition against what exists, before anything is written.
 *
 * Returns the writes to make. Throws on anything that would put the story in
 * a state the model cannot hold: somebody who is not a person in the cast, a
 * lore-backed lead, two leads, material from a book the story will not read.
 */
export function planComposition(db, {
  storyId = null, existingBookIds = [], lorebookIds = [], casting = [], links = [], recursion = {},
  exclude = [], include = [],
}) {
  const newBooks = unique(lorebookIds).filter((id) => !existingBookIds.includes(id));
  for (const id of newBooks) {
    if (!db.getLorebook(id)) throw new CompositionError('One of those sources is no longer in the library.', 404);
  }
  const books = unique([...existingBookIds, ...newBooks]);
  const pool = new Map();
  for (const id of books) for (const e of db.listEntries(id)) pool.set(e.id, e);

  const npcs = [];       // { entryId, role } to set
  const drop = [];       // entryIds to take out of the cast
  const cards = [];      // { characterId, role } — new stories only
  const excludes = [];   // entryIds this story will ignore
  const includes = [];   // entryIds this story stops ignoring
  const entityExcludes = []; // people excluded from this story as people
  const entityIncludes = []; // people let back in the same way
  const seen = new Set();

  // The person the reader plays. The draft never offers them as cast; this is
  // the same rule where it cannot be routed around — by an older client, or by
  // a request made by hand. Being written about is not being cast.
  const personaEntityId = (() => {
    if (!storyId) return null;
    const story = db.getStory(storyId);
    return story?.persona_id ? db.getPersona(story.persona_id)?.entity_id || null : null;
  })();

  // Every entry that describes one person. A person described in two entries
  // is excluded, or let back in, as one person.
  const idsOf = (raw, primary) => {
    const ids = unique([primary, ...(Array.isArray(raw.entryIds) ? raw.entryIds : [])]);
    for (const id of ids) {
      if (!pool.has(id)) throw new CompositionError('Somebody in that cast comes from a source this story is not using.');
    }
    return ids;
  };

  for (const raw of casting) {
    const role = normalizeRole(raw.role);
    if (!role) throw new CompositionError(`"${raw.role}" is not a part somebody can have.`);

    if (raw.characterId) {
      if (seen.has(`c:${raw.characterId}`)) continue;
      seen.add(`c:${raw.characterId}`);
      if (!db.getCharacter(raw.characterId)) throw new CompositionError('One of those characters is no longer in the library.', 404);
      cards.push({ characterId: raw.characterId, role });
      // A card left out of a new story takes the entries about the same
      // person with it, if the person chose to exclude them.
      const ids = Array.isArray(raw.entryIds) ? idsOf(raw, null) : [];
      if (role === 'excluded') excludes.push(...ids);
      else includes.push(...ids);
      continue;
    }

    const entry = pool.get(raw.entryId);
    if (!entry) throw new CompositionError('Somebody in that cast comes from a source this story is not using.');
    if (seen.has(`e:${entry.id}`)) continue;
    seen.add(`e:${entry.id}`);
    const ids = idsOf(raw, entry.id);

    // Known: in the story's knowledge, not its cast, and eligible as normal.
    // Excluded: not in the cast and not eligible at all, in this story only.
    // A person with an approved identity is excluded AS that person — one
    // decision about who they are, not a pile of decisions about entries —
    // and let back in the same way.
    const identity = semanticViews(db, [entry]).get(entry.id);
    const personEntity = identity?.authoritative && identity.defines?.type === 'person' ? identity.defines.id : null;
    if (role === 'known') {
      drop.push(...ids); includes.push(...ids);
      if (personEntity) entityIncludes.push(personEntity);
      continue;
    }
    if (role === 'excluded') {
      drop.push(...ids);
      if (personEntity) entityExcludes.push(personEntity);
      else excludes.push(...ids);
      continue;
    }
    if (personEntity && personEntity === personaEntityId) {
      throw new CompositionError(`${entry.title} is you in this story. Your persona is yours to play, so they cannot also be a part the story performs. Change your persona first if you meant somebody else.`);
    }
    includes.push(...ids);
    if (personEntity) entityIncludes.push(personEntity);

    // Checked here and not only in the draft, so nothing that calls this can
    // put "Vancetti Family" in the cast however the request was made. Approved
    // semantics decide first; the legacy reading only where there are none.
    const verdict = personVerdict(entry, identity, personFromEntry);
    if (!verdict.person) {
      throw new CompositionError(`"${entry.title}" is not a person, so it cannot be in the cast. It stays in the story's material.`);
    }
    if (role === 'lead') {
      throw new CompositionError(`${verdict.name} has no character card, and a lead needs one. Make them a character first, or pick a lead who has a card.`);
    }
    if (!NPC_ROLES.includes(role)) throw new CompositionError(`"${role}" is not a part somebody can have.`);
    npcs.push({ entryId: entry.id, role });
  }

  const leads = cards.filter((c) => c.role === 'lead');
  if (leads.length > 1) throw new CompositionError('A story has one lead. Choose which of them it is.');

  const linkWrites = [];
  for (const l of links) {
    if (!pool.has(l.entryId)) throw new CompositionError('A link points at material this story is not using.');
    if (l.characterId) {
      if (!db.getCharacter(l.characterId)) throw new CompositionError('A link points at a character that is no longer in the library.', 404);
      linkWrites.push({ entryId: l.entryId, characterId: l.characterId });
    } else if (l.aboutId) {
      if (!pool.has(l.aboutId)) throw new CompositionError('A link points at material this story is not using.');
      if (l.aboutId !== l.entryId) linkWrites.push({ entryId: l.entryId, aboutId: l.aboutId });
    }
  }

  // Any material at all can be excluded, not only people: an event that never
  // happened here, a rule that does not apply.
  for (const id of exclude) {
    if (!pool.has(id)) throw new CompositionError('That material is not part of a source this story is using.');
    excludes.push(id);
  }
  for (const id of include) {
    if (!pool.has(id)) throw new CompositionError('That material is not part of a source this story is using.');
    includes.push(id);
  }
  const excluded = new Set(excludes);
  if (includes.some((id) => excluded.has(id))) {
    throw new CompositionError('The same material cannot be both excluded and kept in one change.');
  }

  const policies = {};
  for (const id of newBooks) if (recursion && recursion[id] === 'block') policies[id] = 'block';

  return {
    storyId, newBooks, policies, npcs, drop, cards, leads, links: linkWrites,
    excludes: unique(excludes), includes: unique(includes),
    entityExcludes: unique(entityExcludes), entityIncludes: unique(entityIncludes),
  };
}

/**
 * Write a checked plan. Call inside db.transaction.
 *
 * Books already connected keep how this story uses them; only new ones are
 * added, with a recursion policy only if one was chosen for them.
 */
export function writeComposition(db, storyId, plan) {
  for (const id of plan.newBooks) {
    db.raw.prepare(`INSERT OR IGNORE INTO story_lorebooks (story_id,lorebook_id) VALUES (?,?)`).run(storyId, id);
    if (plan.policies[id]) db.setStoryLorebookRecursion(storyId, id, plan.policies[id]);
  }
  // The person each cast member IS, only where that is certain. Otherwise NULL.
  for (const n of plan.npcs) db.setStoryNpc(storyId, n.entryId, n.role, resolveNpcEntity(db, n.entryId));
  // And the same certainty, given to cast rows from before there were
  // identities to give: deterministic, or left NULL exactly as it was.
  backfillNpcIdentities(db, storyId, { resolve: resolveNpcEntity });
  for (const id of plan.drop) db.removeStoryNpc(storyId, id);
  // People excluded as people, and let back in as people. Reversible, this
  // story only, and never a rewrite of anyone's entry-level decisions.
  for (const entityId of plan.entityExcludes || []) setEntityExclusion(db, { storyId, entityId, excluded: true });
  for (const entityId of plan.entityIncludes || []) setEntityExclusion(db, { storyId, entityId, excluded: false });
  for (const id of plan.includes || []) db.includeEntry(storyId, id);
  for (const id of plan.excludes || []) {
    // Ignored material is not in the cast either, however it got there.
    db.removeStoryNpc(storyId, id);
    db.excludeEntry(storyId, id);
  }
  // Links ticked in review were suggestions a person left ticked, not decisions
  // about what an entry is about. They are kept as evidence for later
  // organisation and never written as semantics.
  for (const l of plan.links) {
    recordLinkEvidence(db, { source: 'composition-review', entryId: l.entryId, characterId: l.characterId || null, aboutId: l.aboutId || null });
  }
}

/**
 * Apply a reviewed composition to a story that already exists.
 *
 * Cards already in the story are left exactly as they are: adding a source
 * does not recast the story. Everything else goes in one transaction.
 */
export function applyToStory(db, storyId, body) {
  const story = db.getStory(storyId);
  if (!story) throw new CompositionError('No such story.', 404);
  return db.transaction(() => {
    const plan = planComposition(db, { ...body, storyId, existingBookIds: story.lorebookIds, casting: (body.casting || []).filter((c) => !c.characterId) });
    writeComposition(db, storyId, plan);
    const after = db.getStory(storyId);
    return {
      sources: after.lorebookIds.length,
      added: plan.newBooks.length,
      cast: after.characters.length,
      npcs: db.storyNpcs(storyId).length,
      excluded: db.storyExclusions(storyId).length,
      links: plan.links.length,
    };
  });
}

/**
 * What a story would lose if a source were taken out of it.
 *
 * Counted from the same reading the review uses, so the numbers match what
 * the person saw when they added it.
 */
export function sourceRemovalPreview(db, storyId, lorebookId, compose) {
  const story = db.getStory(storyId);
  if (!story) throw new CompositionError('No such story.', 404);
  if (!story.lorebookIds.includes(lorebookId)) throw new CompositionError('That source is not part of this story.', 404);
  const book = db.getLorebook(lorebookId);
  const draft = compose(book.entries, { characters: [], storyCards: story.characters });
  const ids = new Set(book.entries.map((e) => e.id));
  const cast = db.storyNpcs(storyId).filter((n) => ids.has(n.entry_id));
  const exclusions = db.storyExclusions(storyId).filter((x) => ids.has(x.entry_id));
  const policy = db.storyLorebookSettings(storyId).find((r) => r.lorebook_id === lorebookId)?.recursion || null;
  const personaFrom = story.persona && story.persona.from_entry && ids.has(story.persona.from_entry) ? story.persona.name : null;

  // Who leaves with this source, and who stays because another attached source
  // still carries them. Nothing global changes either way: the person, their
  // cards and their material elsewhere are untouched.
  const remaining = story.lorebookIds.filter((id) => id !== lorebookId);
  const here = entityInventory(db, [lorebookId]);
  const still = new Set(entityInventory(db, remaining).map((x) => x.id));
  const entitiesLeaving = here.filter((x) => !still.has(x.id))
    .map((x) => ({ id: x.id, name: x.name, type: x.type }));
  const entitiesStaying = here.filter((x) => still.has(x.id))
    .map((x) => ({ id: x.id, name: x.name, type: x.type }));

  return {
    entitiesLeaving,
    entitiesStaying,
    source: { id: book.id, name: book.name, entries: book.entries.length },
    loses: [
      { id: 'people', label: 'People written about in it', count: draft.casting.filter((r) => r.backing === 'lore').length },
      ...draft.sections.filter((s) => s.count).map((s) => ({ id: s.id, label: SECTIONS.find((x) => x.id === s.id)?.label || s.label, count: s.count })),
    ],
    castLeaving: cast.map((n) => ({ entryId: n.entry_id, name: nameFromTitle(n.title).name || n.title, role: n.role })),
    // Choices this story made about the source's material. They mean nothing
    // once the story no longer reads it, so they go with it.
    exclusionsForgotten: exclusions.map((x) => ({ entryId: x.entry_id, name: nameFromTitle(x.title).name || x.title })),
    recursion: policy,
    personaFrom,
    keeps: [
      'the source itself, in your Library',
      'every lore entry in it, unchanged',
      'character cards',
      'every message in the story',
      'what each entry is about',
    ],
  };
}

/**
 * Take a source out of a story.
 *
 * Removes the story's connection to the book and the cast memberships that
 * stand on the book's entries — those people have nothing to stand on once
 * the book is gone, and the preview names each one first.
 *
 * Kept: the book, its entries, every card, every message, and the links
 * saying what an entry is about. Those links describe the material, not this
 * story, and another story may be using the same book.
 */
export function removeSource(db, storyId, lorebookId) {
  const story = db.getStory(storyId);
  if (!story) throw new CompositionError('No such story.', 404);
  if (!story.lorebookIds.includes(lorebookId)) throw new CompositionError('That source is not part of this story.', 404);
  return db.transaction(() => {
    const ids = new Set(db.listEntries(lorebookId).map((e) => e.id));
    const leaving = db.storyNpcs(storyId).filter((n) => ids.has(n.entry_id));
    for (const n of leaving) db.removeStoryNpc(storyId, n.entry_id);
    const forgotten = db.storyExclusions(storyId).filter((x) => ids.has(x.entry_id));
    for (const x of forgotten) db.includeEntry(storyId, x.entry_id);
    db.raw.prepare(`DELETE FROM story_lorebooks WHERE story_id=? AND lorebook_id=?`).run(storyId, lorebookId);
    return { removed: lorebookId, castLeft: leaving.length, exclusionsForgotten: forgotten.length };
  });
}
